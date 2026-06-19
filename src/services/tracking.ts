import { getProvider } from '../carriers/registry.js';
import { getApiProvider, hasApiProvider } from '../carriers/apiProviders.js';
import { getUserCredentials } from '../db/credentials.js';
import { NotFoundError } from '../carriers/types.js';
import * as repo from '../db/repo.js';
import type { PackageRow } from '../db/repo.js';
import { config } from '../config.js';
import { getUserTrigger } from '../db/notify.js';
import { listShares } from '../db/shares.js';
import { buildMessage, dispatch, shouldNotify } from '../notify/index.js';

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
  try {
    // If the owner has API keys for this carrier, use the official API;
    // otherwise fall back to the scraper module.
    const creds = hasApiProvider(pkg.carrier)
      ? getUserCredentials(pkg.owner_user_id, pkg.carrier)
      : undefined;
    const result =
      creds && hasApiProvider(pkg.carrier)
        ? await getApiProvider(pkg.carrier)!.track(pkg.tracking_number, creds)
        : await getProvider(pkg.carrier).track(pkg.tracking_number);
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

  // Notify the owner and everyone the package is shared with, each via their
  // own trigger preference and channels.
  const recipients = new Set<string>([pkg.owner_user_id]);
  for (const s of listShares(pkg.id)) recipients.add(s.userId);

  const msg = buildMessage(pkg, ctx.newStatus, ctx.latestEvent);
  let notified = false;

  for (const userId of recipients) {
    const wanted = shouldNotify(getUserTrigger(userId), {
      statusChanged: ctx.statusChanged,
      newStatus: ctx.newStatus,
      newEvents: ctx.newEvents,
    });
    if (!wanted) continue;
    await dispatch(msg, userId);
    notified = true;
  }
  return notified;
}

export async function refreshById(id: number): Promise<RefreshOutcome> {
  const pkg = repo.getPackage(id);
  if (!pkg) return { ok: false, newEvents: 0, error: 'Package not found' };
  return refreshPackage(pkg);
}
