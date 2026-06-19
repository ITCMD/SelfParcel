import { request } from 'undici';
import { urgencyFor, type NotificationChannel } from '../types.js';

// ntfy: POST the body to the topic URL, metadata goes in headers.
// Docs: https://docs.ntfy.sh/publish/

const PRIORITY = { low: '2', normal: '3', high: '5' } as const;

export const ntfyChannel: NotificationChannel = {
  id: 'ntfy',
  name: 'ntfy',
  isConfigured: (t) => Boolean(t.channels.ntfyUrl),

  async send(msg, t) {
    const headers: Record<string, string> = {
      Title: encodeHeader(msg.title),
      Priority: PRIORITY[urgencyFor(msg.status)],
    };
    if (msg.tags?.length) headers.Tags = msg.tags.join(',');
    if (msg.url) headers.Click = msg.url;
    if (t.channels.ntfyToken) {
      headers.Authorization = `Bearer ${t.channels.ntfyToken}`;
    }

    const res = await request(t.channels.ntfyUrl, {
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
