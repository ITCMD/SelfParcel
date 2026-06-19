import { db } from './index.js';
import type { CarrierCredentials } from '../carriers/types.js';

// Per-user carrier API credentials. UPS/FedEx only (the native API providers).

interface CredRow {
  user_id: string;
  carrier: string;
  client_id: string;
  client_secret: string;
  env: string | null;
}

export function getUserCredentials(
  userId: string,
  carrier: string,
): CarrierCredentials | undefined {
  const row = db
    .prepare('SELECT * FROM user_carrier_credentials WHERE user_id = ? AND carrier = ?')
    .get(userId, carrier) as CredRow | undefined;
  if (!row) return undefined;
  return {
    clientId: row.client_id,
    clientSecret: row.client_secret,
    env: (row.env as 'production' | 'test') || undefined,
  };
}

export function setUserCredentials(
  userId: string,
  carrier: string,
  creds: CarrierCredentials,
): void {
  db.prepare(
    `INSERT INTO user_carrier_credentials (user_id, carrier, client_id, client_secret, env, updated_at)
     VALUES (@user_id, @carrier, @client_id, @client_secret, @env, datetime('now'))
     ON CONFLICT (user_id, carrier) DO UPDATE SET
       client_id = excluded.client_id, client_secret = excluded.client_secret,
       env = excluded.env, updated_at = datetime('now')`,
  ).run({
    user_id: userId,
    carrier,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    env: creds.env ?? null,
  });
}

export function deleteUserCredentials(userId: string, carrier: string): void {
  db.prepare('DELETE FROM user_carrier_credentials WHERE user_id = ? AND carrier = ?').run(
    userId,
    carrier,
  );
}

/** Which carriers a user has keys for, plus the env. No secrets returned. */
export function listUserCredentialCarriers(
  userId: string,
): { carrier: string; env: string | null }[] {
  return db
    .prepare('SELECT carrier, env FROM user_carrier_credentials WHERE user_id = ?')
    .all(userId) as { carrier: string; env: string | null }[];
}
