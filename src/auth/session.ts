import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getUserById, type UserRole } from '../db/users.js';

// SQLite-backed sessions. The cookie carries only a signed session id; user
// data lives server-side so sessions can be revoked. Role changes and disabling
// take effect on the next request since we re-read the users row each time.

export interface SessionUser {
  id: string;
  /** oidc_sub for OIDC users, the user id for local users. */
  sub: string;
  email: string | null;
  name: string | null;
  username: string | null;
  role: UserRole;
}

interface SessionRow {
  id: string;
  user_id: string | null;
  id_token: string | null;
  created_at: string;
  expires_at: string;
}

export function createSession(userId: string, idToken: string | null = null): string {
  const user = getUserById(userId);
  if (!user) throw new Error('createSession: unknown user');
  const id = randomUUID();
  const ttlMs = config.auth.sessionTtlHours * 3_600_000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, sub, email, name, id_token, expires_at)
     VALUES (@id, @user_id, @sub, @email, @name, @id_token, @expires_at)`,
  ).run({
    id,
    user_id: user.id,
    sub: user.oidc_sub ?? user.id,
    email: user.email,
    name: user.name,
    id_token: idToken,
    expires_at: expiresAt,
  });
  return id;
}

export function getSession(
  id: string | undefined | null,
): { user: SessionUser; idToken: string | null } | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    destroySession(id);
    return null;
  }
  if (!row.user_id) return null;

  const user = getUserById(row.user_id);
  // revoke if the user was deleted or disabled
  if (!user || user.disabled) {
    destroySession(id);
    return null;
  }

  return {
    user: {
      id: user.id,
      sub: user.oidc_sub ?? user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      role: user.role,
    },
    idToken: row.id_token,
  };
}

export function destroySession(id: string | undefined | null): void {
  if (!id) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function purgeExpiredSessions(): number {
  return db
    .prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`)
    .run().changes;
}
