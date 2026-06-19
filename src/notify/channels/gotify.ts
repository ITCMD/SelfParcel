import { request } from 'undici';
import { config } from '../../config.js';
import { urgencyFor, type NotificationChannel } from '../types.js';

// Gotify: POST JSON to /message?token=APP_TOKEN on your Gotify server.
// Docs: https://gotify.net/docs/pushmsg

const PRIORITY = { low: 2, normal: 5, high: 8 } as const;

export const gotifyChannel: NotificationChannel = {
  id: 'gotify',
  name: 'Gotify',
  isConfigured: () => Boolean(config.notify.gotify.url && config.notify.gotify.token),

  async send(msg) {
    const base = config.notify.gotify.url.replace(/\/+$/, '');
    const url = `${base}/message?token=${encodeURIComponent(config.notify.gotify.token)}`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: msg.title,
        message: msg.url ? `${msg.body}\n\n${msg.url}` : msg.body,
        priority: PRIORITY[urgencyFor(msg.status)],
      }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`Gotify failed (${res.statusCode}): ${text}`);
    }
    await res.body.dump();
  },
};
