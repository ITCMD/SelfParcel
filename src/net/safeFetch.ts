import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent, request, type Dispatcher } from 'undici';

// SSRF protection for any URL an admin or installed module controls (installing
// a module from a URL, a module's tracking fetch). To stop private-network
// access and DNS rebinding we resolve the host, reject private/loopback/etc
// addresses, then pin the connection to the vetted IP so the resolve/connect
// race can't be exploited. Redirects are followed manually and re-validated.

export class SsrfError extends Error {}

function ipv4IsPublic(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return false; // unspecified, private, loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return false; // IETF protocol
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

function ipv6IsPublic(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:1.2.3.4): validate the embedded v4
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPublic(mapped[1]);
  if (lower === '::1' || lower === '::') return false; // loopback, unspecified
  if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return false; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // ULA fc00::/7
  if (lower.startsWith('ff')) return false; // multicast
  return true;
}

function ipIsPublic(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4IsPublic(ip);
  if (fam === 6) return ipv6IsPublic(ip);
  return false;
}

// resolve a hostname (or accept an IP literal) and require every address to be public
async function resolvePublic(hostname: string): Promise<{ address: string; family: number }> {
  const literal = net.isIP(hostname);
  if (literal) {
    if (!ipIsPublic(hostname)) throw new SsrfError(`Blocked address: ${hostname}`);
    return { address: hostname, family: literal };
  }
  const addrs = await dnsLookup(hostname, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new SsrfError(`Could not resolve host: ${hostname}`);
  for (const a of addrs) {
    if (!ipIsPublic(a.address)) throw new SsrfError(`Blocked address: ${a.address} (${hostname})`);
  }
  return { address: addrs[0].address, family: addrs[0].family };
}

/** Check a URL is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(
  urlStr: string,
  opts: { requireHttps?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http(s) URLs are allowed');
  }
  if (opts.requireHttps && url.protocol !== 'https:') {
    throw new SsrfError('An https URL is required');
  }
  await resolvePublic(url.hostname);
  return url;
}

// undici dispatcher that forces DNS to the vetted IP so the socket can only
// connect to the address we validated. undici may call lookup with `{all:true}`
// (expects an array) or the single-address form, so handle both.
function pinnedDispatcher(ip: string): Dispatcher {
  const family = net.isIP(ip) || 4;
  return new Agent({
    connect: {
      lookup: (_hostname: string, options: any, cb: any) => {
        if (options && options.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    },
  });
}

export interface SafeResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Request body, for POST modules (e.g. a JSON tracking query). */
  body?: string;
  requireHttps?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

async function readCapped(body: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new SsrfError(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Fetch a URL with SSRF protection and manual, re-validated redirects. The Host
// always comes from the URL, never from a caller-supplied header.
export async function safeRequest(
  urlStr: string,
  opts: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;

  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, { requireHttps: opts.requireHttps });
    const { address } = await resolvePublic(url.hostname);
    const dispatcher = pinnedDispatcher(address);
    try {
      const res = await request(url.href, {
        method: (opts.method as any) ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        dispatcher,
        maxRedirections: 0,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const loc = res.headers['location'];
      if (res.statusCode >= 300 && res.statusCode < 400 && typeof loc === 'string') {
        await res.body.dump();
        current = new URL(loc, url).href; // re-validated on the next loop
        continue;
      }
      const text = await readCapped(res.body, maxBytes);
      return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: text,
        finalUrl: url.href,
      };
    } finally {
      dispatcher.close().catch(() => {});
    }
  }
  throw new SsrfError('Too many redirects');
}
