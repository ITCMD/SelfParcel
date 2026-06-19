import { db } from './index.js';
import { config } from '../config.js';

// Per-user notification settings: channel targets, trigger, and Web Push
// subscriptions. user_id '' is the implicit single user when auth is off.

export type TriggerMode = 'status_change' | 'every_event' | 'delivered_exceptions';
const TRIGGER_MODES: TriggerMode[] = ['status_change', 'every_event', 'delivered_exceptions'];

export type WebhookFormat = 'json' | 'discord' | 'slack';

export interface UserChannels {
  ntfyUrl: string;
  ntfyToken: string;
  pushoverToken: string;
  pushoverUser: string;
  gotifyUrl: string;
  gotifyToken: string;
  webhookUrl: string;
  webhookFormat: WebhookFormat;
  smtpTo: string;
  appriseUrls: string;
}

interface SettingsRow {
  user_id: string;
  trigger: string | null;
  ntfy_url: string | null;
  ntfy_token: string | null;
  pushover_token: string | null;
  pushover_user: string | null;
  gotify_url: string | null;
  gotify_token: string | null;
  webhook_url: string | null;
  webhook_format: string | null;
  smtp_to: string | null;
  apprise_urls: string | null;
}

const EMPTY: UserChannels = {
  ntfyUrl: '',
  ntfyToken: '',
  pushoverToken: '',
  pushoverUser: '',
  gotifyUrl: '',
  gotifyToken: '',
  webhookUrl: '',
  webhookFormat: 'json',
  smtpTo: '',
  appriseUrls: '',
};

function rowToChannels(r: SettingsRow | undefined): UserChannels {
  if (!r) return { ...EMPTY };
  return {
    ntfyUrl: r.ntfy_url ?? '',
    ntfyToken: r.ntfy_token ?? '',
    pushoverToken: r.pushover_token ?? '',
    pushoverUser: r.pushover_user ?? '',
    gotifyUrl: r.gotify_url ?? '',
    gotifyToken: r.gotify_token ?? '',
    webhookUrl: r.webhook_url ?? '',
    webhookFormat: (r.webhook_format as WebhookFormat) || 'json',
    smtpTo: r.smtp_to ?? '',
    appriseUrls: r.apprise_urls ?? '',
  };
}

function getRow(userId: string): SettingsRow | undefined {
  return db.prepare('SELECT * FROM user_notify_settings WHERE user_id = ?').get(userId) as
    | SettingsRow
    | undefined;
}

export function getUserChannels(userId: string): UserChannels {
  return rowToChannels(getRow(userId));
}

export function getUserTrigger(userId: string): TriggerMode {
  const t = getRow(userId)?.trigger;
  return t && TRIGGER_MODES.includes(t as TriggerMode)
    ? (t as TriggerMode)
    : config.notify.defaultTrigger;
}

export function saveUserNotify(
  userId: string,
  input: Partial<UserChannels> & { trigger?: string },
): void {
  const cur = getRow(userId);
  const merged = { ...rowToChannels(cur), ...input };
  const trigger =
    input.trigger && TRIGGER_MODES.includes(input.trigger as TriggerMode)
      ? input.trigger
      : cur?.trigger ?? null;
  db.prepare(
    `INSERT INTO user_notify_settings
       (user_id, trigger, ntfy_url, ntfy_token, pushover_token, pushover_user,
        gotify_url, gotify_token, webhook_url, webhook_format, smtp_to, apprise_urls, updated_at)
     VALUES (@user_id, @trigger, @ntfy_url, @ntfy_token, @pushover_token, @pushover_user,
        @gotify_url, @gotify_token, @webhook_url, @webhook_format, @smtp_to, @apprise_urls, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET
       trigger = excluded.trigger, ntfy_url = excluded.ntfy_url, ntfy_token = excluded.ntfy_token,
       pushover_token = excluded.pushover_token, pushover_user = excluded.pushover_user,
       gotify_url = excluded.gotify_url, gotify_token = excluded.gotify_token,
       webhook_url = excluded.webhook_url, webhook_format = excluded.webhook_format,
       smtp_to = excluded.smtp_to, apprise_urls = excluded.apprise_urls, updated_at = datetime('now')`,
  ).run({
    user_id: userId,
    trigger,
    ntfy_url: merged.ntfyUrl,
    ntfy_token: merged.ntfyToken,
    pushover_token: merged.pushoverToken,
    pushover_user: merged.pushoverUser,
    gotify_url: merged.gotifyUrl,
    gotify_token: merged.gotifyToken,
    webhook_url: merged.webhookUrl,
    webhook_format: merged.webhookFormat,
    smtp_to: merged.smtpTo,
    apprise_urls: merged.appriseUrls,
  });
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
