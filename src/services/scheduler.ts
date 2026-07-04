import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { getSetting, setSetting } from '../db/settings.js';
import { refreshPackage } from './tracking.js';
import { purgeExpiredSessions } from '../auth/session.js';
import type { FastifyBaseLogger } from 'fastify';

// Background poller. Each tick refreshes due packages one at a time, with a bit
// of jitter between calls so scraped carriers don't see a burst that looks like
// a bot.

// The poller wakes up on this fixed short cadence; how often a given package is
// actually refreshed is governed by the admin-configurable interval below (a
// package is only "due" once it hasn't been checked for that long). Keeping the
// tick short means a changed interval - and freshly added packages - get picked
// up promptly without restarting the process.
const TICK_MS = 60_000;

const REFRESH_KEY = 'refresh.interval_minutes';

// Presets the UI offers, in minutes, most aggressive first.
export const REFRESH_INTERVAL_OPTIONS = [10, 30, 60, 180, 360, 720] as const;

// Fall back to the env default (MIN_REFRESH_MINUTES) when nothing is stored, so
// existing deployments keep their configured cadence until an admin picks one.
function defaultRefreshMinutes(): number {
  return Math.max(1, config.minRefreshMinutes);
}

/** How stale a package must be before the poller refreshes it, in minutes. */
export function getRefreshIntervalMinutes(): number {
  const raw = Number.parseInt(getSetting(REFRESH_KEY) ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultRefreshMinutes();
}

/** Persist a new refresh interval; only known presets are accepted. */
export function setRefreshIntervalMinutes(minutes: number): number {
  const valid = (REFRESH_INTERVAL_OPTIONS as readonly number[]).includes(minutes)
    ? minutes
    : REFRESH_INTERVAL_OPTIONS[0];
  setSetting(REFRESH_KEY, String(valid));
  return valid;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1500 + Math.floor(Math.random() * 3500); // 1.5-5s

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    purgeExpiredSessions();
    const due = repo.packagesDueForRefresh(getRefreshIntervalMinutes());
    if (due.length === 0) return;
    log.info({ count: due.length }, 'scheduler: refreshing due packages');
    for (const pkg of due) {
      const out = await refreshPackage(pkg);
      log.info(
        { id: pkg.id, carrier: pkg.carrier, ok: out.ok, newEvents: out.newEvents, error: out.error },
        'scheduler: refreshed package',
      );
      await sleep(jitter());
    }
  } catch (err) {
    log.error({ err }, 'scheduler tick failed');
  } finally {
    running = false;
  }
}

export function startScheduler(log: FastifyBaseLogger): void {
  // Run once shortly after boot, then wake on a fixed short cadence. The
  // per-package refresh interval is read fresh each tick, so it can change at
  // runtime without restarting the timer.
  setTimeout(() => void tick(log), 10_000);
  timer = setInterval(() => void tick(log), TICK_MS);
  log.info({ intervalMinutes: getRefreshIntervalMinutes() }, 'scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
