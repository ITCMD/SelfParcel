import { request } from 'undici';
import { urgencyFor, type NotificationChannel } from '../types.js';

// Gotify: POST JSON to /message?token=APP_TOKEN on your Gotify server.
// Docs: https://gotify.net/docs/pushmsg

const PRIORITY = { low: 2, normal: 5, high: 8 } as const;

export const gotifyChannel: NotificationChannel = {
  id: 'gotify',
  name: 'Gotify',
  isConfigured: (t) => Boolean(t.channels.gotifyUrl && t.channels.gotifyToken),

  async send(msg, t) {
    const base = t.channels.gotifyUrl.replace(/\/+$/, '');
    const url = `${base}/message?token=${encodeURIComponent(t.channels.gotifyToken)}`;
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
