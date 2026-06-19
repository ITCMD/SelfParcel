import { request } from 'undici';
import { config } from '../../config.js';
import { urgencyFor, type NotificationChannel } from '../types.js';

// Apprise bridge: POST the target service URLs to a self-hosted Apprise API
// /notify endpoint. One integration gets you Telegram, Discord, Matrix,
// Pushover, email, and dozens more.
// Docs: https://github.com/caronc/apprise-api

const TYPE = { low: 'info', normal: 'success', high: 'warning' } as const;

export const appriseChannel: NotificationChannel = {
  id: 'apprise',
  name: 'Apprise',
  isConfigured: () =>
    Boolean(config.notify.apprise.apiUrl && config.notify.apprise.urls),

  async send(msg) {
    const urls = config.notify.apprise.urls
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    const res = await request(config.notify.apprise.apiUrl, {
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
