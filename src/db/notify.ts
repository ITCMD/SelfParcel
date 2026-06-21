import { db } from './index.js';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';

// Per-user notification settings: a trigger preference, a list of channel
// instances, and Web Push subscriptions. user_id '' is the implicit single
// user when auth is off.

export type TriggerMode = 'status_change' | 'every_event' | 'delivered_exceptions';
const TRIGGER_MODES: TriggerMode[] = ['status_change', 'every_event', 'delivered_exceptions'];

// ── Trigger (when to notify) ───────────────────────────────────────────────────
export function getUserTrigger(userId: string): TriggerMode {
  const row = db
    .prepare('SELECT trigger FROM user_notify_settings WHERE user_id = ?')
    .get(userId) as { trigger: string | null } | undefined;
  const t = row?.trigger;
  return t && TRIGGER_MODES.includes(t as TriggerMode)
    ? (t as TriggerMode)
    : config.notify.defaultTrigger;
}

export function saveUserTrigger(userId: string, trigger: string): void {
  if (!TRIGGER_MODES.includes(trigger as TriggerMode)) return;
  db.prepare(
    `INSERT INTO user_notify_settings (user_id, trigger, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET trigger = excluded.trigger, updated_at = datetime('now')`,
  ).run(userId, trigger);
}

// ── Channel instances ──────────────────────────────────────────────────────────
export interface NotifyChannel {
  id: number;
  userId: string;
  type: string;
  label: string;
  config: Record<string, string>;
  enabled: boolean;
}

interface ChannelRow {
  id: number;
  user_id: string;
  type: string;
  label: string | null;
  config: string;
  enabled: number;
}

function rowToChannel(r: ChannelRow): NotifyChannel {
  let config: Record<string, string> = {};
  try {
    config = JSON.parse(r.config) as Record<string, string>;
  } catch {
    config = {};
  }
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    label: r.label ?? '',
    config,
    enabled: r.enabled !== 0,
  };
}

export function listUserNotifyChannels(userId: string): NotifyChannel[] {
  return (
    db
      .prepare('SELECT * FROM user_notify_channels WHERE user_id = ? ORDER BY id ASC')
      .all(userId) as ChannelRow[]
  ).map(rowToChannel);
}

export function getUserNotifyChannel(userId: string, id: number): NotifyChannel | undefined {
  const r = db
    .prepare('SELECT * FROM user_notify_channels WHERE user_id = ? AND id = ?')
    .get(userId, id) as ChannelRow | undefined;
  return r ? rowToChannel(r) : undefined;
}

export function addUserNotifyChannel(
  userId: string,
  input: { type: string; label?: string; config: Record<string, string>; enabled?: boolean },
): NotifyChannel {
  const info = db
    .prepare(
      `INSERT INTO user_notify_channels (user_id, type, label, config, enabled)
       VALUES (@user_id, @type, @label, @config, @enabled)`,
    )
    .run({
      user_id: userId,
      type: input.type,
      label: input.label?.trim() || null,
      config: JSON.stringify(input.config ?? {}),
      enabled: (input.enabled ?? true) ? 1 : 0,
    });
  return getUserNotifyChannel(userId, Number(info.lastInsertRowid))!;
}

export function updateUserNotifyChannel(
  userId: string,
  id: number,
  input: { label?: string; config?: Record<string, string>; enabled?: boolean },
): NotifyChannel | undefined {
  const existing = getUserNotifyChannel(userId, id);
  if (!existing) return undefined;
  const label = input.label !== undefined ? input.label.trim() || null : existing.label || null;
  const cfg = input.config !== undefined ? input.config : existing.config;
  const enabled = input.enabled !== undefined ? input.enabled : existing.enabled;
  db.prepare(
    `UPDATE user_notify_channels SET label = @label, config = @config, enabled = @enabled
     WHERE user_id = @user_id AND id = @id`,
  ).run({
    user_id: userId,
    id,
    label,
    config: JSON.stringify(cfg),
    enabled: enabled ? 1 : 0,
  });
  return getUserNotifyChannel(userId, id);
}

export function deleteUserNotifyChannel(userId: string, id: number): void {
  db.prepare('DELETE FROM user_notify_channels WHERE user_id = ? AND id = ?').run(userId, id);
}

// ── One-time migration from the old fixed-column layout ─────────────────────────
// Turns each non-empty channel in user_notify_settings into a discrete instance.
const MIGRATION_FLAG = 'migrated:notify_channels_v1';

export function migrateLegacyNotifyChannels(): void {
  if (getSetting(MIGRATION_FLAG)) return;

  const rows = db.prepare('SELECT * FROM user_notify_settings').all() as Record<string, string | null>[];
  const insert = db.prepare(
    `INSERT INTO user_notify_channels (user_id, type, label, config, enabled)
     VALUES (@user_id, @type, @label, @config, 1)`,
  );

  const tx = db.transaction(() => {
    for (const r of rows) {
      const uid = r.user_id ?? '';
      const add = (type: string, cfg: Record<string, string>) =>
        insert.run({ user_id: uid, type, label: null, config: JSON.stringify(cfg) });

      if (r.ntfy_url) add('ntfy', { url: r.ntfy_url, token: r.ntfy_token ?? '' });
      if (r.pushover_token && r.pushover_user)
        add('pushover', { token: r.pushover_token, user: r.pushover_user });
      if (r.gotify_url && r.gotify_token)
        add('gotify', { url: r.gotify_url, token: r.gotify_token });
      if (r.webhook_url)
        add('webhook', { url: r.webhook_url, format: r.webhook_format || 'json' });
      if (r.smtp_to) add('email', { to: r.smtp_to });
      // Apprise previously relied on a server-wide API URL; carry it into the
      // instance so existing setups keep working without server config.
      if (r.apprise_urls)
        add('apprise', { apiUrl: config.notify.apprise.apiUrl || '', urls: r.apprise_urls });
    }
  });
  tx();
  setSetting(MIGRATION_FLAG, new Date().toISOString());
}

// ── Web Push subscriptions (per user) ──────────────────────────────────────────
export interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
}

export function listPushSubs(userId: string): PushSub[] {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as PushSub[];
}

export function addPushSub(sub: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
}): void {
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
     VALUES (@user_id, @endpoint, @p256dh, @auth, @label)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run({
    user_id: sub.userId,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    label: sub.label ?? null,
  });
}

export function removePushSub(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function countPushSubs(userId: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
      .get(userId) as { n: number }
  ).n;
}
