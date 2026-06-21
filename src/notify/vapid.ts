import webpush from 'web-push';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/settings.js';

// VAPID keypair resolution for Web Push. Order of precedence:
//   1. Env vars (VAPID_PUBLIC_KEY/PRIVATE_KEY) — explicit admin override.
//   2. Keys previously generated and persisted in the settings table.
//   3. Generate a fresh keypair and persist it.
// Because the DB lives on the mounted data volume, auto-generated keys survive
// restarts and redeploys, so existing browser subscriptions stay valid and push
// works with zero admin configuration.

const PUB_KEY = 'vapid:publicKey';
const PRIV_KEY = 'vapid:privateKey';

let cached: { publicKey: string; privateKey: string } | null = null;

/** Resolve VAPID keys, generating and persisting them on first use. */
export function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  if (cached) return cached;

  if (config.notify.webpush.publicKey && config.notify.webpush.privateKey) {
    cached = {
      publicKey: config.notify.webpush.publicKey,
      privateKey: config.notify.webpush.privateKey,
    };
    return cached;
  }

  const pub = getSetting(PUB_KEY);
  const priv = getSetting(PRIV_KEY);
  if (pub && priv) {
    cached = { publicKey: pub, privateKey: priv };
    return cached;
  }

  const keys = webpush.generateVAPIDKeys();
  setSetting(PUB_KEY, keys.publicKey);
  setSetting(PRIV_KEY, keys.privateKey);
  cached = keys;
  return keys;
}

export function vapidSubject(): string {
  return config.notify.webpush.subject || 'mailto:admin@example.com';
}

/** The public key the browser needs to subscribe. */
export function publicVapidKey(): string {
  return ensureVapidKeys().publicKey;
}
