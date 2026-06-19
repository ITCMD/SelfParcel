import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { refreshPackage } from './tracking.js';
import { purgeExpiredSessions } from '../auth/session.js';
import type { FastifyBaseLogger } from 'fastify';

// Background poller. Each tick refreshes due packages one at a time, with a bit
// of jitter between calls so scraped carriers don't see a burst that looks like
// a bot.

let timer: NodeJS.Timeout | null = null;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 1500 + Math.floor(Math.random() * 3500); // 1.5-5s

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    purgeExpiredSessions();
    const due = repo.packagesDueForRefresh(config.minRefreshMinutes);
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
  const intervalMs = Math.max(1, config.pollIntervalMinutes) * 60_000;
  // Run once shortly after boot, then on the configured interval.
  setTimeout(() => void tick(log), 10_000);
  timer = setInterval(() => void tick(log), intervalMs);
  log.info({ intervalMinutes: config.pollIntervalMinutes }, 'scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
