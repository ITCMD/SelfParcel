import { request } from 'undici';
import { config } from '../../config.js';
import {
  classifyStatus,
  NotFoundError,
  ProviderUnavailableError,
  type CarrierCredentials,
  type CarrierProvider,
  type TrackingEvent,
  type TrackingResult,
} from '../types.js';

// FedEx Track API. OAuth2 client-credentials, then a POST to the tracking
// endpoint. Quota is around 100k req/day per project.
// Docs: https://developer.fedex.com

const BASE = {
  production: 'https://apis.fedex.com',
  test: 'https://apis-sandbox.fedex.com',
};

// Tokens cached per credential set so per-user keys don't collide.
const tokens = new Map<string, { value: string; expiresAt: number }>();

function effective(creds?: CarrierCredentials): CarrierCredentials | null {
  if (creds?.clientId && creds?.clientSecret) {
    return { ...creds, env: creds.env ?? 'production' };
  }
  if (config.fedex.clientId && config.fedex.clientSecret) {
    return { clientId: config.fedex.clientId, clientSecret: config.fedex.clientSecret, env: config.fedex.env };
  }
  return null;
}

async function getToken(creds: CarrierCredentials): Promise<string> {
  const env = creds.env ?? 'production';
  const key = `${env}:${creds.clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;

  const base = BASE[env] ?? BASE.production;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await request(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new ProviderUnavailableError(`FedEx auth failed (${res.statusCode}): ${body}`);
  }
  const json = (await res.body.json()) as { access_token: string; expires_in: number };
  const tok = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  tokens.set(key, tok);
  return tok.value;
}

export const fedexProvider: CarrierProvider = {
  code: 'fedex',
  name: 'FedEx',
  kind: 'api',
  isConfigured: () => Boolean(config.fedex.clientId && config.fedex.clientSecret),

  async track(trackingNumber, creds): Promise<TrackingResult> {
    const eff = effective(creds);
    if (!eff) {
      throw new ProviderUnavailableError('FedEx API credentials not set');
    }
    const base = BASE[eff.env ?? 'production'] ?? BASE.production;
    const accessToken = await getToken(eff);

    const res = await request(`${base}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [
          { trackingNumberInfo: { trackingNumber } },
        ],
      }),
    });

    const body = await res.body.json().catch(() => ({}));
    if (res.statusCode !== 200) {
      throw new ProviderUnavailableError(
        `FedEx track failed (${res.statusCode}): ${JSON.stringify(body)}`,
      );
    }
    return parseFedex(trackingNumber, body);
  },
};

function parseFedex(trackingNumber: string, body: any): TrackingResult {
  const result = body?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!result) throw new NotFoundError('FedEx: empty response');

  if (result.error) {
    // "tracking number not found" comes back as an error object, not a 404
    throw new NotFoundError(`FedEx: ${result.error.message ?? result.error.code}`);
  }

  const events: TrackingEvent[] = (result.scanEvents ?? []).map((e: any) => {
    const desc = e.eventDescription ?? e.derivedStatus ?? 'Update';
    return {
      timestamp: e.date ?? null,
      status: classifyStatus(e.eventDescription ?? e.derivedStatus ?? ''),
      description: desc,
      location: formatFedexLocation(e.scanLocation),
    } satisfies TrackingEvent;
  });

  const latestDesc =
    result.latestStatusDetail?.description ??
    result.latestStatusDetail?.statusByLocale ??
    '';
  const est =
    result.estimatedDeliveryTimeWindow?.window?.ends ??
    result.dateAndTimes?.find((d: any) => d.type === 'ESTIMATED_DELIVERY')?.dateTime ??
    null;

  return {
    trackingNumber,
    carrier: 'fedex',
    status: events[0]?.status ?? classifyStatus(latestDesc),
    estimatedDelivery: est,
    events,
    source: 'api',
    raw: body,
  };
}

function formatFedexLocation(loc: any): string | undefined {
  const a = loc;
  if (!a) return undefined;
  return [a.city, a.stateOrProvinceCode, a.countryCode].filter(Boolean).join(', ') || undefined;
}
