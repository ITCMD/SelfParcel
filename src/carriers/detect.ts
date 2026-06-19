import type { CarrierCode } from './types.js';
import { enabledModules, modulesVersion } from './registry.js';

// Guess the carrier from a tracking number's shape. Native carriers (UPS,
// FedEx) match first for precedence (20-digit goes to FedEx, 22-digit to USPS),
// then module patterns. Formats overlap, so the UI always lets the user
// override.

export function normalizeTrackingNumber(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

interface Rule {
  code: CarrierCode;
  re: RegExp;
}

// Hard-coded patterns for the OAuth providers
const NATIVE: Rule[] = [
  { code: 'ups', re: /^1Z[0-9A-Z]{16}$/ },
  { code: 'ups', re: /^(T\d{10}|\d{9}|\d{26})$/ },
  { code: 'fedex', re: /^\d{12}$/ },
  { code: 'fedex', re: /^\d{15}$/ },
  { code: 'fedex', re: /^\d{20}$/ },
];

let rules: Rule[] = [];
let builtAt = -1;

function rebuild(): void {
  rules = [...NATIVE];
  for (const m of enabledModules()) {
    for (const d of m.module.detect) {
      try {
        rules.push({ code: m.code, re: new RegExp(d.pattern) });
      } catch {
        // one bad regex shouldn't break detection for the rest
      }
    }
  }
  builtAt = modulesVersion();
}

export function detectCarrier(raw: string): CarrierCode | null {
  if (builtAt !== modulesVersion()) rebuild();
  const t = normalizeTrackingNumber(raw);
  for (const r of rules) {
    if (r.re.test(t)) return r.code;
  }
  return null;
}
