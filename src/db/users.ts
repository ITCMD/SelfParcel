import { randomUUID } from 'node:crypto';
import { db } from './index.js';

// User accounts. The first account created (local or OIDC) becomes admin.

export type UserRole = 'admin' | 'user';
export type UserSource = 'local' | 'oidc';

export interface UserRow {
  id: string;
  source: UserSource;
  oidc_sub: string | null;
  email: string | null;
  name: string | null;
  username: string | null;
  password_hash: string | null;
  password_salt: string | null;
  role: UserRole;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as {
      n: number;
    }
  ).n;
}

export function getUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as UserRow | undefined;
}

export function getUserByOidcSub(sub: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as
    | UserRow
    | undefined;
}

export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

/** Create a username/password user. The first user overall becomes admin. */
export function createLocalUser(input: {
  username: string;
  email?: string | null;
  name?: string | null;
  passwordHash: string;
  passwordSalt: string;
  role?: UserRole;
}): UserRow {
  const role: UserRole = input.role ?? (countUsers() === 0 ? 'admin' : 'user');
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, source, email, name, username, password_hash, password_salt, role)
     VALUES (@id, 'local', @email, @name, @username, @hash, @salt, @role)`,
  ).run({
    id,
    email: input.email ?? null,
    name: input.name ?? null,
    username: input.username,
    hash: input.passwordHash,
    salt: input.passwordSalt,
    role,
  });
  return getUserById(id)!;
}

/** Upsert an OIDC user, keyed by subject. First user overall becomes admin. */
export function upsertOidcUser(input: {
  sub: string;
  email?: string | null;
  name?: string | null;
}): UserRow {
  const existing = getUserByOidcSub(input.sub);
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ? WHERE id = ?').run(
      input.email ?? existing.email,
      input.name ?? existing.name,
      existing.id,
    );
    return getUserById(existing.id)!;
  }
  const role: UserRole = countUsers() === 0 ? 'admin' : 'user';
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, source, oidc_sub, email, name, role)
     VALUES (@id, 'oidc', @sub, @email, @name, @role)`,
  ).run({
    id,
    sub: input.sub,
    email: input.email ?? null,
    name: input.name ?? null,
    role,
  });
  return getUserById(id)!;
}

export function setUserRole(id: string, role: UserRole): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function setUserDisabled(id: string, disabled: boolean): void {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
}

export function setUserPassword(id: string, hash: string, salt: string): void {
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(
    hash,
    salt,
    id,
  );
}

export function touchLogin(id: string): void {
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteUser(id: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM package_shares WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_notify_settings WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_carrier_credentials WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
