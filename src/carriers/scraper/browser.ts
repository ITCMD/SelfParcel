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

// Headers a real Chrome sends.
const REALISTIC_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

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
  return (await chromium.launch({
    headless: !config.scraper.headful,
    executablePath: config.scraper.executablePath || undefined,
    args: LAUNCH_ARGS,
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
    extraHTTPHeaders: REALISTIC_HEADERS,
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
