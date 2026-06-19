import { config } from '../config.js';
import type { TrackStatus } from '../carriers/types.js';
import { carrierName } from '../carriers/registry.js';
import type { PackageRow } from '../db/repo.js';
import type { TriggerMode } from '../db/settings.js';
import type { NotificationChannel, NotificationMessage } from './types.js';
import { ntfyChannel } from './channels/ntfy.js';
import { pushoverChannel } from './channels/pushover.js';
import { gotifyChannel } from './channels/gotify.js';
import { smtpChannel } from './channels/smtp.js';
import { webhookChannel } from './channels/webhook.js';
import { appriseChannel } from './channels/apprise.js';
import { webpushChannel } from './channels/webpush.js';

const channels: NotificationChannel[] = [
  ntfyChannel,
  pushoverChannel,
  gotifyChannel,
  smtpChannel,
  webhookChannel,
  appriseChannel,
  webpushChannel,
];

export function channelStatuses() {
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    configured: c.isConfigured(),
  }));
}

export function anyChannelConfigured(): boolean {
  return channels.some((c) => c.isConfigured());
}

interface SendResult {
  sent: string[];
  failed: { id: string; error: string }[];
}

/** Send a message to every configured channel. Never throws. */
export async function dispatch(msg: NotificationMessage): Promise<SendResult> {
  const active = channels.filter((c) => c.isConfigured());
  const result: SendResult = { sent: [], failed: [] };

  await Promise.all(
    active.map(async (c) => {
      try {
        await c.send(msg);
        result.sent.push(c.id);
      } catch (err) {
        result.failed.push({
          id: c.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
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
