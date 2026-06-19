import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as repo from '../db/repo.js';
import { config } from '../config.js';
import { carrierName, carrierStatuses, has as carrierExists } from '../carriers/registry.js';
import { detectCarrier, normalizeTrackingNumber } from '../carriers/detect.js';
import { refreshById } from '../services/tracking.js';
import { getUserById } from '../db/users.js';
import {
  addShare,
  isSharedWith,
  listShares,
  removeShare,
  shareCandidates,
  shareCount,
} from '../db/shares.js';
import type { CarrierCode } from '../carriers/types.js';
import type { PackageRow } from '../db/repo.js';

const authOn = () => config.auth.mode !== 'none';

// undefined = no scoping (auth off); otherwise the signed-in user's id.
function currentOwner(req: FastifyRequest): string | undefined {
  return authOn() ? req.user?.id ?? undefined : undefined;
}

function canManage(req: FastifyRequest, pkg: PackageRow): boolean {
  return !authOn() || pkg.owner_user_id === req.user?.id;
}

function canView(req: FastifyRequest, pkg: PackageRow): boolean {
  if (canManage(req, pkg)) return true;
  return Boolean(req.user && isSharedWith(pkg.id, req.user.id));
}

// Package the caller may view (own or shared); undefined otherwise.
function viewablePackage(req: FastifyRequest, id: number) {
  const pkg = repo.getPackage(id);
  if (!pkg || !canView(req, pkg)) return undefined;
  return pkg;
}

// Package the caller owns; undefined otherwise.
function managedPackage(req: FastifyRequest, id: number) {
  const pkg = repo.getPackage(id);
  if (!pkg || !canManage(req, pkg)) return undefined;
  return pkg;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/carriers', async () => carrierStatuses());

  // Carrier auto-detect for the add form.
  app.get<{ Querystring: { trackingNumber?: string } }>('/api/detect', async (req) => {
    const tn = req.query.trackingNumber ?? '';
    return { carrier: detectCarrier(tn) };
  });

  app.get<{ Querystring: { archived?: string } }>('/api/packages', async (req) => {
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const uid = req.user?.id;
    const rows =
      authOn() && uid
        ? repo.listAccessiblePackages(uid, includeArchived)
        : repo.listPackages(includeArchived);

    const packages = rows.map((p) => {
      const owner = !authOn() || p.owner_user_id === uid;
      return {
        ...p,
        carrierName: carrierName(p.carrier),
        eventCount: repo.getEvents(p.id).length,
        isOwner: owner,
        canShare: owner && authOn(),
        sharedBy: owner ? null : getUserById(p.owner_user_id)?.username ?? 'another user',
        sharedCount: owner && authOn() ? shareCount(p.id) : 0,
      };
    });
    return { packages };
  });

  app.get<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const pkg = viewablePackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    return {
      package: {
        ...pkg,
        carrierName: carrierName(pkg.carrier),
        isOwner: canManage(req, pkg),
      },
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
          return reply.code(400).send({ error: 'Could not detect carrier, please choose one' });
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

  // Owner or a shared user may refresh (it uses the owner's keys regardless).
  app.post<{ Params: { id: string } }>('/api/packages/:id/refresh', async (req, reply) => {
    const pkg = viewablePackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    const outcome = await refreshById(pkg.id);
    return { outcome, events: repo.getEvents(pkg.id) };
  });

  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>(
    '/api/packages/:id/archive',
    async (req, reply) => {
      const pkg = managedPackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      repo.setArchived(pkg.id, req.body?.archived ?? true);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { notify?: boolean } }>(
    '/api/packages/:id/notify',
    async (req, reply) => {
      const pkg = managedPackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      repo.setNotify(pkg.id, req.body?.notify ?? true);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const pkg = managedPackage(req, Number(req.params.id));
    if (!pkg) return reply.code(404).send({ error: 'Not found' });
    repo.deletePackage(pkg.id);
    return { ok: true };
  });

  // ── Sharing ────────────────────────────────────────────────────────────────

  // Users to share with, recently-shared first.
  app.get<{ Querystring: { q?: string } }>('/api/share/candidates', async (req, reply) => {
    if (!req.user) return reply.code(400).send({ error: 'Sign in to share' });
    return { users: shareCandidates(req.user.id, (req.query.q ?? '').trim()) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/packages/:id/shares',
    async (req, reply) => {
      const pkg = managedPackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      return { shares: listShares(pkg.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/api/packages/:id/shares',
    async (req, reply) => {
      if (!req.user) return reply.code(400).send({ error: 'Sign in to share' });
      const pkg = managedPackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      const target = (req.body?.userId ?? '').trim();
      const user = target ? getUserById(target) : undefined;
      if (!user) return reply.code(404).send({ error: 'User not found' });
      if (user.id === pkg.owner_user_id) {
        return reply.code(400).send({ error: 'You already own this package' });
      }
      addShare(pkg.id, user.id);
      return reply.code(201).send({ shares: listShares(pkg.id) });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/packages/:id/shares/:userId',
    async (req, reply) => {
      const pkg = managedPackage(req, Number(req.params.id));
      if (!pkg) return reply.code(404).send({ error: 'Not found' });
      removeShare(pkg.id, req.params.userId);
      return { shares: listShares(pkg.id) };
    },
  );

  // A shared recipient removes the package from their own list.
  app.post<{ Params: { id: string } }>('/api/packages/:id/leave', async (req, reply) => {
    if (!req.user) return reply.code(400).send({ error: 'Not shared with you' });
    const pkg = repo.getPackage(Number(req.params.id));
    if (!pkg || !isSharedWith(pkg.id, req.user.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    removeShare(pkg.id, req.user.id);
    return { ok: true };
  });
}
