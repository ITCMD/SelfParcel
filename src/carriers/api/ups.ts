import { request } from 'undici';
import {
  classifyStatus,
  NotFoundError,
  ProviderUnavailableError,
  type ApiProvider,
  type CarrierCredentials,
  type TrackingEvent,
  type TrackingResult,
} from '../types.js';

// UPS Track API. OAuth2 client-credentials, then a GET to the tracking endpoint.
// Recipient-side tracking works, so only the developer app credentials are
// needed. Docs: https://developer.ups.com

const BASE = {
  production: 'https://onlinetools.ups.com',
  test: 'https://wwwcie.ups.com',
};

// Tokens cached per credential set so different users don't collide.
const tokens = new Map<string, { value: string; expiresAt: number }>();

async function getToken(creds: CarrierCredentials): Promise<string> {
  const env = creds.env ?? 'production';
  const key = `${env}:${creds.clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;

  const base = BASE[env] ?? BASE.production;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await request(`${base}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new ProviderUnavailableError(`UPS auth failed (${res.statusCode}): ${body}`);
  }
  const json = (await res.body.json()) as { access_token: string; expires_in: string };
  const tok = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in) * 1000 };
  tokens.set(key, tok);
  return tok.value;
}

export const upsApi: ApiProvider = {
  code: 'ups',
  name: 'UPS',
  async track(trackingNumber, creds): Promise<TrackingResult> {
    const base = BASE[creds.env ?? 'production'] ?? BASE.production;
    const accessToken = await getToken(creds);
    const res = await request(
      `${base}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          transId: `selfparcel-${Date.now()}`,
          transactionSrc: 'selfparcel',
        },
      },
    );
    const body = await res.body.json().catch(() => ({}));
    if (res.statusCode === 404) throw new NotFoundError('UPS: no data yet');
    if (res.statusCode !== 200) {
      throw new ProviderUnavailableError(
        `UPS track failed (${res.statusCode}): ${JSON.stringify(body)}`,
      );
    }
    return parseUps(trackingNumber, body);
  },
};

function parseUps(trackingNumber: string, body: any): TrackingResult {
  const pkg = body?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) throw new NotFoundError('UPS: empty response');

  const events: TrackingEvent[] = (pkg.activity ?? []).map((a: any) => {
    const desc = a?.status?.description ?? a?.status?.statusType?.description ?? 'Update';
    return {
      timestamp: parseUpsDate(a?.date, a?.time),
      status: classifyStatus(desc),
      description: desc,
      location: formatUpsLocation(a?.location?.address),
    } satisfies TrackingEvent;
  });

  const est =
    pkg?.deliveryDate?.find((d: any) => d.type === 'SDD')?.date ??
    pkg?.deliveryDate?.[0]?.date ??
    null;

  return {
    trackingNumber,
    carrier: 'ups',
    status: events[0]?.status ?? 'unknown',
    estimatedDelivery: parseUpsDate(est, null),
    events,
    source: 'api',
    raw: body,
  };
}

function formatUpsLocation(addr: any): string | undefined {
  if (!addr) return undefined;
  return [addr.city, addr.stateProvince, addr.country].filter(Boolean).join(', ') || undefined;
}

// date is YYYYMMDD, time is HHMMSS
function parseUpsDate(date?: string | null, time?: string | null): string | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);
  const t =
    time && /^\d{6}$/.test(time)
      ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
      : '00:00:00';
  return `${y}-${m}-${d}T${t}`;
}
