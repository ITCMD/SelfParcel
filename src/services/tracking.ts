import { getProvider } from '../carriers/registry.js';
import { resolveCredentials } from '../carriers/credentials.js';
import { NotFoundError } from '../carriers/types.js';
import * as repo from '../db/repo.js';
import type { PackageRow } from '../db/repo.js';
import { config } from '../config.js';
import { getTriggerMode } from '../db/settings.js';
import {
  anyChannelConfigured,
  buildMessage,
  dispatch,
  shouldNotify,
} from '../notify/index.js';

// Runs a single package refresh: call the provider, persist the result, fire
// notifications if warranted, and report what changed.

export interface RefreshOutcome {
  ok: boolean;
  newEvents: number;
  status?: string;
  notified?: boolean;
  error?: string;
}

export async function refreshPackage(pkg: PackageRow): Promise<RefreshOutcome> {
  const provider = getProvider(pkg.carrier);
  try {
    // Use the owner's saved keys, falling back to .env.
    const creds = resolveCredentials(pkg.carrier, pkg.owner_user_id);
    const result = await provider.track(pkg.tracking_number, creds);
    const previousStatus = pkg.status;
    const isFirstFetch = pkg.last_checked_at === null;
    const { newEvents } = repo.applyResult(pkg.id, result);

    const notified = await maybeNotify(pkg, {
      newStatus: result.status,
      statusChanged: result.status !== previousStatus,
      newEvents,
      isFirstFetch,
      latestEvent: result.events[0],
    });

    return { ok: true, newEvents, status: result.status, notified };
  } catch (err) {
    const message =
      err instanceof NotFoundError
        ? `Not found yet: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    repo.recordError(pkg.id, message);
    return { ok: false, newEvents: 0, error: message };
  }
}

async function maybeNotify(
  pkg: PackageRow,
  ctx: {
    newStatus: import('../carriers/types.js').TrackStatus;
    statusChanged: boolean;
    newEvents: number;
    isFirstFetch: boolean;
    latestEvent?: { description: string; location?: string };
  },
): Promise<boolean> {
  if (pkg.notify === 0) return false; // muted for this package
  if (ctx.isFirstFetch && !config.notify.onFirstFetch) return false;
  if (!anyChannelConfigured()) return false;

  if (
    !shouldNotify(getTriggerMode(), {
      statusChanged: ctx.statusChanged,
      newStatus: ctx.newStatus,
      newEvents: ctx.newEvents,
    })
  ) {
    return false;
  }

  const msg = buildMessage(pkg, ctx.newStatus, ctx.latestEvent);
  await dispatch(msg);
  return true;
}

export async function refreshById(id: number): Promise<RefreshOutcome> {
  const pkg = repo.getPackage(id);
  if (!pkg) return { ok: false, newEvents: 0, error: 'Package not found' };
  return refreshPackage(pkg);
}
