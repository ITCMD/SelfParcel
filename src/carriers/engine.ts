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
import type { CarrierModule, FieldMap, FastJsonSpec } from './moduleSchema.js';

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

function fillTemplate(url: string, tn: string): string {
  return url.replace(/\{tn\}/g, encodeURIComponent(tn));
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

function parseHtml(module: CarrierModule, html: string, source: 'http' | 'browser'): TrackingResult | null {
  const spec = module.scraper!;
  const $ = cheerio.load(html);
  if (matchesNotFound(module, $.text())) {
    throw new NotFoundError(`${module.name}: status not available yet`);
  }

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
  if (events.length === 0 && !banner) return null;
  return summarize(module, module.code, events, source, banner || undefined);
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
  const html = await fetchRenderedHtml(url, {
    waitFor: spec.browser.waitFor,
    guard: async (target) => {
      await assertPublicUrl(target);
    },
  });
  const parsed = parseHtml(module, html, 'browser');
  if (!parsed) throw new NotFoundError(`${module.name}: could not parse tracking page`);
  return parsed;
}

async function trackJson(module: CarrierModule, tn: string): Promise<TrackingResult> {
  const spec = module.json!;
  const res = await safeRequest(fillTemplate(module.request.url, tn), {
    method: module.request.method,
    headers: module.request.headers,
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
