import { db } from './index.js';
import { config } from '../config.js';

// Key/value store for the handful of runtime-editable settings (right now just
// the notification trigger mode).

export type TriggerMode = 'status_change' | 'every_event' | 'delivered_exceptions';

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const TRIGGER_MODES: TriggerMode[] = [
  'status_change',
  'every_event',
  'delivered_exceptions',
];

export function getTriggerMode(): TriggerMode {
  const stored = getSetting('notify_trigger');
  if (stored && TRIGGER_MODES.includes(stored as TriggerMode)) {
    return stored as TriggerMode;
  }
  return config.notify.defaultTrigger;
}

export function setTriggerMode(mode: TriggerMode): void {
  if (!TRIGGER_MODES.includes(mode)) throw new Error(`Invalid trigger mode: ${mode}`);
  setSetting('notify_trigger', mode);
}

// Web Push subscriptions
export interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
}

export function listPushSubs(): PushSub[] {
  return db.prepare('SELECT * FROM push_subscriptions').all() as PushSub[];
}

export function addPushSub(sub: {
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
}): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label)
     VALUES (@endpoint, @p256dh, @auth, @label)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run({
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    label: sub.label ?? null,
  });
}

export function removePushSub(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function countPushSubs(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number })
    .n;
}
