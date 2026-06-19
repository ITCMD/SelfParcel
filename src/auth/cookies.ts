import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export const SESSION_COOKIE = 'sp_session';

export function cookieOpts(req: FastifyRequest, path: string, maxAgeSec: number) {
  return {
    path,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: req.protocol === 'https',
    signed: true,
    maxAge: maxAgeSec,
  };
}

// only allow local, non-protocol-relative paths to avoid open redirects
export function safeReturnTo(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }
  return '/';
}
