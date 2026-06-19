import { createHash } from 'node:crypto';
import { db } from './index.js';
import type { CarrierCode, TrackingResult, TrackStatus } from '../carriers/types.js';

export interface PackageRow {
  id: number;
  tracking_number: string;
  carrier: CarrierCode;
  label: string | null;
  status: TrackStatus;
  est_delivery: string | null;
  archived: number;
  notify: number;
  owner_user_id: string;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  package_id: number;
  timestamp: string | null;
  status: TrackStatus;
  description: string;
  location: string | null;
  dedupe_key: string;
}

// ownerId: undefined = no scoping (auth off); a string scopes to that owner.
export function listPackages(includeArchived = false, ownerId?: string): PackageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!includeArchived) where.push('archived = 0');
  if (ownerId !== undefined) {
    where.push('owner_user_id = ?');
    params.push(ownerId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM packages ${clause} ORDER BY created_at DESC`)
    .all(...params) as PackageRow[];
}

export function getPackage(id: number): PackageRow | undefined {
  return db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as
    | PackageRow
    | undefined;
}

export function getEvents(packageId: number): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE package_id = ?
       ORDER BY COALESCE(timestamp, '') DESC, id DESC`,
    )
    .all(packageId) as EventRow[];
}

export function addPackage(input: {
  trackingNumber: string;
  carrier: CarrierCode;
  label?: string | null;
  ownerId?: string | null;
}): PackageRow {
  const stmt = db.prepare(
    `INSERT INTO packages (tracking_number, carrier, label, owner_user_id)
     VALUES (@trackingNumber, @carrier, @label, @owner)
     ON CONFLICT (owner_user_id, tracking_number, carrier) DO UPDATE SET archived = 0
     RETURNING *`,
  );
  return stmt.get({
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    label: input.label ?? null,
    owner: input.ownerId ?? '',
  }) as PackageRow;
}

export function setArchived(id: number, archived: boolean): void {
  db.prepare('UPDATE packages SET archived = ? WHERE id = ?').run(
    archived ? 1 : 0,
    id,
  );
}

export function setNotify(id: number, notify: boolean): void {
  db.prepare('UPDATE packages SET notify = ? WHERE id = ?').run(notify ? 1 : 0, id);
}

export function deletePackage(id: number): void {
  db.prepare('DELETE FROM packages WHERE id = ?').run(id);
}

export function recordError(id: number, message: string): void {
  db.prepare(
    `UPDATE packages SET last_error = ?, last_checked_at = datetime('now')
     WHERE id = ?`,
  ).run(message, id);
}

function eventKey(e: { timestamp: string | null; description: string; location?: string }): string {
  return createHash('sha1')
    .update(`${e.timestamp ?? ''}|${e.description}|${e.location ?? ''}`)
    .digest('hex');
}

/** Save a fetched result: update the package summary and insert any new events. */
export function applyResult(id: number, result: TrackingResult): { newEvents: number } {
  const insertEvent = db.prepare(
    `INSERT INTO events (package_id, timestamp, status, description, location, dedupe_key)
     VALUES (@package_id, @timestamp, @status, @description, @location, @dedupe_key)
     ON CONFLICT (package_id, dedupe_key) DO NOTHING`,
  );

  const tx = db.transaction(() => {
    let added = 0;
    for (const e of result.events) {
      const info = insertEvent.run({
        package_id: id,
        timestamp: e.timestamp,
        status: e.status,
        description: e.description,
        location: e.location ?? null,
        dedupe_key: eventKey(e),
      });
      if (info.changes > 0) added++;
    }
    db.prepare(
      `UPDATE packages
       SET status = @status, est_delivery = @est, last_error = NULL,
           last_checked_at = datetime('now')
       WHERE id = @id`,
    ).run({
      id,
      status: result.status,
      est: result.estimatedDelivery ?? null,
    });
    return added;
  });

  return { newEvents: tx() };
}

/** Active, stale packages due for a refresh (not delivered or archived). */
export function packagesDueForRefresh(minMinutes: number): PackageRow[] {
  return db
    .prepare(
      `SELECT * FROM packages
       WHERE archived = 0 AND status != 'delivered'
         AND (last_checked_at IS NULL
              OR last_checked_at <= datetime('now', ?))
       ORDER BY COALESCE(last_checked_at, '') ASC`,
    )
    .all(`-${minMinutes} minutes`) as PackageRow[];
}
