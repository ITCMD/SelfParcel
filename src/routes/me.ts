import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { carrierName } from '../carriers/registry.js';
import { CREDENTIAL_CARRIERS, isCredentialCarrier } from '../carriers/credentials.js';
import {
  deleteUserCredentials,
  listUserCredentialCarriers,
  setUserCredentials,
} from '../db/credentials.js';

// Per-user carrier API keys. Each user's keys are used for their own packages,
// with the .env defaults as fallback.

function requireUser(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(400).send({ error: 'Sign in to manage your own keys' });
    return null;
  }
  return req.user.id;
}

function globalConfigured(carrier: string): boolean {
  const c = carrier === 'ups' ? config.ups : config.fedex;
  return Boolean(c.clientId && c.clientSecret);
}

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/credentials', async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const mine = new Map(listUserCredentialCarriers(userId).map((r) => [r.carrier, r.env]));
    return {
      carriers: CREDENTIAL_CARRIERS.map((code) => ({
        code,
        name: carrierName(code),
        hasOwn: mine.has(code),
        env: mine.get(code) ?? null,
        hasGlobalFallback: globalConfigured(code),
      })),
    };
  });

  app.put<{
    Params: { carrier: string };
    Body: { clientId?: string; clientSecret?: string; env?: string };
  }>('/api/me/credentials/:carrier', async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const carrier = req.params.carrier;
    if (!isCredentialCarrier(carrier)) {
      return reply.code(400).send({ error: 'Unknown carrier' });
    }
    const clientId = (req.body?.clientId ?? '').trim();
    const clientSecret = (req.body?.clientSecret ?? '').trim();
    if (!clientId || !clientSecret) {
      return reply.code(400).send({ error: 'clientId and clientSecret are required' });
    }
    const env = req.body?.env === 'test' ? 'test' : 'production';
    setUserCredentials(userId, carrier, { clientId, clientSecret, env });
    return { ok: true };
  });

  app.delete<{ Params: { carrier: string } }>(
    '/api/me/credentials/:carrier',
    async (req, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;
      deleteUserCredentials(userId, req.params.carrier);
      return { ok: true };
    },
  );
}
