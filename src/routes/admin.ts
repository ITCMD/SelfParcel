import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAdmin } from '../auth/routes.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { isRegistrationOpen, setRegistrationOpen } from '../auth/local.js';
import {
  countAdmins,
  createLocalUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  listUsers,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  type UserRole,
} from '../db/users.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// Drop secrets before sending a user to the client.
function publicUser(u: ReturnType<typeof getUserById>) {
  if (!u) return null;
  return {
    id: u.id,
    source: u.source,
    username: u.username,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: Boolean(u.disabled),
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: listUsers().map(publicUser),
    mode: config.auth.mode,
  }));

  app.post<{ Body: { username?: string; password?: string; email?: string; role?: string } }>(
    '/api/admin/users',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (config.auth.mode === 'oidc') {
        return reply
          .code(409)
          .send({ error: 'In OIDC mode users are provisioned automatically on login' });
      }
      const username = (req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'user';
      if (!USERNAME_RE.test(username)) {
        return reply.code(400).send({ error: 'Invalid username' });
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
        email: (req.body?.email ?? '').trim() || null,
        passwordHash: hash,
        passwordSalt: salt,
        role,
      });
      return reply.code(201).send({ user: publicUser(user) });
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; disabled?: boolean } }>(
    '/api/admin/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const target = getUserById(req.params.id);
      if (!target) return reply.code(404).send({ error: 'User not found' });

      // Don't let a demote/disable remove the last remaining admin.
      const wouldRemoveAdmin =
        target.role === 'admin' &&
        !target.disabled &&
        ((req.body?.role && req.body.role !== 'admin') || req.body?.disabled === true);
      if (wouldRemoveAdmin && countAdmins() <= 1) {
        return reply.code(409).send({ error: 'Cannot remove the last admin' });
      }

      if (req.body?.role === 'admin' || req.body?.role === 'user') {
        setUserRole(target.id, req.body.role);
      }
      if (typeof req.body?.disabled === 'boolean') {
        setUserDisabled(target.id, req.body.disabled);
      }
      return { user: publicUser(getUserById(target.id)) };
    },
  );

  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/api/admin/users/:id/password',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const target = getUserById(req.params.id);
      if (!target) return reply.code(404).send({ error: 'User not found' });
      if (target.source !== 'local') {
        return reply.code(400).send({ error: 'Only local accounts have passwords' });
      }
      const password = req.body?.password ?? '';
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .code(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const { hash, salt } = await hashPassword(password);
      setUserPassword(target.id, hash, salt);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const target = getUserById(req.params.id);
      if (!target) return reply.code(404).send({ error: 'User not found' });
      if (target.role === 'admin' && !target.disabled && countAdmins() <= 1) {
        return reply.code(409).send({ error: 'Cannot delete the last admin' });
      }
      deleteUser(target.id);
      return { ok: true };
    },
  );

  app.get('/api/admin/registration', { preHandler: requireAdmin }, async () => ({
    open: isRegistrationOpen(),
  }));

  app.put<{ Body: { open?: boolean } }>(
    '/api/admin/registration',
    { preHandler: requireAdmin },
    async (req) => {
      setRegistrationOpen(Boolean(req.body?.open));
      return { open: isRegistrationOpen() };
    },
  );
}
