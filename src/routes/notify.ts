import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { channelStatuses, dispatch } from '../notify/index.js';
import {
  addPushSub,
  countPushSubs,
  getTriggerMode,
  removePushSub,
  setTriggerMode,
  type TriggerMode,
} from '../db/settings.js';

const TRIGGER_MODES: TriggerMode[] = [
  'status_change',
  'every_event',
  'delivered_exceptions',
];

export async function registerNotifyRoutes(app: FastifyInstance): Promise<void> {
  // Channel readiness and current settings for the UI.
  app.get('/api/notify/channels', async () => ({
    channels: channelStatuses(),
    trigger: getTriggerMode(),
    pushSubscriptions: countPushSubs(),
    webpushEnabled: Boolean(config.notify.webpush.publicKey),
  }));

  app.post<{ Body: { mode?: string } }>('/api/notify/trigger', async (req, reply) => {
    const mode = req.body?.mode as TriggerMode;
    if (!TRIGGER_MODES.includes(mode)) {
      return reply.code(400).send({ error: 'Invalid trigger mode' });
    }
    setTriggerMode(mode);
    return { ok: true, trigger: mode };
  });

  // Send a test notification to every configured channel.
  app.post('/api/notify/test', async () => {
    const result = await dispatch({
      title: 'SelfParcel test',
      body: 'If you can read this, notifications are working.',
      status: 'in_transit',
      tags: ['package'],
      url: config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/` : undefined,
    });
    return result;
  });

  // Web Push
  app.get('/api/push/key', async () => ({
    publicKey: config.notify.webpush.publicKey || null,
  }));

  app.post<{
    Body: {
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      label?: string;
    };
  }>('/api/push/subscribe', async (req, reply) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: 'Invalid subscription' });
    }
    addPushSub({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      label: req.body?.label ?? null,
    });
    return reply.code(201).send({ ok: true });
  });

  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req, reply) => {
    if (!req.body?.endpoint) return reply.code(400).send({ error: 'endpoint required' });
    removePushSub(req.body.endpoint);
    return { ok: true };
  });
}
