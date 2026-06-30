import * as cheerio from 'cheerio';
import { config } from '../config.js';
import {
  classifyStatus,
  NotFoundError,
  ProviderUnavailableError,
  type CarrierProvider,
  type TrackingEvent,
  type TrackingResult,
  type TrackStatus,
} from './types.js';
import { fetchRenderedHtml } from './scraper/browser.js';
import { assertPublicUrl, safeRequest } from '../net/safeFetch.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { CarrierModule, FieldMap, FastJsonSpec } from './moduleSchema.js';

// Render a module's tracking page in the stealth browser, replaying and saving
// the carrier's session (cookies) so a hard-won bot-clearance is reused.
async function renderWithSession(module: CarrierModule, url: string): Promise<string> {
  const spec = module.scraper!;
  const key = `session:${module.code}`;
  const { html, storageState } = await fetchRenderedHtml(url, {
    waitFor: spec.browser?.waitFor,
    warmupUrl: spec.browser?.warmupUrl,
    storageState: getSetting(key) || undefined,
    timeoutMs: module.request.timeoutMs,
    guard: async (target) => {
      await assertPublicUrl(target);
    },
  });
  if (storageState) setSetting(key, storageState);
  return html;
}

// Turns a validated declarative module into a CarrierProvider. Module-supplied
// code is never executed; we only interpret regexes, CSS selectors, and dotted
// JSON paths.

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parseLooseDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Pull a delivery date out of free-text like "Expected Delivery by Friday,
// June 27, 2025 by 9:00pm". Returns a date-only YYYY-MM-DD string (the carrier
// quotes a day, not a precise time), or null when no full date is present.
// Built by hand rather than `new Date()` so it never shifts across timezones.
function parseEstimatedDelivery(raw: string): string | null {
  const text = clean(raw);
  if (!text) return null;
  const pad = (n: number) => String(n).padStart(2, '0');

  // "June 27, 2025" / "Sept 3 2025" / "Jun 25th, 2025" (month first)
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(text);
  if (m) return `${m[3]}-${pad(MONTH_NUM[m[1].toLowerCase()])}-${pad(Number(m[2]))}`;

  // "24 June 2026" / "24th June 2026" (day first — USPS renders it this way)
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i.exec(text);
  if (m) return `${m[3]}-${pad(MONTH_NUM[m[2].toLowerCase()])}-${pad(Number(m[1]))}`;

  // "06/24/2025" or "12/9/25"
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (m) {
    const year = Number(m[3]) < 100 ? Number(m[3]) + 2000 : Number(m[3]);
    return `${year}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  }

  // "2025-06-24"
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

function fillTemplate(url: string, tn: string): string {
  return url.replace(/\{tn\}/g, encodeURIComponent(tn));
}

// Body templates aren't URL contexts, so the tracking number goes in raw (it's
// already normalized to uppercase alphanumerics, so it's safe inside JSON).
function fillBody(body: string | undefined, tn: string): string | undefined {
  return body === undefined ? undefined : body.replace(/\{tn\}/g, tn);
}

function statusFromText(module: CarrierModule, text: string): TrackStatus {
  const t = text.toLowerCase();
  if (module.statusMap) {
    for (const [status, keywords] of Object.entries(module.statusMap)) {
      if (keywords.some((kw) => t.includes(kw.toLowerCase()))) {
        return status as TrackStatus;
      }
    }
  }
  return classifyStatus(text);
}

// Walk a dotted path, with "a.b || c.d" fallbacks. No eval.
function getDotted(obj: unknown, path: string): unknown {
  return path
    .trim()
    .split('.')
    .reduce<unknown>((o, key) => (o == null ? undefined : (o as any)[key.trim()]), obj);
}
function resolvePath(obj: unknown, expr: string): unknown {
  for (const alt of expr.split('||')) {
    const v = getDotted(obj, alt);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function matchesNotFound(module: CarrierModule, text: string): boolean {
  return (module.notFound ?? []).some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}

function mapJsonEvents(
  module: CarrierModule,
  rows: unknown[],
  fields: FieldMap,
): TrackingEvent[] {
  return rows.map((e) => {
    const desc = clean(String(resolvePath(e, fields.description) ?? 'Update'));
    const loc = fields.location ? resolvePath(e, fields.location) : undefined;
    return {
      timestamp: parseLooseDate(fields.date ? resolvePath(e, fields.date) : null),
      status: statusFromText(module, desc),
      description: desc,
      location: loc ? clean(String(loc)) : undefined,
    } satisfies TrackingEvent;
  });
}

function summarize(
  module: CarrierModule,
  code: string,
  events: TrackingEvent[],
  source: 'http' | 'browser',
  banner?: string,
  estimatedDelivery?: string | null,
): TrackingResult {
  const status = banner ? statusFromText(module, banner) : events[0]?.status ?? 'unknown';
  if (events.length === 0 && banner) {
    events = [{ timestamp: null, status, description: clean(banner) }];
  }
  return {
    trackingNumber: '',
    carrier: code,
    status,
    estimatedDelivery: estimatedDelivery ?? null,
    events,
    source,
  };
}

// Pull events + banner from loaded HTML. No throwing; callers decide.
function extractFromHtml(
  module: CarrierModule,
  $: cheerio.CheerioAPI,
): { events: TrackingEvent[]; banner: string; estimatedDelivery: string | null } {
  const spec = module.scraper!;
  const events: TrackingEvent[] = [];
  $(spec.rowSelector).each((_i, el) => {
    const $el = $(el);
    const desc = clean($el.find(spec.fields.description).first().text());
    if (!desc) return;
    const date = spec.fields.date ? clean($el.find(spec.fields.date).first().text()) : '';
    const location = spec.fields.location
      ? clean($el.find(spec.fields.location).first().text())
      : '';
    events.push({
      timestamp: parseLooseDate(date),
      status: statusFromText(module, desc),
      description: desc,
      location: location || undefined,
    });
  });
  const banner = spec.banner ? clean($(spec.banner).first().text()) : '';
  const estimatedDelivery = extractEstimatedDelivery(module, $);
  return { events, banner, estimatedDelivery };
}

// Estimated delivery, resilient to layout changes: try the module's selector
// first, then fall back to anchoring on an "expected/estimated delivery" phrase
// anywhere in the page and parsing the date that follows it. Only runs for
// modules that opt into ETA (they set scraper.estimatedDelivery).
function extractEstimatedDelivery(module: CarrierModule, $: cheerio.CheerioAPI): string | null {
  const sel = module.scraper?.estimatedDelivery;
  if (!sel) return null;

  const fromSelector = parseEstimatedDelivery($(sel).first().text());
  if (fromSelector) return fromSelector;

  const text = clean($('body').text() || $.text());
  const re = /(?:expected|estimated)\s+delivery(?:\s+(?:by|date|on))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const eta = parseEstimatedDelivery(text.slice(m.index, m.index + 80));
    if (eta) return eta;
  }
  return null;
}

function parseHtml(module: CarrierModule, html: string, source: 'http' | 'browser'): TrackingResult | null {
  const $ = cheerio.load(html);
  if (matchesNotFound(module, $.text())) {
    throw new NotFoundError(`${module.name}: status not available yet`);
  }
  const { events, banner, estimatedDelivery } = extractFromHtml(module, $);
  if (events.length === 0 && !banner) return null;
  return summarize(module, module.code, events, source, banner || undefined, estimatedDelivery);
}

// ── Diagnostics (for the admin "Test" button) ──────────────────────────────────
const BLOCK_MARKERS =
  /access denied|are you a human|recaptcha|captcha|verify you are|unusual traffic|enable javascript|request (was )?blocked|bot detection|pardon our interruption/i;

function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1]) : '';
}

function textSample($: cheerio.CheerioAPI): string {
  return clean($('body').text() || $.text()).slice(0, 400);
}

export interface ScrapeDebug {
  ok: boolean;
  source: 'http' | 'browser' | 'json' | 'none';
  httpStatus?: number;
  finalUrl?: string;
  htmlLength?: number;
  title?: string;
  blocked?: boolean;
  sample?: string;
  status?: TrackStatus;
  /** Parsed estimated delivery (YYYY-MM-DD), if the module found one. */
  estimatedDelivery?: string | null;
  /** Whether the estimatedDelivery selector matched any element at all. */
  etaSelectorMatched?: boolean;
  events: TrackingEvent[];
  notes: string[];
}

// Pull ETA diagnostics out of a loaded page, for the Test button.
function etaDebug(module: CarrierModule, $: cheerio.CheerioAPI): {
  estimatedDelivery: string | null;
  etaSelectorMatched: boolean;
} {
  const sel = module.scraper?.estimatedDelivery;
  if (!sel) return { estimatedDelivery: null, etaSelectorMatched: false };
  return {
    estimatedDelivery: extractEstimatedDelivery(module, $),
    etaSelectorMatched: $(sel).first().length > 0,
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run a module against a tracking number and report what actually happened. */
export async function inspectModule(module: CarrierModule, tn: string): Promise<ScrapeDebug> {
  const notes: string[] = [];
  if (module.kind === 'json') {
    try {
      const r = await trackJson(module, tn);
      return { ok: true, source: 'json', events: r.events, status: r.status, notes };
    } catch (e) {
      notes.push(msg(e));
      return { ok: false, source: 'json', events: [], notes };
    }
  }

  const spec = module.scraper!;
  const url = fillTemplate(module.request.url, tn);

  if (spec.fastJson) {
    try {
      const r = await tryFastJson(module, spec.fastJson, tn);
      if (r && r.events.length) {
        return { ok: true, source: 'json', events: r.events, status: r.status, notes };
      }
      notes.push('fastJson returned no events');
    } catch (e) {
      notes.push(`fastJson: ${msg(e)}`);
    }
  }

  // HTTP-first attempt
  let last: Partial<ScrapeDebug> = {};
  try {
    const res = await safeRequest(url, {
      method: module.request.method,
      headers: module.request.headers,
      body: fillBody(module.request.body, tn),
      maxRedirects: module.request.maxRedirections,
      timeoutMs: module.request.timeoutMs,
      maxBytes: module.request.maxBytes,
    });
    const $ = cheerio.load(res.body);
    const { events, banner } = extractFromHtml(module, $);
    last = {
      source: 'http',
      httpStatus: res.statusCode,
      finalUrl: res.finalUrl,
      htmlLength: res.body.length,
      title: pageTitle(res.body),
      blocked: BLOCK_MARKERS.test(res.body),
      sample: textSample($),
      ...etaDebug(module, $),
    };
    if (res.statusCode === 200 && (events.length || banner)) {
      const status = banner ? statusFromText(module, banner) : events[0]?.status ?? 'unknown';
      return { ...last, ok: true, source: 'http', events, status, notes };
    }
    notes.push(`HTTP ${res.statusCode}, ${events.length} matched rows`);
  } catch (e) {
    notes.push(`HTTP: ${msg(e)}`);
  }

  // Browser fallback
  if (spec.browser?.enabled && config.scraper.browserFallback) {
    try {
      const html = await renderWithSession(module, url);
      const $ = cheerio.load(html);
      const { events, banner } = extractFromHtml(module, $);
      last = {
        source: 'browser',
        htmlLength: html.length,
        title: pageTitle(html),
        blocked: BLOCK_MARKERS.test(html),
        sample: textSample($),
        ...etaDebug(module, $),
      };
      if (events.length || banner) {
        const status = banner ? statusFromText(module, banner) : events[0]?.status ?? 'unknown';
        return { ...last, ok: true, source: 'browser', events, status, notes };
      }
      notes.push(`browser render: ${events.length} matched rows`);
    } catch (e) {
      notes.push(`browser: ${msg(e)}`);
    }
  } else {
    notes.push('browser fallback disabled');
  }

  return { ...last, ok: false, source: last.source ?? 'none', events: [], notes };
}

async function tryFastJson(
  module: CarrierModule,
  spec: FastJsonSpec,
  tn: string,
): Promise<TrackingResult | null> {
  const res = await safeRequest(fillTemplate(spec.url, tn), {
    headers: spec.headers,
    timeoutMs: module.request.timeoutMs,
    maxBytes: module.request.maxBytes,
  });
  if (res.statusCode !== 200) return null;
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return null;
  }
  const rows = resolvePath(json, spec.eventsPath);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const events = mapJsonEvents(module, rows, spec.fields);
  const eta = spec.estimatedDeliveryPath
    ? (resolvePath(json, spec.estimatedDeliveryPath) as string | undefined)
    : null;
  return summarize(module, module.code, events, 'http', undefined, eta ?? null);
}

async function trackScraper(module: CarrierModule, tn: string): Promise<TrackingResult> {
  const spec = module.scraper!;

  // 1) Optional JSON fast-path
  if (spec.fastJson) {
    try {
      const r = await tryFastJson(module, spec.fastJson, tn);
      if (r && r.events.length) return r;
    } catch {
      /* fall through to HTML */
    }
  }

  const url = fillTemplate(module.request.url, tn);

  // 2) Plain HTTP GET
  try {
    const res = await safeRequest(url, {
      method: module.request.method,
      headers: module.request.headers,
      body: fillBody(module.request.body, tn),
      maxRedirects: module.request.maxRedirections,
      timeoutMs: module.request.timeoutMs,
      maxBytes: module.request.maxBytes,
    });
    if (res.statusCode === 200) {
      const parsed = parseHtml(module, res.body, 'http');
      if (parsed) return parsed;
    }
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    // otherwise fall through to the browser
  }

  // 3) Browser fallback
  if (!spec.browser?.enabled || !config.scraper.browserFallback) {
    throw new ProviderUnavailableError(
      `${module.name}: no data over HTTP and browser fallback unavailable`,
    );
  }
  const html = await renderWithSession(module, url);
  const parsed = parseHtml(module, html, 'browser');
  if (!parsed) throw new NotFoundError(`${module.name}: could not parse tracking page`);
  return parsed;
}

async function trackJson(module: CarrierModule, tn: string): Promise<TrackingResult> {
  const spec = module.json!;
  const res = await safeRequest(fillTemplate(module.request.url, tn), {
    method: module.request.method,
    headers: module.request.headers,
    body: fillBody(module.request.body, tn),
    maxRedirects: module.request.maxRedirections,
    timeoutMs: module.request.timeoutMs,
    maxBytes: module.request.maxBytes,
  });
  if (res.statusCode >= 300) {
    throw new ProviderUnavailableError(`${module.name}: HTTP ${res.statusCode}`);
  }
  if (matchesNotFound(module, res.body)) {
    throw new NotFoundError(`${module.name}: status not available yet`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new ProviderUnavailableError(`${module.name}: response was not valid JSON`);
  }
  const rows = resolvePath(json, spec.eventsPath);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new NotFoundError(`${module.name}: no tracking events yet`);
  }
  const events = mapJsonEvents(module, rows, spec.fields);
  const banner = spec.statusPath ? (resolvePath(json, spec.statusPath) as string | undefined) : undefined;
  const eta = spec.estimatedDeliveryPath
    ? (resolvePath(json, spec.estimatedDeliveryPath) as string | undefined)
    : null;
  const result = summarize(module, module.code, events, 'http', banner, eta ?? null);
  result.raw = json;
  return result;
}

/** Build a CarrierProvider that interprets the given declarative module. */
export function buildProviderFromModule(module: CarrierModule): CarrierProvider {
  return {
    code: module.code,
    name: module.name,
    kind: 'scraper',
    isConfigured: () => true,
    async track(trackingNumber): Promise<TrackingResult> {
      const result =
        module.kind === 'json'
          ? await trackJson(module, trackingNumber)
          : await trackScraper(module, trackingNumber);
      result.trackingNumber = trackingNumber;
      return result;
    },
  };
}
