import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as repo from '../db/repo.js';
import { config } from '../config.js';
import { carrierName, has as carrierExists } from '../carriers/registry.js';
import { detectCarrier, normalizeTrackingNumber } from '../carriers/detect.js';
import { refreshById } from '../services/tracking.js';
import type { CarrierCode } from '../carriers/types.js';
import type { PackageRow } from '../db/repo.js';

// Public REST API (v1) for programmatic use with a per-user API key. Auth is
// handled upstream in the onRequest guard (cookie or API key), so a request
// reaching here is already attributed to req.user.

const authOn = () => config.auth.mode !== 'none';

// undefined = no scoping (auth off); otherwise the caller's user id.
function ownerScope(req: FastifyRequest): string | undefined {
  return authOn() ? req.user?.id ?? undefined : undefined;
}

function publicPackage(p: PackageRow) {
  return {
    id: p.id,
    name: p.label,
    trackingNumber: p.tracking_number,
    carrier: p.carrier,
    carrierName: carrierName(p.carrier),
    status: p.status,
    estimatedDelivery: p.est_delivery,
    lastRefreshed: p.last_checked_at,
  };
}

export async function registerApiV1Routes(app: FastifyInstance): Promise<void> {
  // Add a package: { trackingNumber, carrier?, name? }. Refreshes once so the
  // response carries a real status instead of "unknown".
  app.post<{ Body: { trackingNumber?: string; carrier?: string; name?: string } }>(
    '/api/v1/packages',
    async (req, reply) => {
      const raw = (req.body?.trackingNumber ?? '').trim();
      if (!raw) return reply.code(400).send({ error: 'trackingNumber is required' });
      const trackingNumber = normalizeTrackingNumber(raw);

      let carrier = req.body?.carrier as CarrierCode | undefined;
      if (carrier && !carrierExists(carrier)) {
        return reply.code(400).send({ error: `Unknown carrier: ${carrier}` });
      }
      if (!carrier) {
        const detected = detectCarrier(trackingNumber);
        if (!detected) {
          return reply
            .code(400)
            .send({ error: 'Could not detect carrier; pass "carrier" explicitly' });
        }
        carrier = detected;
      }

      const created = repo.addPackage({
        trackingNumber,
        carrier,
        label: req.body?.name?.trim() || null,
        ownerId: ownerScope(req) ?? null,
      });

      // Pull a first status before responding (errors are recorded, not thrown).
      await refreshById(created.id);
      const pkg = repo.getPackage(created.id) ?? created;
      return reply.code(201).send({ package: publicPackage(pkg) });
    },
  );

  // List the caller's packages.
  app.get<{ Querystring: { archived?: string } }>('/api/v1/packages', async (req) => {
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const rows = repo.listPackages(includeArchived, ownerScope(req));
    return { packages: rows.map(publicPackage) };
  });

  // Read one of the caller's packages.
  app.get<{ Params: { id: string } }>('/api/v1/packages/:id', async (req, reply) => {
    const pkg = repo.getPackage(Number(req.params.id));
    if (!pkg || (authOn() && pkg.owner_user_id !== req.user?.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return { package: publicPackage(pkg) };
  });
}
