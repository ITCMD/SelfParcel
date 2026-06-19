// Shared carrier types. Every provider normalizes its output to these shapes,
// whether it hits an official API or scrapes a public tracking page, so the
// rest of the app doesn't care how the data was obtained.

// Built-in carriers plus any admin-installed module code. Use
// registry.carrierName(code) for display names rather than assuming the set.
export type CarrierCode = string;

// Display-name fallbacks for the built-ins. The registry is authoritative and
// includes installed modules.
export const CARRIER_NAMES: Record<string, string> = {
  ups: 'UPS',
  usps: 'USPS',
  fedex: 'FedEx',
  speedpak: 'SpeedPAK',
};

// Normalized status. Each provider maps its own vocabulary onto this small set
// so the UI can show consistent badges.
export type TrackStatus =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface TrackingEvent {
  /** ISO-8601 timestamp of the scan, if known. */
  timestamp: string | null;
  status: TrackStatus;
  description: string;
  location?: string;
}

export interface TrackingResult {
  trackingNumber: string;
  carrier: CarrierCode;
  status: TrackStatus;
  estimatedDelivery?: string | null;
  events: TrackingEvent[];
  /** How the data was obtained, for diagnostics. */
  source: 'api' | 'http' | 'browser';
  /** Raw payload kept for debugging; not surfaced in the UI. */
  raw?: unknown;
}

export interface CarrierProvider {
  code: CarrierCode;
  name: string;
  kind: 'api' | 'scraper';
  isConfigured(): boolean;
  track(trackingNumber: string): Promise<TrackingResult>;
}

/** OAuth API credentials a user supplies to use a carrier's official API. */
export interface CarrierCredentials {
  clientId: string;
  clientSecret: string;
  env?: 'production' | 'test';
}

/**
 * An official-API provider (UPS, FedEx). Unlike CarrierProvider, it needs
 * per-user credentials at call time, so it isn't a pre-built singleton in the
 * registry; the tracking service invokes it directly when the owner has keys.
 */
export interface ApiProvider {
  code: CarrierCode;
  name: string;
  track(trackingNumber: string, creds: CarrierCredentials): Promise<TrackingResult>;
}

/** Thrown when a tracking number is well-formed but no data exists yet. */
export class NotFoundError extends Error {}
/** Thrown when the provider can't run: missing creds, site blocked, etc. */
export class ProviderUnavailableError extends Error {}

const DELIVERED = /\bdeliver(ed|y complete)?\b/i;
const OUT_FOR_DELIVERY = /out for delivery|on (the )?vehicle for delivery/i;
const EXCEPTION =
  /exception|return to sender|undeliverable|delay|held|customs|alert|failed/i;
const PRE_TRANSIT =
  /label created|shipment information|pre[- ]?shipment|order processed|awaiting/i;
const IN_TRANSIT =
  /in transit|departed|arrived|accepted|picked up|processed|on its way|in possession/i;

/** Map a free-text status line onto our normalized status. */
export function classifyStatus(text: string): TrackStatus {
  const t = text.toLowerCase();
  if (OUT_FOR_DELIVERY.test(t)) return 'out_for_delivery';
  if (DELIVERED.test(t)) return 'delivered';
  if (EXCEPTION.test(t)) return 'exception';
  if (PRE_TRANSIT.test(t)) return 'pre_transit';
  if (IN_TRANSIT.test(t)) return 'in_transit';
  return 'unknown';
}
