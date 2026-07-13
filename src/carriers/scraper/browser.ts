import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from '../../config.js';

// Shared Chromium for scraping, launched on first use. Stealth-hardened to get
// past basic bot protection. For tough WAFs (USPS/UPS use Akamai) the most
// effective option is BROWSER_CDP_URL pointing at a real external Chrome.

chromium.use(StealthPlugin());

let browserPromise: Promise<Browser> | null = null;

// ---- Scrape queue ----------------------------------------------------------
// Every piece of browser work (scheduler refreshes, manual refreshes, first
// fetches, module tests) funnels through one slot, so concurrent requests
// queue instead of stacking Chromium contexts and spiking memory. A second
// slot opens only when the queue is genuinely backed up. Once the queue
// drains, an idle timer closes Chromium entirely so its memory is returned
// between refresh ticks.

const SECOND_SLOT_BACKLOG = 4; // queued jobs before a second slot opens
let activeScrapes = 0;
const scrapeQueue: Array<() => void> = [];
let idleCloseTimer: NodeJS.Timeout | null = null;

function scrapeSlots(): number {
  return scrapeQueue.length >= SECOND_SLOT_BACKLOG ? 2 : 1;
}

function cancelIdleClose(): void {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
}

function scheduleIdleClose(): void {
  cancelIdleClose();
  const minutes = config.scraper.idleCloseMinutes;
  if (minutes <= 0) return;
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (activeScrapes === 0 && scrapeQueue.length === 0) void closeBrowser();
  }, minutes * 60_000);
  idleCloseTimer.unref?.();
}

async function withScrapeSlot<T>(job: () => Promise<T>): Promise<T> {
  cancelIdleClose();
  if (activeScrapes >= scrapeSlots()) {
    // The releaser reserves our slot (bumps activeScrapes) before waking us,
    // so a caller arriving in between can't overshoot the limit.
    await new Promise<void>((resolve) => scrapeQueue.push(resolve));
  } else {
    activeScrapes++;
  }
  try {
    return await job();
  } finally {
    activeScrapes--;
    if (scrapeQueue.length > 0 && activeScrapes < scrapeSlots()) {
      activeScrapes++;
      scrapeQueue.shift()!();
    } else if (activeScrapes === 0 && scrapeQueue.length === 0) {
      scheduleIdleClose();
    }
  }
}

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Deliberately no extraHTTPHeaders: new-headless Chrome already sends client
// hints matching its real version. Overriding them (Accept, sec-ch-ua) leaks
// onto XHR and the WAF's own beacons, which got every UPS request Akamai-blocked.

// GPU/ANGLE flags make the WebGL/canvas fingerprint look like a real machine.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--use-angle=default',
  '--enable-accelerated-2d-canvas',
];

async function launch(): Promise<Browser> {
  if (config.scraper.cdpUrl) {
    // Connect to an external real Chrome (browserless, chrome --remote-debugging).
    return (await chromium.connectOverCDP(config.scraper.cdpUrl)) as unknown as Browser;
  }
  // --headless=new is a real browser with no display: it clears Akamai (UPS/USPS)
  // where legacy headless is instantly flagged, and still runs on a headless
  // server (unlike true headful). BROWSER_HEADFUL forces a real window instead.
  const args = [...LAUNCH_ARGS];
  if (!config.scraper.headful) args.push('--headless=new');
  return (await chromium.launch({
    headless: false,
    executablePath: config.scraper.executablePath || undefined,
    args,
  })) as unknown as Browser;
}

export async function getBrowser(): Promise<Browser> {
  if (!config.scraper.browserFallback) {
    throw new Error('Browser fallback is disabled (SCRAPER_BROWSER_FALLBACK=false)');
  }
  if (!browserPromise) {
    const p = launch()
      .then((browser) => {
        // If Chromium crashes or is closed out from under us, forget it so the
        // next scrape relaunches instead of failing against a dead browser.
        browser.on('disconnected', () => {
          if (browserPromise === p) browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        if (browserPromise === p) browserPromise = null; // allow retry on next call
        throw err;
      });
    browserPromise = p;
  }
  return browserPromise;
}

export interface RenderResult {
  html: string;
  /** Serialized cookies/storage to persist and replay (keeps Akamai clearance). */
  storageState: string;
}

export interface RenderOptions {
  waitFor?: string;
  timeoutMs?: number;
  guard?: (target: string) => Promise<void>;
  /** Visit this first (e.g. the carrier landing page) to pick up cookies. */
  warmupUrl?: string;
  /** Previously persisted storageState JSON to start from. */
  storageState?: string;
}

/** Render a URL in the stealth browser and return its HTML + updated session. */
export async function fetchRenderedHtml(
  url: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  if (opts.guard) {
    await opts.guard(url);
    if (opts.warmupUrl) await opts.guard(opts.warmupUrl);
  }
  return withScrapeSlot(() => renderHtml(url, opts));
}

async function renderHtml(url: string, opts: RenderOptions): Promise<RenderResult> {
  const timeout = opts.timeoutMs ?? 30_000;
  const browser = await getBrowser();

  let parsedState: object | undefined;
  if (opts.storageState) {
    try {
      parsedState = JSON.parse(opts.storageState);
    } catch {
      /* ignore a corrupt saved state */
    }
  }

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 900 },
    storageState: parsedState as any,
  });

  if (opts.guard) {
    await context.route('**/*', async (route) => {
      try {
        await opts.guard!(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
  }

  const page = await context.newPage();
  try {
    if (opts.warmupUrl) {
      await page.goto(opts.warmupUrl, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout }).catch(() => {
        // Selector never appeared; return whatever rendered for best-effort parse.
      });
    }
    const html = await page.content();
    const storageState = JSON.stringify(await saveState(context));
    return { html, storageState };
  } finally {
    await context.close();
  }
}

export interface BrowserApiResult {
  body: string;
  storageState: string;
}

export interface BrowserApiOptions {
  method?: string;
  body?: string;
  contentType?: string;
  /** Read this cookie after warmup and echo it into `tokenHeader`. */
  tokenCookie?: string;
  tokenHeader?: string;
  /** Page to load first, to earn WAF clearance + any token cookie. */
  warmupUrl?: string;
  timeoutMs?: number;
  storageState?: string;
  guard?: (target: string) => Promise<void>;
}

/**
 * Warm up a carrier's site in the stealth browser, then run a JSON `fetch` from
 * inside that page. This clears Akamai-style WAFs (the request rides the real
 * browser's TLS/JA3 + clearance cookie) and lets us echo an anti-CSRF token from
 * a cookie into a header. Returns the raw response body + refreshed session.
 */
export async function fetchJsonViaBrowser(
  url: string,
  opts: BrowserApiOptions = {},
): Promise<BrowserApiResult> {
  // Validate the two module-controlled URLs up front. We deliberately do NOT
  // install a per-request context.route() guard here (as the HTML path does):
  // intercepting every subresource breaks the bot-detection sensor's telemetry
  // and mangles the API call's CORS preflight, so Akamai never grants clearance.
  // The only attacker-influenced URLs are `url` and `warmupUrl`, both checked here.
  if (opts.guard) {
    await opts.guard(url);
    if (opts.warmupUrl) await opts.guard(opts.warmupUrl);
  }
  return withScrapeSlot(() => browserApiCall(url, opts));
}

async function browserApiCall(url: string, opts: BrowserApiOptions): Promise<BrowserApiResult> {
  const timeout = opts.timeoutMs ?? 30_000;
  const browser = await getBrowser();

  let parsedState: object | undefined;
  if (opts.storageState) {
    try {
      parsedState = JSON.parse(opts.storageState);
    } catch {
      /* ignore a corrupt saved state */
    }
  }

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 900 },
    storageState: parsedState as any,
  });

  const page = await context.newPage();
  try {
    // Land on the carrier page first so the WAF clearance + token cookies are
    // set for this origin before we call its API.
    const landing = opts.warmupUrl ?? new URL(url).origin;
    await page.goto(landing, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    // A little human-like activity + settle time lets the bot-detection sensor
    // (Akamai) collect telemetry and grant clearance before we hit the API.
    await humanize(page);

    let token = '';
    if (opts.tokenCookie) {
      const cookies = await context.cookies();
      token = cookies.find((c) => c.name === opts.tokenCookie)?.value ?? '';
    }

    const body = await page.evaluate(
      async (a: {
        url: string;
        method: string;
        body?: string;
        contentType: string;
        tokenHeader?: string;
        token: string;
      }) => {
        const headers: Record<string, string> = { 'Content-Type': a.contentType };
        if (a.tokenHeader && a.token) headers[a.tokenHeader] = a.token;
        const res = await fetch(a.url, {
          method: a.method,
          headers,
          body: a.body,
          credentials: 'include',
        });
        return await res.text();
      },
      {
        url,
        method: opts.method ?? 'POST',
        body: opts.body,
        contentType: opts.contentType ?? 'application/json',
        tokenHeader: opts.tokenHeader,
        token,
      },
    );

    const storageState = JSON.stringify(await saveState(context));
    return { body, storageState };
  } finally {
    await context.close();
  }
}

export interface CaptureOptions {
  /** Regex source tested against every response URL while the page loads. */
  urlPattern: string;
  timeoutMs?: number;
  guard?: (target: string) => Promise<void>;
}

/**
 * Render a page in a FRESH context and capture the body of the first API
 * response whose URL matches `urlPattern`. For carriers whose API refuses
 * requests we make ourselves (even from inside the page) but is called by the
 * page's own bootstrap code with credentials we can't replicate - FedEx's
 * track/v2 only hands CORS headers to its own call.
 *
 * Deliberately no session replay: replayed FedEx cookies make the app serve
 * cached results and skip the very network call we're here to capture, and the
 * page clears the WAF fine from cold. As with fetchJsonViaBrowser, no
 * per-request route guard either: interception breaks the bot-sensor
 * telemetry, and the only module-controlled URL is the page URL, checked here.
 */
export async function captureJsonFromPage(
  pageUrl: string,
  opts: CaptureOptions,
): Promise<{ body: string }> {
  if (opts.guard) await opts.guard(pageUrl);
  return withScrapeSlot(() => captureCall(pageUrl, opts));
}

async function captureCall(pageUrl: string, opts: CaptureOptions): Promise<{ body: string }> {
  const timeout = opts.timeoutMs ?? 30_000;
  const re = new RegExp(opts.urlPattern, 'i');
  const browser = await getBrowser();

  // The API response lands ~2-3s after navigation when Akamai trusts the
  // session; when it doesn't, it CORS-kills the page's own call (net::ERR_FAILED)
  // and the SPA bails to an error page. That scoring is intermittent and, once
  // a context is poisoned, reloading it never recovers - only a brand-new
  // context has a fresh shot. So each attempt below is a throwaway context; we
  // keep spinning up fresh ones until one succeeds or the budget runs out.
  const started = Date.now();
  const budgetLeft = (): number => timeout - (Date.now() - started);
  const PER_ATTEMPT_MS = 14_000; // cold success ~3s; abandon a poisoned context fast
  let lastMisses: string[] = [];
  let lastState = '';

  while (budgetLeft() > 6_000) {
    const attempt = await captureAttempt(browser, pageUrl, re, Math.min(PER_ATTEMPT_MS, budgetLeft()));
    if (attempt.body !== null) return { body: attempt.body };
    lastMisses = attempt.misses;
    lastState = attempt.state;
  }

  const saw = lastMisses.length ? ` (saw: ${lastMisses.join(', ')})` : '';
  throw new Error(
    `No successful response matching ${opts.urlPattern} within ${timeout}ms${saw}${lastState}`,
  );
}

// One throwaway-context capture attempt. Returns the matched body, or null plus
// diagnostics (what failed responses/requests it saw, and a page snapshot).
async function captureAttempt(
  browser: Browser,
  pageUrl: string,
  re: RegExp,
  perAttemptMs: number,
): Promise<{ body: string | null; misses: string[]; state: string }> {
  // Deliberately NO userAgent override: the stealth plugin already de-headlesses
  // the real UA so it matches the sec-ch-ua client hints (platform included).
  // Forcing a Windows UA on a Linux container is a UA-vs-hints contradiction
  // FedEx's gateway scores hard enough to CORS-kill the page's own API call.
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  try {
    let settle: (body: string) => void;
    const matched = new Promise<string>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const misses: string[] = [];
    page.on('response', (res) => {
      if (done || !re.test(res.url())) return;
      const method = res.request().method();
      if (method === 'OPTIONS' || method === 'HEAD') return; // CORS preflight noise
      if (res.status() < 200 || res.status() >= 300) {
        misses.push(`HTTP ${res.status()}`);
        return;
      }
      // The first successful response wins; read its body before the page moves on.
      res
        .text()
        .then((text) => {
          if (done) return;
          if (!text) {
            misses.push('empty body');
            return;
          }
          done = true;
          settle(text);
        })
        .catch(() => {
          misses.push('unreadable body');
        });
    });
    // A request that got no response at all (DNS block, connection reset, CORS
    // kill) - names the network error, e.g. "net::ERR_FAILED" for a CORS kill.
    page.on('requestfailed', (req) => {
      if (done || !re.test(req.url())) return;
      misses.push(req.failure()?.errorText ?? 'request failed');
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: perAttemptMs }).catch(() => {
      // The API call often lands before/without full navigation success.
    });

    const body = await Promise.race([
      matched,
      page
        .waitForTimeout(perAttemptMs)
        .then(() => null)
        .catch(() => null),
    ]);

    const state = body === null ? await describePage(page) : '';
    return { body, misses, state };
  } finally {
    await context.close();
  }
}

// Summarize what a page is currently showing, for capture-failure diagnostics.
async function describePage(page: import('playwright').Page): Promise<string> {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const text = await page
      .evaluate(() => {
        const doc = (globalThis as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText?.replace(/\s+/g, ' ').slice(0, 160) ?? '';
      })
      .catch(() => '');
    return ` [page: ${url} | title: "${title}" | text: "${text}"]`;
  } catch {
    return '';
  }
}

const rnd = (min: number, max: number): number => min + Math.random() * (max - min);

// Nudge the mouse/scroll a few times and settle, so a bot-detection sensor sees
// human-like interaction telemetry before we make the tracking request. Timing,
// positions, and step counts are randomized so the motion doesn't form a
// fixed, fingerprintable pattern across runs.
async function humanize(page: import('playwright').Page): Promise<void> {
  try {
    const moves = 3 + Math.floor(rnd(0, 4));
    for (let i = 0; i < moves; i++) {
      await page.mouse.move(rnd(80, 1200), rnd(100, 720), { steps: Math.floor(rnd(4, 16)) });
      await page.mouse.wheel(0, rnd(90, 400));
      await page.waitForTimeout(rnd(350, 1100));
    }
  } catch {
    /* interaction is best-effort */
  }
  await page.waitForTimeout(rnd(2800, 4800));
}

async function saveState(context: BrowserContext): Promise<object> {
  try {
    return await context.storageState();
  } catch {
    return {};
  }
}

export async function closeBrowser(): Promise<void> {
  cancelIdleClose();
  // Detach before awaiting, so a scrape that starts mid-close launches a fresh
  // browser instead of getting this closing one.
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    const b = await p.catch(() => null);
    await b?.close().catch(() => {});
  }
}
