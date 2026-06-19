import type { Browser } from 'playwright';
import { config } from '../../config.js';

// One shared headless Chromium, launched on first use. Each fetch gets its own
// context so cookies/state don't leak between pulls. Deferring launch means an
// API-only deployment never pays the startup cost.

let browserPromise: Promise<Browser> | null = null;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
}

export async function getBrowser(): Promise<Browser> {
  if (!config.scraper.browserFallback) {
    throw new Error('Browser fallback is disabled (SCRAPER_BROWSER_FALLBACK=false)');
  }
  if (!browserPromise) browserPromise = launch();
  return browserPromise;
}

/**
 * Render a URL in a real browser and return its HTML once `waitFor` (a CSS
 * selector) appears. Fallback for when plain HTTP can't get JS-rendered data.
 */
export async function fetchRenderedHtml(
  url: string,
  opts: { waitFor?: string; timeoutMs?: number; guard?: (target: string) => Promise<void> } = {},
): Promise<string> {
  // SSRF check for caller-supplied URLs (module fetches pass a guard)
  if (opts.guard) await opts.guard(url);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });

  // Block requests (redirects, subresources) to non-public hosts
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 30_000 });
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout: opts.timeoutMs ?? 30_000 }).catch(() => {
        // If the selector never shows up, just return whatever rendered and let
        // the caller parse it.
      });
    }
    return await page.content();
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
