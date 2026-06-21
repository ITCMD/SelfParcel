import { request } from 'undici';
import { field, urgencyFor, type NotificationChannel } from '../types.js';

// Apprise bridge: POST the target service URLs to an Apprise API /notify
// endpoint. One integration gets you Telegram, Discord, Matrix, Pushover, email,
// and dozens more. The Apprise instance is supplied per channel, so each user
// can point at their own. Docs: https://github.com/caronc/apprise-api

const TYPE = { low: 'info', normal: 'success', high: 'warning' } as const;

export const appriseChannel: NotificationChannel = {
  type: 'apprise',
  name: 'Apprise',
  fields: [
    {
      key: 'apiUrl',
      label: 'Apprise API URL',
      type: 'url',
      required: true,
      placeholder: 'http://apprise:8000/notify',
      hint: 'Your own Apprise API endpoint (the /notify route).',
    },
    {
      key: 'urls',
      label: 'Target URLs',
      type: 'textarea',
      required: true,
      placeholder: 'ntfy://…, pushover://…, tgram://…',
      hint: 'Comma-separated Apprise service URLs.',
    },
  ],
  validate: (c) => {
    if (!field(c, 'apiUrl')) return 'An Apprise API URL is required';
    if (!field(c, 'urls')) return 'At least one target URL is required';
    return null;
  },

  async send(msg, c) {
    const urls = field(c, 'urls')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    const res = await request(field(c, 'apiUrl'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: urls.join(','),
        title: msg.title,
        body: msg.url ? `${msg.body}\n${msg.url}` : msg.body,
        type: TYPE[urgencyFor(msg.status)],
      }),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`Apprise failed (${res.statusCode}): ${text}`);
    }
    await res.body.dump();
  },
};
