import webpush from 'web-push';
import { listPushSubs, removePushSub } from '../../db/notify.js';
import { ensureVapidKeys, vapidSubject } from '../vapid.js';
import type { NotificationMessage } from '../types.js';

// Browser push over the Web Push protocol (VAPID). Unlike the typed channels,
// this isn't user-entered config: a device subscribes via the /api/push routes
// and we send to all of a user's subscriptions, dropping any the browser has
// expired (HTTP 404/410). VAPID keys are resolved/auto-generated in ../vapid.

let initialized = false;

function init(): void {
  if (initialized) return;
  const keys = ensureVapidKeys();
  webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
  initialized = true;
}

/** True if the user has at least one registered device. */
export function hasPushSubs(userId: string): boolean {
  return listPushSubs(userId).length > 0;
}

/** Send to all of a user's registered devices. No-op if they have none. */
export async function sendWebPush(msg: NotificationMessage, userId: string): Promise<void> {
  init();
  const subs = listPushSubs(userId);
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url: msg.url ?? '/',
    tag: 'selfparcel',
  });

  const errors: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          removePushSub(s.endpoint);
        } else {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }),
  );
  if (errors.length) throw new Error(errors.join('; '));
}

/** Generate a fresh VAPID keypair (used by `npm run gen:vapid`). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
