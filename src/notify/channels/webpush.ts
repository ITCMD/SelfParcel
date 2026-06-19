import webpush from 'web-push';
import { config } from '../../config.js';
import { listPushSubs, removePushSub } from '../../db/notify.js';
import type { NotificationChannel } from '../types.js';

// Browser push over the Web Push protocol (VAPID). The /api/push routes store
// subscriptions in the DB; here we send to all of them and drop any the browser
// has expired (HTTP 404/410).

let configured = false;

function ensureVapid(): boolean {
  if (configured) return true;
  if (!config.notify.webpush.publicKey || !config.notify.webpush.privateKey) {
    return false;
  }
  webpush.setVapidDetails(
    config.notify.webpush.subject,
    config.notify.webpush.publicKey,
    config.notify.webpush.privateKey,
  );
  configured = true;
  return true;
}

export const webpushChannel: NotificationChannel = {
  id: 'webpush',
  name: 'Browser push',
  isConfigured: (t) =>
    Boolean(
      config.notify.webpush.publicKey &&
        config.notify.webpush.privateKey &&
        listPushSubs(t.userId).length > 0,
    ),

  async send(msg, t) {
    if (!ensureVapid()) throw new Error('Web Push VAPID keys not configured');
    const subs = listPushSubs(t.userId);
    if (subs.length === 0) return;

    const payload = JSON.stringify({
      title: msg.title,
      body: msg.body,
      url: msg.url ?? '/',
      tag: 'selfparcel',
    });

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
        } catch (err: any) {
          // Subscription is gone, drop it so we stop trying.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            removePushSub(s.endpoint);
          } else {
            throw err;
          }
        }
      }),
    );
  },
};

/** Generate a fresh VAPID keypair (used by `npm run gen:vapid`). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
