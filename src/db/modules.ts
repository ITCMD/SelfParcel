import { db } from './index.js';
import { BUILTIN_SEEDS } from '../carriers/modules/seeds.js';
import type { CarrierModule } from '../carriers/moduleSchema.js';

export interface ModuleRow {
  code: string;
  name: string;
  kind: 'scraper' | 'json';
  enabled: number;
  builtin: number;
  seed_version: string | null;
  module: string; // JSON text
  source_url: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedModule extends Omit<ModuleRow, 'module'> {
  module: CarrierModule;
}

function parse(row: ModuleRow): ParsedModule {
  return { ...row, module: JSON.parse(row.module) as CarrierModule };
}

export function listModules(): ParsedModule[] {
  return (db.prepare('SELECT * FROM carrier_modules ORDER BY builtin DESC, code ASC').all() as ModuleRow[]).map(
    parse,
  );
}

export function listEnabledModules(): ParsedModule[] {
  return (
    db
      .prepare('SELECT * FROM carrier_modules WHERE enabled = 1 ORDER BY builtin DESC, code ASC')
      .all() as ModuleRow[]
  ).map(parse);
}

export function getModule(code: string): ParsedModule | undefined {
  const row = db.prepare('SELECT * FROM carrier_modules WHERE code = ?').get(code) as
    | ModuleRow
    | undefined;
  return row ? parse(row) : undefined;
}

export function upsertModule(input: {
  module: CarrierModule;
  enabled?: boolean;
  builtin?: boolean;
  seedVersion?: string | null;
  sourceUrl?: string | null;
  fetchedAt?: string | null;
}): void {
  const m = input.module;
  db.prepare(
    `INSERT INTO carrier_modules
       (code, name, kind, enabled, builtin, seed_version, module, source_url, fetched_at, updated_at)
     VALUES (@code, @name, @kind, @enabled, @builtin, @seed_version, @module, @source_url, @fetched_at, datetime('now'))
     ON CONFLICT (code) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, module = excluded.module,
       source_url = excluded.source_url, fetched_at = excluded.fetched_at,
       enabled = excluded.enabled, updated_at = datetime('now')`,
  ).run({
    code: m.code,
    name: m.name,
    kind: m.kind,
    enabled: (input.enabled ?? true) ? 1 : 0,
    builtin: input.builtin ? 1 : 0,
    seed_version: input.seedVersion ?? null,
    module: JSON.stringify(m),
    source_url: input.sourceUrl ?? null,
    fetched_at: input.fetchedAt ?? null,
  });
}

export function setModuleEnabled(code: string, enabled: boolean): void {
  db.prepare("UPDATE carrier_modules SET enabled = ?, updated_at = datetime('now') WHERE code = ?").run(
    enabled ? 1 : 0,
    code,
  );
}

export function deleteModule(code: string): void {
  db.prepare('DELETE FROM carrier_modules WHERE code = ?').run(code);
}

export function countPackagesForCarrier(code: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM packages WHERE carrier = ?').get(code) as { n: number }
  ).n;
}

/** Insert built-in seeds only when missing, so we never clobber edits. */
export function seedBuiltinModules(): void {
  for (const seed of BUILTIN_SEEDS) {
    if (getModule(seed.code)) continue;
    upsertModule({
      module: seed.module,
      enabled: true,
      builtin: true,
      seedVersion: seed.seedVersion,
    });
  }
}

/** Restore a built-in module to its seed definition. */
export function resetBuiltinModule(code: string): boolean {
  const seed = BUILTIN_SEEDS.find((s) => s.code === code);
  if (!seed) return false;
  upsertModule({
    module: seed.module,
    enabled: true,
    builtin: true,
    seedVersion: seed.seedVersion,
  });
  return true;
}
