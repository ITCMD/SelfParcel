import { request } from 'undici';
import { config } from '../../config.js';
import { urgencyFor, type NotificationChannel } from '../types.js';

// ntfy: POST the body to the topic URL, metadata goes in headers.
// Docs: https://docs.ntfy.sh/publish/

const PRIORITY = { low: '2', normal: '3', high: '5' } as const;

export const ntfyChannel: NotificationChannel = {
  id: 'ntfy',
  name: 'ntfy',
  isConfigured: () => Boolean(config.notify.ntfy.url),

  async send(msg) {
    const headers: Record<string, string> = {
      Title: encodeHeader(msg.title),
      Priority: PRIORITY[urgencyFor(msg.status)],
    };
    if (msg.tags?.length) headers.Tags = msg.tags.join(',');
    if (msg.url) headers.Click = msg.url;
    if (config.notify.ntfy.token) {
      headers.Authorization = `Bearer ${config.notify.ntfy.token}`;
    }

    const res = await request(config.notify.ntfy.url, {
      method: 'POST',
      headers,
      body: msg.body,
    });
    if (res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`ntfy failed (${res.statusCode}): ${text}`);
    }
    await res.body.dump();
  },
};

// ntfy headers must be ASCII, so non-ASCII titles get RFC 2047-style encoding.
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value;
}
