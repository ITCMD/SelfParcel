import { db } from './index.js';

// Package sharing: an owner grants other users read + refresh on a package.

export interface ShareUser {
  userId: string;
  username: string | null;
}

export function listShares(packageId: number): ShareUser[] {
  return db
    .prepare(
      `SELECT s.user_id AS userId, u.username AS username
       FROM package_shares s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.package_id = ?
       ORDER BY s.created_at DESC`,
    )
    .all(packageId) as ShareUser[];
}

export function isSharedWith(packageId: number, userId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM package_shares WHERE package_id = ? AND user_id = ?')
      .get(packageId, userId),
  );
}

export function shareCount(packageId: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM package_shares WHERE package_id = ?')
      .get(packageId) as { n: number }
  ).n;
}

export function addShare(packageId: number, userId: string): void {
  db.prepare(
    `INSERT INTO package_shares (package_id, user_id) VALUES (?, ?)
     ON CONFLICT (package_id, user_id) DO UPDATE SET created_at = datetime('now')`,
  ).run(packageId, userId);
}

export function removeShare(packageId: number, userId: string): void {
  db.prepare('DELETE FROM package_shares WHERE package_id = ? AND user_id = ?').run(
    packageId,
    userId,
  );
}

/**
 * Users the owner can share with, most-recently-shared first. Excludes the
 * owner and disabled accounts; optional name filter.
 */
export function shareCandidates(
  ownerId: string,
  q = '',
  limit = 20,
): { id: string; username: string | null; lastShared: string | null }[] {
  const like = `%${q.toLowerCase()}%`;
  return db
    .prepare(
      `SELECT u.id AS id, u.username AS username,
              (SELECT MAX(s.created_at)
                 FROM package_shares s
                 JOIN packages p ON p.id = s.package_id
                WHERE p.owner_user_id = @owner AND s.user_id = u.id) AS lastShared
       FROM users u
       WHERE u.id != @owner AND u.disabled = 0
         AND (@q = '' OR LOWER(COALESCE(u.username, '')) LIKE @like
              OR LOWER(COALESCE(u.email, '')) LIKE @like)
       ORDER BY lastShared DESC, u.username ASC
       LIMIT @limit`,
    )
    .all({ owner: ownerId, q: q.toLowerCase(), like, limit }) as {
    id: string;
    username: string | null;
    lastShared: string | null;
  }[];
}
