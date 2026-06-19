// Declarative carrier module schema "selfparcel.module/v1" and its validator.
// Modules are pure data: detection regexes, a request template, and extraction
// rules (CSS selectors or JSON paths). Nothing here runs as code. Regexes go
// through `new RegExp` in try/catch and paths are walked by a small interpreter,
// which is why installing a module from a URL is safe.

export const MODULE_SCHEMA = 'selfparcel.module/v1';

export type ModuleKind = 'scraper' | 'json';

const VALID_STATUSES = [
  'pre_transit',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
];

export interface ModuleRequest {
  url: string; // may contain the {tn} token
  method?: string;
  headers?: Record<string, string>;
  maxRedirections?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FieldMap {
  description: string;
  date?: string;
  location?: string;
}

export interface FastJsonSpec {
  url: string;
  headers?: Record<string, string>;
  eventsPath: string;
  fields: FieldMap;
  statusPath?: string;
  estimatedDeliveryPath?: string;
}

export interface ScraperSpec {
  browser?: { enabled?: boolean; waitFor?: string; warmupUrl?: string };
  rowSelector: string;
  fields: FieldMap;
  banner?: string;
  fastJson?: FastJsonSpec;
}

export interface JsonSpec {
  eventsPath: string;
  fields: FieldMap;
  statusPath?: string;
  estimatedDeliveryPath?: string;
}

export interface CarrierModule {
  schema: typeof MODULE_SCHEMA;
  code: string;
  name: string;
  kind: ModuleKind;
  detect: { pattern: string }[];
  statusMap?: Record<string, string[]>;
  request: ModuleRequest;
  notFound?: string[];
  scraper?: ScraperSpec;
  json?: JsonSpec;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  module?: CarrierModule;
}

const CODE_RE = /^[a-z0-9_-]{2,32}$/;

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function regexOk(src: unknown, errors: string[], label: string): void {
  if (typeof src !== 'string') {
    errors.push(`${label} must be a string`);
    return;
  }
  try {
    new RegExp(src, 'i');
  } catch {
    errors.push(`${label} is not a valid regular expression`);
  }
}

function checkHeaders(h: unknown, errors: string[], label: string): void {
  if (h === undefined) return;
  if (typeof h !== 'object' || h === null || Array.isArray(h)) {
    errors.push(`${label} must be an object of string headers`);
    return;
  }
  for (const [k, v] of Object.entries(h)) {
    if (typeof v !== 'string') errors.push(`${label}.${k} must be a string`);
  }
}

function checkUrlTemplate(url: unknown, errors: string[], label: string): void {
  if (!isStr(url)) {
    errors.push(`${label} is required`);
    return;
  }
  try {
    // Substitute a sample tracking number, then validate the resulting URL
    const probe = new URL(url.replace(/\{tn\}/g, 'SAMPLE123'));
    if (probe.protocol !== 'http:' && probe.protocol !== 'https:') {
      errors.push(`${label} must be http(s)`);
    }
  } catch {
    errors.push(`${label} is not a valid URL`);
  }
}

function checkFields(fields: unknown, errors: string[], label: string): void {
  if (typeof fields !== 'object' || fields === null) {
    errors.push(`${label} is required`);
    return;
  }
  const f = fields as Record<string, unknown>;
  if (!isStr(f.description)) errors.push(`${label}.description is required`);
  for (const key of ['date', 'location']) {
    if (f[key] !== undefined && typeof f[key] !== 'string') {
      errors.push(`${label}.${key} must be a string`);
    }
  }
}

/** Validate arbitrary input against the module schema. */
export function validateModule(
  input: unknown,
  opts: { allowCode?: string } = {},
): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Module must be a JSON object'] };
  }
  const m = input as Record<string, any>;

  if (m.schema !== MODULE_SCHEMA) {
    errors.push(`schema must be "${MODULE_SCHEMA}"`);
  }
  if (!isStr(m.code) || !CODE_RE.test(m.code)) {
    errors.push('code must match [a-z0-9_-], 2-32 chars');
  }
  if (!isStr(m.name)) errors.push('name is required');
  if (m.kind !== 'scraper' && m.kind !== 'json') {
    errors.push('kind must be "scraper" or "json"');
  }

  if (!Array.isArray(m.detect) || m.detect.length === 0) {
    errors.push('detect must be a non-empty array');
  } else {
    m.detect.forEach((d: any, i: number) => regexOk(d?.pattern, errors, `detect[${i}].pattern`));
  }

  if (m.statusMap !== undefined) {
    if (typeof m.statusMap !== 'object' || m.statusMap === null) {
      errors.push('statusMap must be an object');
    } else {
      for (const [k, v] of Object.entries(m.statusMap)) {
        if (!VALID_STATUSES.includes(k)) errors.push(`statusMap key "${k}" is not a valid status`);
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          errors.push(`statusMap.${k} must be an array of strings`);
        }
      }
    }
  }

  if (typeof m.request !== 'object' || m.request === null) {
    errors.push('request is required');
  } else {
    checkUrlTemplate(m.request.url, errors, 'request.url');
    checkHeaders(m.request.headers, errors, 'request.headers');
  }

  if (m.notFound !== undefined) {
    if (!Array.isArray(m.notFound)) errors.push('notFound must be an array');
    else m.notFound.forEach((p: any, i: number) => regexOk(p, errors, `notFound[${i}]`));
  }

  if (m.kind === 'scraper') {
    if (typeof m.scraper !== 'object' || m.scraper === null) {
      errors.push('scraper block is required for kind "scraper"');
    } else {
      if (!isStr(m.scraper.rowSelector)) errors.push('scraper.rowSelector is required');
      checkFields(m.scraper.fields, errors, 'scraper.fields');
      if (m.scraper.banner !== undefined && typeof m.scraper.banner !== 'string') {
        errors.push('scraper.banner must be a string');
      }
      if (m.scraper.browser?.warmupUrl !== undefined) {
        checkUrlTemplate(m.scraper.browser.warmupUrl, errors, 'scraper.browser.warmupUrl');
      }
      if (m.scraper.fastJson !== undefined) {
        const fj = m.scraper.fastJson;
        checkUrlTemplate(fj?.url, errors, 'scraper.fastJson.url');
        if (!isStr(fj?.eventsPath)) errors.push('scraper.fastJson.eventsPath is required');
        checkFields(fj?.fields, errors, 'scraper.fastJson.fields');
        checkHeaders(fj?.headers, errors, 'scraper.fastJson.headers');
      }
    }
  }

  if (m.kind === 'json') {
    if (typeof m.json !== 'object' || m.json === null) {
      errors.push('json block is required for kind "json"');
    } else {
      if (!isStr(m.json.eventsPath)) errors.push('json.eventsPath is required');
      checkFields(m.json.fields, errors, 'json.fields');
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], module: input as CarrierModule };
}
