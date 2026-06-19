import { config } from '../config.js';
import { getUserCredentials } from '../db/credentials.js';
import type { CarrierCredentials } from './types.js';

// Carriers whose providers take API credentials (the native OAuth ones).
export const CREDENTIAL_CARRIERS = ['ups', 'fedex'] as const;
export type CredentialCarrier = (typeof CREDENTIAL_CARRIERS)[number];

export function isCredentialCarrier(code: string): code is CredentialCarrier {
  return (CREDENTIAL_CARRIERS as readonly string[]).includes(code);
}

function envDefault(carrier: CredentialCarrier): CarrierCredentials | undefined {
  const c = carrier === 'ups' ? config.ups : config.fedex;
  if (!c.clientId || !c.clientSecret) return undefined;
  return { clientId: c.clientId, clientSecret: c.clientSecret, env: c.env };
}

/**
 * Resolve which credentials a fetch should use: the owner's saved keys first,
 * then the .env defaults. Returns undefined if neither is set.
 */
export function resolveCredentials(
  carrier: string,
  ownerUserId: string | null,
): CarrierCredentials | undefined {
  if (!isCredentialCarrier(carrier)) return undefined;
  if (ownerUserId) {
    const own = getUserCredentials(ownerUserId, carrier);
    if (own) return own;
  }
  return envDefault(carrier);
}
