import type { CarrierCode } from './types.js';
import { enabledModules, modulesVersion } from './registry.js';

// Guess the carrier from a tracking number's shape, using each enabled module's
// detect patterns. Formats overlap, so the UI always lets the user override.

export function normalizeTrackingNumber(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

interface Rule {
  code: CarrierCode;
  re: RegExp;
}

let rules: Rule[] = [];
let builtAt = -1;

function rebuild(): void {
  rules = [];
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
