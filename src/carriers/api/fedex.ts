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

// FedEx Track API. OAuth2 client-credentials, then a POST to the tracking
// endpoint. Docs: https://developer.fedex.com

const BASE = {
  production: 'https://apis.fedex.com',
  test: 'https://apis-sandbox.fedex.com',
};

const tokens = new Map<string, { value: string; expiresAt: number }>();

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

export const fedexApi: ApiProvider = {
  code: 'fedex',
  name: 'FedEx',
  async track(trackingNumber, creds): Promise<TrackingResult> {
    const base = BASE[creds.env ?? 'production'] ?? BASE.production;
    const accessToken = await getToken(creds);
    const res = await request(`${base}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
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
    throw new NotFoundError(`FedEx: ${result.error.message ?? result.error.code}`);
  }

  const events: TrackingEvent[] = (result.scanEvents ?? []).map((e: any) => {
    const desc = e.eventDescription ?? e.derivedStatus ?? 'Update';
    return {
      timestamp: e.date ?? null,
      status: classifyStatus(desc),
      description: desc,
      location: formatFedexLocation(e.scanLocation),
    } satisfies TrackingEvent;
  });

  const latestDesc =
    result.latestStatusDetail?.description ?? result.latestStatusDetail?.statusByLocale ?? '';
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

function formatFedexLocation(a: any): string | undefined {
  if (!a) return undefined;
  return [a.city, a.stateOrProvinceCode, a.countryCode].filter(Boolean).join(', ') || undefined;
}
