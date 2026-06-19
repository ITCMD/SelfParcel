import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  addPushSub,
  countPushSubs,
  getUserChannels,
  getUserTrigger,
  removePushSub,
  saveUserNotify,
  type UserChannels,
} from '../db/notify.js';
import { channelStatuses, dispatch, infraStatus } from '../notify/index.js';
import { API_CARRIERS } from '../carriers/apiProviders.js';
import { carrierName } from '../carriers/registry.js';
import {
  deleteUserCredentials,
  listUserCredentialCarriers,
  setUserCredentials,
} from '../db/credentials.js';

// Per-user notification settings and carrier API keys.

// Works even with auth off: '' is the single implicit user.
function notifyUserId(req: FastifyRequest): string {
  return req.user?.id ?? '';
}

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  // ── Carrier API keys (per user) ─────────────────────────────────────────────
  // A carrier with keys uses its official API; without, it scrapes.
  app.get('/api/me/credentials', async (req) => {
    const uid = notifyUserId(req);
    const mine = new Map(listUserCredentialCarriers(uid).map((r) => [r.carrier, r.env]));
    return {
      carriers: API_CARRIERS.map((code) => ({
        code,
        name: carrierName(code),
        hasOwn: mine.has(code),
        env: mine.get(code) ?? null,
      })),
    };
  });

  app.put<{ Params: { carrier: string }; Body: { clientId?: string; clientSecret?: string; env?: string } }>(
    '/api/me/credentials/:carrier',
    async (req, reply) => {
      const carrier = req.params.carrier;
      if (!API_CARRIERS.includes(carrier)) {
        return reply.code(400).send({ error: 'That carrier has no API option' });
      }
      const clientId = (req.body?.clientId ?? '').trim();
      const clientSecret = (req.body?.clientSecret ?? '').trim();
      if (!clientId || !clientSecret) {
        return reply.code(400).send({ error: 'clientId and clientSecret are required' });
      }
      const env = req.body?.env === 'test' ? 'test' : 'production';
      setUserCredentials(notifyUserId(req), carrier, { clientId, clientSecret, env });
      return { ok: true };
    },
  );

  app.delete<{ Params: { carrier: string } }>('/api/me/credentials/:carrier', async (req) => {
    deleteUserCredentials(notifyUserId(req), req.params.carrier);
    return { ok: true };
  });

  // ── Notification settings (per user) ────────────────────────────────────────
  app.get('/api/me/notify', async (req) => {
    const uid = notifyUserId(req);
    return {
      trigger: getUserTrigger(uid),
      channels: getUserChannels(uid),
      statuses: channelStatuses(uid),
      infra: infraStatus(),
      pushSubscriptions: countPushSubs(uid),
    };
  });

  app.put<{ Body: Partial<UserChannels> & { trigger?: string } }>(
    '/api/me/notify',
    async (req) => {
      const uid = notifyUserId(req);
      const b = req.body ?? {};
      const fmt = b.webhookFormat;
      saveUserNotify(uid, {
        trigger: b.trigger,
        ntfyUrl: str(b.ntfyUrl),
        ntfyToken: str(b.ntfyToken),
        pushoverToken: str(b.pushoverToken),
        pushoverUser: str(b.pushoverUser),
        gotifyUrl: str(b.gotifyUrl),
        gotifyToken: str(b.gotifyToken),
        webhookUrl: str(b.webhookUrl),
        webhookFormat: fmt === 'discord' || fmt === 'slack' ? fmt : 'json',
        smtpTo: str(b.smtpTo),
        appriseUrls: str(b.appriseUrls),
      });
      return { ok: true };
    },
  );

  app.post('/api/me/notify/test', async (req) => {
    const uid = notifyUserId(req);
    return dispatch(
      {
        title: 'SelfParcel test',
        body: 'If you can read this, your notifications are working.',
        status: 'in_transit',
        tags: ['package'],
        url: config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/` : undefined,
      },
      uid,
    );
  });

  // ── Web Push ────────────────────────────────────────────────────────────────
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
      userId: notifyUserId(req),
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

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
