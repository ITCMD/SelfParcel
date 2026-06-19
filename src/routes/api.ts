import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { carrierName, carrierStatuses, has as carrierExists } from '../carriers/registry.js';
import { detectCarrier, normalizeTrackingNumber } from '../carriers/detect.js';
import { refreshById } from '../services/tracking.js';
import type { CarrierCode } from '../carriers/types.js';

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
    const packages = repo.listPackages(includeArchived).map((p) => ({
      ...p,
      carrierName: carrierName(p.carrier),
      eventCount: repo.getEvents(p.id).length,
    }));
    return { packages };
  });

  app.get<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const pkg = repo.getPackage(id);
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    return {
      package: { ...pkg, carrierName: carrierName(pkg.carrier) },
      events: repo.getEvents(id),
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
      });

      // Kick off the first fetch, but don't block the response on it.
      void refreshById(pkg.id);

      return reply.code(201).send({ package: { ...pkg, carrierName: carrierName(carrier) } });
    },
  );

  app.post<{ Params: { id: string } }>('/api/packages/:id/refresh', async (req, reply) => {
    const id = Number(req.params.id);
    if (!repo.getPackage(id)) return reply.code(404).send({ error: 'Not found' });
    const outcome = await refreshById(id);
    return { outcome, events: repo.getEvents(id) };
  });

  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>(
    '/api/packages/:id/archive',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!repo.getPackage(id)) return reply.code(404).send({ error: 'Not found' });
      repo.setArchived(id, req.body?.archived ?? true);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { notify?: boolean } }>(
    '/api/packages/:id/notify',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!repo.getPackage(id)) return reply.code(404).send({ error: 'Not found' });
      repo.setNotify(id, req.body?.notify ?? true);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!repo.getPackage(id)) return reply.code(404).send({ error: 'Not found' });
    repo.deletePackage(id);
    return { ok: true };
  });
}
