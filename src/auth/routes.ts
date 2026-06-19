import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  beginLogin,
  completeLogin,
  buildLogoutUrl,
  isAuthConfigured,
  UserNotAllowedError,
} from './oidc.js';
import { createSession, destroySession, getSession, type SessionUser } from './session.js';
import { upsertOidcUser } from '../db/users.js';
import { SESSION_COOKIE, cookieOpts, safeReturnTo } from './cookies.js';

const FLOW_COOKIE = 'sp_oidc';

// API paths reachable without a session; everything else under /api/ is gated
const PUBLIC_API = new Set(['/api/health']);

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

function callbackUrl(req: FastifyRequest): string {
  if (config.auth.redirectUri) return config.auth.redirectUri;
  return `${req.protocol}://${req.hostname}/auth/callback`;
}

function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.hostname}/`;
}

// Resolves req.user from the cookie on every request. When auth is on, the API
// returns 401 for unauthenticated calls; the app shell and /auth/* stay open so
// the client can render the login UI.
export function registerAuthGuard(app: FastifyInstance): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    const unsigned = req.unsignCookie(req.cookies[SESSION_COOKIE] ?? '');
    const session = unsigned.valid ? getSession(unsigned.value) : null;
    req.user = session?.user ?? null;

    if (config.auth.mode === 'none') return;
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return; // shell + auth endpoints are public
    if (PUBLIC_API.has(path)) return;
    if (req.user) return;
    return reply.code(401).send({ error: 'Authentication required' });
  });
}

/** preHandler for admin-only routes. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (config.auth.mode === 'none') return;
  if (!req.user) return reply.code(401).send({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // polled by the UI to render the account area + admin controls
  app.get('/auth/me', async (req) => ({
    mode: config.auth.mode,
    authenticated: Boolean(req.user),
    user: req.user,
    isAdmin: req.user?.role === 'admin',
  }));

  app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
    if (config.auth.mode !== 'oidc') return reply.redirect('/');
    if (req.user) return reply.redirect(safeReturnTo(req.query.returnTo));

    const pending = await beginLogin(callbackUrl(req));
    reply.setCookie(
      FLOW_COOKIE,
      JSON.stringify({
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
        returnTo: safeReturnTo(req.query.returnTo),
      }),
      cookieOpts(req, '/auth', 600),
    );
    return reply.redirect(pending.authorizationUrl);
  });

  app.get('/auth/callback', async (req, reply) => {
    if (config.auth.mode !== 'oidc') return reply.redirect('/');

    const raw = req.unsignCookie(req.cookies[FLOW_COOKIE] ?? '');
    if (!raw.valid || !raw.value) {
      return reply.code(400).send({ error: 'Login session expired, please try again' });
    }
    reply.clearCookie(FLOW_COOKIE, { path: '/auth' });

    let flow: { state: string; nonce: string; codeVerifier: string; returnTo: string };
    try {
      flow = JSON.parse(raw.value);
    } catch {
      return reply.code(400).send({ error: 'Malformed login state' });
    }

    const currentUrl = new URL(`${req.protocol}://${req.hostname}${req.url}`);
    try {
      const { identity, idToken } = await completeLogin(currentUrl, {
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      });
      // upsert the user row (first user becomes admin), then create the session
      const user = upsertOidcUser(identity);
      const sessionId = createSession(user.id, idToken);
      reply.setCookie(
        SESSION_COOKIE,
        sessionId,
        cookieOpts(req, '/', config.auth.sessionTtlHours * 3600),
      );
      return reply.redirect(safeReturnTo(flow.returnTo));
    } catch (err) {
      if (err instanceof UserNotAllowedError) {
        return reply.code(403).send({ error: err.message });
      }
      req.log.error({ err }, 'OIDC callback failed');
      return reply.code(400).send({ error: 'Sign-in failed' });
    }
  });

  app.get('/auth/logout', async (req, reply) => {
    const unsigned = req.unsignCookie(req.cookies[SESSION_COOKIE] ?? '');
    const session = unsigned.valid ? getSession(unsigned.value) : null;
    if (unsigned.valid) destroySession(unsigned.value);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });

    // OIDC tries RP-initiated logout; local/none just goes home
    if (config.auth.mode === 'oidc') {
      const postLogout = config.auth.postLogoutRedirectUri || baseUrl(req);
      const providerLogout = await buildLogoutUrl(session?.idToken ?? null, postLogout);
      return reply.redirect(providerLogout ?? '/');
    }
    return reply.redirect('/');
  });
}

export { isAuthConfigured };
