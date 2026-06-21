import { request } from 'undici';
import { field, type NotificationChannel } from '../types.js';

// Generic webhook. Sends plain JSON by default, or Discord/Slack-shaped bodies
// so those work without a separate integration.

export const webhookChannel: NotificationChannel = {
  type: 'webhook',
  name: 'Webhook',
  fields: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://…' },
    {
      key: 'format',
      label: 'Payload format',
      type: 'select',
      options: [
        { value: 'json', label: 'JSON' },
        { value: 'discord', label: 'Discord' },
        { value: 'slack', label: 'Slack' },
      ],
    },
  ],
  validate: (c) => (field(c, 'url') ? null : 'A webhook URL is required'),

  async send(msg, c) {
    const text = msg.url ? `${msg.body}\n${msg.url}` : msg.body;
    let body: string;
    switch (field(c, 'format')) {
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

    const res = await request(field(c, 'url'), {
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
