import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './index.js';

// Per-user API keys for the REST API. We store only a SHA-256 hash of the key
// (the key is high-entropy random, so a fast hash is enough — no slow KDF
// needed). The plaintext is returned once, at creation, and never again.

const KEY_PREFIX = 'sp_';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Public shape (never includes the hash). */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function toInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * Create a key for a user. Returns the info row plus the one-time plaintext
 * `key` (shown to the user once; only its hash is persisted).
 */
export function generateApiKey(userId: string, name: string): ApiKeyInfo & { key: string } {
  const secret = randomBytes(24).toString('base64url'); // 32 url-safe chars
  const key = `${KEY_PREFIX}${secret}`;
  const id = randomUUID();
  const prefix = key.slice(0, 11); // e.g. "sp_AbC123de" — safe to display
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, prefix)
     VALUES (@id, @user_id, @name, @key_hash, @prefix)`,
  ).run({ id, user_id: userId, name, key_hash: hashKey(key), prefix });
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow;
  return { ...toInfo(row), key };
}

export function listApiKeys(userId: string): ApiKeyInfo[] {
  return (
    db
      .prepare(
        `SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(userId) as ApiKeyRow[]
  ).map(toInfo);
}

/** Soft-revoke a key the user owns. Returns true if a key was revoked. */
export function revokeApiKey(userId: string, id: string): boolean {
  const res = db
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now')
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(id, userId);
  return res.changes > 0;
}

/**
 * Resolve a presented key to its owner's user id, or null if unknown/revoked.
 * Records last-used time as a side effect.
 */
export function resolveApiKey(plaintext: string): string | null {
  if (!plaintext.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(hashKey(plaintext)) as ApiKeyRow | undefined;
  if (!row) return null;
  db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row.user_id;
}
