import { request } from 'undici';
import { config } from '../../config.js';
import { urgencyFor, type NotificationChannel } from '../types.js';

// Pushover: POST form-encoded to the messages endpoint.
// Docs: https://pushover.net/api

const PRIORITY = { low: '-1', normal: '0', high: '1' } as const;

export const pushoverChannel: NotificationChannel = {
  id: 'pushover',
  name: 'Pushover',
  isConfigured: () =>
    Boolean(config.notify.pushover.token && config.notify.pushover.user),

  async send(msg) {
    const form = new URLSearchParams({
      token: config.notify.pushover.token,
      user: config.notify.pushover.user,
      title: msg.title,
      message: msg.body,
      priority: PRIORITY[urgencyFor(msg.status)],
    });
    if (msg.url) form.set('url', msg.url);

    const res = await request('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`Pushover failed (${res.statusCode}): ${text}`);
    }
    await res.body.dump();
  },
};
