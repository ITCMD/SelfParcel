import { request } from 'undici';
import type { NotificationChannel } from '../types.js';

// Generic webhook. Sends plain JSON by default, or Discord/Slack-shaped bodies
// so those work without a separate integration.

export const webhookChannel: NotificationChannel = {
  id: 'webhook',
  name: 'Webhook',
  isConfigured: (t) => Boolean(t.channels.webhookUrl),

  async send(msg, t) {
    const text = msg.url ? `${msg.body}\n${msg.url}` : msg.body;
    let body: string;
    switch (t.channels.webhookFormat) {
      case 'discord':
        body = JSON.stringify({ content: `**${msg.title}**\n${text}` });
        break;
      case 'slack':
        body = JSON.stringify({ text: `*${msg.title}*\n${text}` });
        break;
      default:
        body = JSON.stringify({
          title: msg.title,
          message: msg.body,
          status: msg.status ?? null,
          url: msg.url ?? null,
          tags: msg.tags ?? [],
        });
    }

    const res = await request(t.channels.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.statusCode >= 300) {
      const t = await res.body.text();
      throw new Error(`Webhook failed (${res.statusCode}): ${t}`);
    }
    await res.body.dump();
  },
};
