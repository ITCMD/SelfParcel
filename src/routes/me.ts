import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  addPushSub,
  addUserNotifyChannel,
  countPushSubs,
  deleteUserNotifyChannel,
  getUserNotifyChannel,
  getUserTrigger,
  listUserNotifyChannels,
  removePushSub,
  saveUserTrigger,
  updateUserNotifyChannel,
} from '../db/notify.js';
import {
  channelTypeMeta,
  getChannelType,
  sendViaChannel,
  validateChannelConfig,
} from '../notify/index.js';
import { smtpRelayConfigured } from '../notify/channels/smtp.js';
import { publicVapidKey } from '../notify/vapid.js';
import { API_CARRIERS, getApiProvider } from '../carriers/apiProviders.js';
import { carrierName } from '../carriers/registry.js';
import {
  deleteUserCredentials,
  getUserCredentials,
  listUserCredentialCarriers,
  setUserCredentials,
} from '../db/credentials.js';
import { generateApiKey, listApiKeys, revokeApiKey } from '../db/apiKeys.js';

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

  // Authenticate against the carrier's API to confirm a key pair works. Uses the
  // values from the request body if given (test before saving), else the keys
  // already on file. Never persists anything.
  app.post<{ Params: { carrier: string }; Body: { clientId?: string; clientSecret?: string; env?: string } }>(
    '/api/me/credentials/:carrier/test',
    async (req, reply) => {
      const carrier = req.params.carrier;
      const provider = getApiProvider(carrier);
      if (!provider) return reply.code(400).send({ error: 'That carrier has no API option' });

      const clientId = (req.body?.clientId ?? '').trim();
      const clientSecret = (req.body?.clientSecret ?? '').trim();
      const env: 'production' | 'test' = req.body?.env === 'test' ? 'test' : 'production';
      const creds =
        clientId && clientSecret
          ? { clientId, clientSecret, env }
          : getUserCredentials(notifyUserId(req), carrier);
      if (!creds) {
        return reply.code(400).send({ error: 'Enter or save a Client ID and secret first' });
      }

      try {
        await provider.verify(creds);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: message });
      }
    },
  );

  // ── Notification settings (per user) ────────────────────────────────────────
  // Returns the user's trigger, their channel instances, and the type catalog
  // the UI needs to render the "add a notification" dropdown and its fields.
  app.get('/api/me/notify', async (req) => {
    const uid = notifyUserId(req);
    return {
      trigger: getUserTrigger(uid),
      channels: listUserNotifyChannels(uid),
      types: channelTypeMeta(),
      smtpRelay: smtpRelayConfigured(),
      pushSubscriptions: countPushSubs(uid),
    };
  });

  app.put<{ Body: { trigger?: string } }>('/api/me/notify/trigger', async (req) => {
    const t = req.body?.trigger;
    if (typeof t === 'string') saveUserTrigger(notifyUserId(req), t);
    return { ok: true };
  });

  // ── Channel instances (add / edit / remove / test) ──────────────────────────
  app.post<{ Body: { type?: string; label?: string; config?: Record<string, string>; enabled?: boolean } }>(
    '/api/me/notify/channels',
    async (req, reply) => {
      const type = (req.body?.type ?? '').trim();
      if (!getChannelType(type)) return reply.code(400).send({ error: 'Unknown notification type' });
      const cfg = cleanConfig(req.body?.config);
      const err = validateChannelConfig(type, cfg);
      if (err) return reply.code(400).send({ error: err });
      const channel = addUserNotifyChannel(notifyUserId(req), {
        type,
        label: req.body?.label,
        config: cfg,
        enabled: req.body?.enabled ?? true,
      });
      return reply.code(201).send({ channel });
    },
  );

  app.put<{ Params: { id: string }; Body: { label?: string; config?: Record<string, string>; enabled?: boolean } }>(
    '/api/me/notify/channels/:id',
    async (req, reply) => {
      const uid = notifyUserId(req);
      const existing = getUserNotifyChannel(uid, Number(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'Channel not found' });
      const cfg = req.body?.config !== undefined ? cleanConfig(req.body.config) : undefined;
      if (cfg) {
        const err = validateChannelConfig(existing.type, cfg);
        if (err) return reply.code(400).send({ error: err });
      }
      const channel = updateUserNotifyChannel(uid, existing.id, {
        label: req.body?.label,
        config: cfg,
        enabled: req.body?.enabled,
      });
      return { channel };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/me/notify/channels/:id', async (req) => {
    deleteUserNotifyChannel(notifyUserId(req), Number(req.params.id));
    return { ok: true };
  });

  // Send a test through a saved channel, or through an unsaved type+config so
  // the user can verify before adding it.
  app.post<{
    Params: { id: string };
    Body: { type?: string; config?: Record<string, string> };
  }>('/api/me/notify/channels/:id/test', async (req, reply) => {
    const uid = notifyUserId(req);
    let type: string | undefined;
    let cfg: Record<string, string> | undefined;

    if (req.params.id === 'new') {
      type = (req.body?.type ?? '').trim();
      cfg = cleanConfig(req.body?.config);
    } else {
      const existing = getUserNotifyChannel(uid, Number(req.params.id));
      if (!existing) return reply.code(404).send({ error: 'Channel not found' });
      type = existing.type;
      cfg = existing.config;
    }

    try {
      await sendViaChannel(type!, cfg!, {
        title: 'SelfParcel test',
        body: 'If you can read this, this channel is working.',
        status: 'in_transit',
        tags: ['package'],
        url: config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/` : undefined,
      });
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Web Push ────────────────────────────────────────────────────────────────
  app.get('/api/push/key', async () => ({ publicKey: publicVapidKey() }));

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

  // ── REST API keys (per user) ────────────────────────────────────────────────
  // Keys authenticate the public /api/v1 endpoints. The plaintext is only ever
  // returned once, at creation.
  app.get('/api/me/api-keys', async (req) => ({ keys: listApiKeys(notifyUserId(req)) }));

  app.post<{ Body: { name?: string } }>('/api/me/api-keys', async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (name.length > 60) return reply.code(400).send({ error: 'name is too long' });
    return reply.code(201).send({ key: generateApiKey(notifyUserId(req), name) });
  });

  app.delete<{ Params: { id: string } }>('/api/me/api-keys/:id', async (req, reply) => {
    if (!revokeApiKey(notifyUserId(req), req.params.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return { ok: true };
  });
}

// Keep only string fields, trimmed. Channel configs are flat string maps.
function cleanConfig(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v.trim();
    }
  }
  return out;
}
