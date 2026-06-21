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
  opts: { statusChanged: boolean; newStatus: TrackStatus; newEvents: number },
): boolean {
  if (opts.newEvents === 0 && !opts.statusChanged) return false;
  switch (mode) {
    case 'every_event':
      return opts.newEvents > 0 || opts.statusChanged;
    case 'delivered_exceptions':
      return (
        opts.statusChanged &&
        (opts.newStatus === 'delivered' || opts.newStatus === 'exception')
      );
    case 'status_change':
    default:
      return opts.statusChanged;
  }
}

/** Build the notification for a package whose tracking just advanced. */
export function buildMessage(
  pkg: PackageRow,
  newStatus: TrackStatus,
  latestEvent?: { description: string; location?: string | null },
): NotificationMessage {
  const name = pkg.label || pkg.tracking_number;
  const carrier = carrierName(pkg.carrier);
  const statusText = STATUS_TEXT[newStatus] ?? 'Update';

  const lines = [latestEvent?.description, latestEvent?.location].filter(Boolean);
  const body = lines.length ? lines.join(' - ') : `${carrier} · ${pkg.tracking_number}`;

  return {
    title: `${name} - ${statusText}`,
    body,
    status: newStatus,
    tags: STATUS_TAGS[newStatus],
    url: config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/` : undefined,
  };
}
