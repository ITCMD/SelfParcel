import { CARRIER_NAMES, type CarrierCode, type CarrierProvider } from './types.js';
import { upsProvider } from './api/ups.js';
import { fedexProvider } from './api/fedex.js';
import { buildProviderFromModule } from './engine.js';
import { listModules, type ParsedModule } from '../db/modules.js';

// Dynamic carrier registry: native API providers (UPS, FedEx) plus module
// providers loaded from the DB. Call reloadModules() after any change to the
// carrier_modules table.

const native: Record<string, CarrierProvider> = {
  ups: upsProvider,
  fedex: fedexProvider,
};

let moduleProviders = new Map<string, CarrierProvider>();
let moduleMeta = new Map<string, ParsedModule>();
let version = 0;

export function reloadModules(): void {
  const next = new Map<string, CarrierProvider>();
  const meta = new Map<string, ParsedModule>();
  for (const row of listModules()) {
    meta.set(row.code, row);
    if (row.enabled) next.set(row.code, buildProviderFromModule(row.module));
  }
  moduleProviders = next;
  moduleMeta = meta;
  version++;
}

/** Monotonic counter bumped on every reload; used to invalidate detect caches. */
export function modulesVersion(): number {
  return version;
}

export function getProvider(code: CarrierCode): CarrierProvider {
  const p = native[code] ?? moduleProviders.get(code);
  if (!p) throw new Error(`Unknown or disabled carrier: ${code}`);
  return p;
}

export function has(code: CarrierCode): boolean {
  return Boolean(native[code] ?? moduleProviders.get(code));
}

export function carrierName(code: CarrierCode): string {
  return (
    native[code]?.name ??
    moduleMeta.get(code)?.name ??
    CARRIER_NAMES[code] ??
    code.toUpperCase()
  );
}

export function allProviders(): CarrierProvider[] {
  return [...Object.values(native), ...moduleProviders.values()];
}

/** Enabled module metadata, for detection ordering. */
export function enabledModules(): ParsedModule[] {
  return [...moduleMeta.values()].filter((m) => m.enabled);
}

export function carrierStatuses() {
  const nativeRows = Object.values(native).map((p) => ({
    code: p.code,
    name: p.name,
    kind: p.kind,
    configured: p.isConfigured(),
    builtin: true,
    source: 'native' as const,
  }));
  const moduleRows = [...moduleMeta.values()].map((m) => ({
    code: m.code,
    name: m.name,
    kind: m.module.kind,
    configured: Boolean(m.enabled),
    builtin: Boolean(m.builtin),
    source: 'module' as const,
  }));
  return [...nativeRows, ...moduleRows];
}
