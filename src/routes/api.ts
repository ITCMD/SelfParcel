import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as repo from '../db/repo.js';
import { config } from '../config.js';
import { carrierName, carrierStatuses, has as carrierExists } from '../carriers/registry.js';
import { detectCarrier, normalizeTrackingNumber } from '../carriers/detect.js';
import { refreshById } from '../services/tracking.js';
import type { CarrierCode } from '../carriers/types.js';

// undefined = no scoping (auth off); otherwise the signed-in user's id.
function currentOwner(req: FastifyRequest): string | undefined {
  return config.auth.mode === 'none' ? undefined : req.user?.id ?? undefined;
}

// Fetch a package only if the caller may see it.
function accessiblePackage(req: FastifyRequest, id: number) {
  const pkg = repo.getPackage(id);
  if (!pkg) return undefined;
  const owner = currentOwner(req);
  if (owner !== undefined && pkg.owner_user_id !== owner) return undefined;
  return pkg;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/carriers', async () => carrierStatuses());

  // Carrier auto-detect for the add form.
  app.get<{ Querystring: { trackingNumber?: string } }>(
    '/api/detect',
    async (req) => {
      const tn = req.query.trackingNumber ?? '';
      return { carrier: detectCarrier(tn) };
    },
  );

  app.get<{ Querystring: { archived?: string } }>('/api/packages', async (req) => {
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const packages = repo.listPackages(includeArchived, currentOwner(req)).map((p) => ({
      ...p,
      carrierName: carrierName(p.carrier),
      eventCount: repo.getEvents(p.id).length,
    }));
    return { packages };
  });

  app.get<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const pkg = accessiblePackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    return {
      package: { ...pkg, carrierName: carrierName(pkg.carrier) },
      events: repo.getEvents(pkg.id),
    };
  });

  app.post<{ Body: { trackingNumber?: string; carrier?: string; label?: string } }>(
    '/api/packages',
    async (req, reply) => {
      const raw = (req.body?.trackingNumber ?? '').trim();
      if (!raw) return reply.code(400).send({ error: 'trackingNumber is required' });
      const trackingNumber = normalizeTrackingNumber(raw);

      let carrier = req.body?.carrier as CarrierCode | undefined;
      if (!carrier || !carrierExists(carrier)) {
        const detected = detectCarrier(trackingNumber);
        if (!detected) {
          return reply
            .code(400)
            .send({ error: 'Could not detect carrier, please choose one' });
        }
        carrier = detected;
      }

      const pkg = repo.addPackage({
        trackingNumber,
        carrier,
        label: req.body?.label?.trim() || null,
        ownerId: currentOwner(req) ?? null,
      });

      // Kick off the first fetch, but don't block the response on it.
      void refreshById(pkg.id);

      return reply.code(201).send({ package: { ...pkg, carrierName: carrierName(carrier) } });
    },
  );

  app.post<{ Params: { id: string } }>('/api/packages/:id/refresh', async (req, reply) => {
    const pkg = accessiblePackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    const outcome = await refreshById(pkg.id);
    return { outcome, events: repo.getEvents(pkg.id) };
  });

  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>(
    '/api/packages/:id/archive',
    async (req, reply) => {
      const pkg = accessiblePackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      repo.setArchived(pkg.id, req.body?.archived ?? true);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { notify?: boolean } }>(
    '/api/packages/:id/notify',
    async (req, reply) => {
      const pkg = accessiblePackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      repo.setNotify(pkg.id, req.body?.notify ?? true);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const pkg = accessiblePackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    repo.deletePackage(pkg.id);
    return { ok: true };
  });
}
