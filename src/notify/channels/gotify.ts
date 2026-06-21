import { request } from 'undici';
import { field, urgencyFor, type NotificationChannel } from '../types.js';

// Gotify: POST JSON to /message?token=APP_TOKEN on your Gotify server.
// Docs: https://gotify.net/docs/pushmsg

const PRIORITY = { low: 2, normal: 5, high: 8 } as const;

export const gotifyChannel: NotificationChannel = {
  type: 'gotify',
  name: 'Gotify',
  fields: [
    { key: 'url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://gotify.example.com' },
    { key: 'token', label: 'App token', type: 'password', required: true },
  ],
  validate: (c) =>
    field(c, 'url') && field(c, 'token') ? null : 'Server URL and app token are required',

  async send(msg, c) {
    const base = field(c, 'url').replace(/\/+$/, '');
    const url = `${base}/message?token=${encodeURIComponent(field(c, 'token'))}`;
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
