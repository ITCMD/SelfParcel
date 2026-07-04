import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from '../../config.js';

// Shared Chromium for scraping, launched on first use. Stealth-hardened to get
// past basic bot protection. For tough WAFs (USPS/UPS use Akamai) the most
// effective option is BROWSER_CDP_URL pointing at a real external Chrome.

chromium.use(StealthPlugin());

let browserPromise: Promise<Browser> | null = null;

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
    browserPromise = launch().catch((err) => {
      browserPromise = null; // allow retry on next call
      throw err;
    });
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
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
