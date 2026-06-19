import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/settings.js';
import {
  countUsers,
  createLocalUser,
  getUserByUsername,
  touchLogin,
} from '../db/users.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import { createSession } from './session.js';
import { SESSION_COOKIE, cookieOpts } from './cookies.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export function isRegistrationOpen(): boolean {
  return getSetting('auth.open_registration') === '1';
}

export function setRegistrationOpen(open: boolean): void {
  setSetting('auth.open_registration', open ? '1' : '0');
}

export async function registerLocalAuthRoutes(app: FastifyInstance): Promise<void> {
  // public: lets the client pick the right login/registration UI
  app.get('/auth/config', async () => ({
    mode: config.auth.mode,
    hasUsers: countUsers() > 0,
    // first account can always self-register to bootstrap the admin
    openRegistration: countUsers() === 0 || isRegistrationOpen(),
  }));

  app.post<{ Body: { username?: string; password?: string } }>(
    '/auth/local-login',
    async (req, reply) => {
      if (config.auth.mode !== 'local') {
        return reply.code(404).send({ error: 'Local login is not enabled' });
      }
      const username = (req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      const user = username ? getUserByUsername(username) : undefined;
      // always run the hash comparison (verifyPassword handles null) so the
      // timing is the same for unknown user vs wrong password
      const ok = await verifyPassword(
        password,
        user?.password_hash ?? null,
        user?.password_salt ?? null,
      );
      if (!user || user.disabled || !ok) {
        return reply.code(401).send({ error: 'Invalid username or password' });
      }
      touchLogin(user.id);
      reply.setCookie(
        SESSION_COOKIE,
        createSession(user.id),
        cookieOpts(req, '/', config.auth.sessionTtlHours * 3600),
      );
      return { ok: true };
    },
  );

  app.post<{ Body: { username?: string; email?: string; password?: string } }>(
    '/auth/register',
    async (req, reply) => {
      if (config.auth.mode !== 'local') {
        return reply.code(404).send({ error: 'Registration is not enabled' });
      }
      const isFirst = countUsers() === 0;
      if (!isFirst && !isRegistrationOpen()) {
        return reply.code(403).send({ error: 'Registration is closed' });
      }

      const username = (req.body?.username ?? '').trim();
      const email = (req.body?.email ?? '').trim() || null;
      const password = req.body?.password ?? '';

      if (!USERNAME_RE.test(username)) {
        return reply
          .code(400)
          .send({ error: 'Username must be 3-32 chars (letters, numbers, . _ -)' });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .code(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      if (getUserByUsername(username)) {
        return reply.code(409).send({ error: 'That username is taken' });
      }

      const { hash, salt } = await hashPassword(password);
      const user = createLocalUser({
        username,
        email,
        passwordHash: hash,
        passwordSalt: salt,
      });
      reply.setCookie(
        SESSION_COOKIE,
        createSession(user.id),
        cookieOpts(req, '/', config.auth.sessionTtlHours * 3600),
      );
      return reply.code(201).send({ ok: true, admin: user.role === 'admin' });
    },
  );
}
