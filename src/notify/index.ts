import { config } from '../config.js';
import type { TrackStatus } from '../carriers/types.js';
import { carrierName } from '../carriers/registry.js';
import type { PackageRow } from '../db/repo.js';
import { listUserNotifyChannels, type TriggerMode } from '../db/notify.js';
import type { ChannelConfig, NotificationChannel, NotificationMessage } from './types.js';
import { ntfyChannel } from './channels/ntfy.js';
import { pushoverChannel } from './channels/pushover.js';
import { gotifyChannel } from './channels/gotify.js';
import { smtpChannel, smtpRelayConfigured } from './channels/smtp.js';
import { webhookChannel } from './channels/webhook.js';
import { appriseChannel } from './channels/apprise.js';
import { sendWebPush } from './channels/webpush.js';

// Registry of the typed channels a user can add. Web Push is handled separately
// (device-based, not user-entered config).
const CHANNELS: NotificationChannel[] = [
  ntfyChannel,
  pushoverChannel,
  gotifyChannel,
  smtpChannel,
  webhookChannel,
  appriseChannel,
];

const byType = new Map(CHANNELS.map((c) => [c.type, c]));

export function getChannelType(type: string): NotificationChannel | undefined {
  return byType.get(type);
}

/** Metadata for the "add a notification" dropdown and its per-type form. */
export function channelTypeMeta() {
  return CHANNELS.map((c) => ({
    type: c.type,
    name: c.name,
    fields: c.fields,
    requiresSmtpRelay: Boolean(c.requiresSmtpRelay),
    // Email is the only type that depends on server-side config.
    available: c.requiresSmtpRelay ? smtpRelayConfigured() : true,
  }));
}

/** Validate a config for a type. Returns an error string or null. */
export function validateChannelConfig(type: string, cfg: ChannelConfig): string | null {
  const channel = byType.get(type);
  if (!channel) return 'Unknown notification type';
  return channel.validate(cfg);
}

/** Send one message through a single explicit type+config (used by the test button). */
export async function sendViaChannel(
  type: string,
  cfg: ChannelConfig,
  msg: NotificationMessage,
): Promise<void> {
  const channel = byType.get(type);
  if (!channel) throw new Error('Unknown notification type');
  const err = channel.validate(cfg);
  if (err) throw new Error(err);
  await channel.send(msg, cfg);
}

interface SendResult {
  sent: number;
  failed: { label: string; error: string }[];
}

/** Send a message to all of a user's enabled channels plus their devices. */
export async function dispatch(msg: NotificationMessage, userId: string): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: [] };
  const instances = listUserNotifyChannels(userId).filter((c) => c.enabled);

  const jobs: Promise<void>[] = instances.map(async (inst) => {
    const channel = byType.get(inst.type);
    const tag = inst.label || channel?.name || inst.type;
    if (!channel) {
      result.failed.push({ label: tag, error: `Unknown type "${inst.type}"` });
      return;
    }
    try {
      await channel.send(msg, inst.config);
      result.sent += 1;
    } catch (err) {
      result.failed.push({ label: tag, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Browser push for this user's devices, alongside the typed channels.
  jobs.push(
    (async () => {
      try {
        await sendWebPush(msg, userId);
      } catch (err) {
        result.failed.push({
          label: 'Browser push',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })(),
  );

  await Promise.all(jobs);
  return result;
}

const STATUS_TEXT: Record<TrackStatus, string> = {
  pre_transit: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  unknown: 'Update',
};

const STATUS_TAGS: Record<TrackStatus, string[]> = {
  pre_transit: ['package'],
  in_transit: ['truck'],
  out_for_delivery: ['rotating_light'],
  delivered: ['white_check_mark'],
  exception: ['warning'],
  unknown: ['package'],
};

/** Decide whether a refresh outcome warrants a notification. */
export function shouldNotify(
  mode: TriggerMode,
  opts: { statusChanged: boolean; newStatus: TrackStatus; newEvents: number; etaChanged?: boolean },
): boolean {
  const etaChanged = opts.etaChanged ?? false;
  if (opts.newEvents === 0 && !opts.statusChanged && !etaChanged) return false;
  switch (mode) {
    case 'every_event':
      return opts.newEvents > 0 || opts.statusChanged || etaChanged;
    case 'delivered_exceptions':
      // Deliberately minimal: only final/problem states, not date shuffles.
      return (
        opts.statusChanged &&
        (opts.newStatus === 'delivered' || opts.newStatus === 'exception')
      );
    case 'status_change':
    default:
      return opts.statusChanged || etaChanged;
  }
}

// Friendly arrival label from a delivery date: the weekday alone within a week
// ("Tuesday"), otherwise weekday + date ("Tue, Jul 15"). Parses a YYYY-MM-DD as a
// local date so the weekday never slips a day across timezones.
function arrivalLabel(eta: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eta);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(eta);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  return days >= 0 && days <= 6
    ? d.toLocaleDateString('en-US', { weekday: 'long' })
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Build the notification for a package whose tracking just advanced. */
export function buildMessage(
  pkg: PackageRow,
  newStatus: TrackStatus,
  opts: {
    latestEvent?: { description: string; location?: string | null };
    statusChanged?: boolean;
    /** New estimated delivery, set only when the delivery day just changed. */
    newEta?: string | null;
  } = {},
): NotificationMessage {
  const name = pkg.label || pkg.tracking_number;
  const carrier = carrierName(pkg.carrier);
  const statusText = STATUS_TEXT[newStatus] ?? 'Update';
  const arrival = opts.newEta ? arrivalLabel(opts.newEta) : null;

  const eventLine = [opts.latestEvent?.description, opts.latestEvent?.location]
    .filter(Boolean)
    .join(' - ');
  const base = eventLine || `${carrier} · ${pkg.tracking_number}`;

  // Lead with the new arrival day when that's the news (delivery date moved but
  // the status didn't advance); otherwise headline the status and fold the new
  // arrival into the body.
  const etaLed = Boolean(arrival) && !opts.statusChanged;
  const title = etaLed ? `${name} - Now arriving ${arrival}` : `${name} - ${statusText}`;
  const body = !etaLed && arrival ? `Now arriving ${arrival} · ${base}` : base;

  return {
    title,
    body,
    status: newStatus,
    tags: STATUS_TAGS[newStatus],
    url: config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/` : undefined,
  };
}
