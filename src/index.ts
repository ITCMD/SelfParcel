import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config } from './config.js';
import { migrate } from './db/index.js';
import { seedBuiltinModules } from './db/modules.js';
import { reloadModules } from './carriers/registry.js';
import { registerApiRoutes } from './routes/api.js';
import { registerNotifyRoutes } from './routes/notify.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerModuleRoutes } from './routes/modules.js';
import { registerAuthGuard, registerAuthRoutes } from './auth/routes.js';
import { registerLocalAuthRoutes } from './auth/local.js';
import { isAuthConfigured } from './auth/oidc.js';
import { purgeExpiredSessions } from './auth/session.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { closeBrowser } from './carriers/scraper/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  migrate();
  seedBuiltinModules();
  reloadModules();
  purgeExpiredSessions();

  // A chosen auth mode must be fully configured, or the app could come up
  // unprotected without anyone noticing.
  if (config.auth.mode === 'oidc' && !isAuthConfigured()) {
    throw new Error(
      'AUTH_MODE=oidc but OIDC is not fully configured. Set OIDC_ISSUER, ' +
        'OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and SESSION_SECRET.',
    );
  }
  if (config.auth.mode === 'local' && !config.auth.sessionSecret) {
    throw new Error('AUTH_MODE=local requires SESSION_SECRET to sign session cookies.');
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Honour X-Forwarded-* so OIDC redirects and secure cookies work behind a
    // reverse proxy.
    trustProxy: true,
  });

  // Signs the session/flow cookies. The plugin still wants a secret when auth
  // is disabled, so fall back to an ephemeral one.
  await app.register(fastifyCookie, {
    secret: config.auth.sessionSecret || randomBytes(32).toString('hex'),
  });

  registerAuthGuard(app);
  await registerAuthRoutes(app);
  await registerLocalAuthRoutes(app);
  await registerApiRoutes(app);
  await registerNotifyRoutes(app);
  await registerAdminRoutes(app);
  await registerModuleRoutes(app);

  // Static web UI. In dev it's under src/web/public; the build copies the same
  // files next to the compiled output.
  await app.register(fastifyStatic, {
    root: join(__dirname, 'web', 'public'),
    prefix: '/',
  });

  startScheduler(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    await closeBrowser();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
