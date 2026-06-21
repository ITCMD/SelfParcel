import { MODULE_SCHEMA, type CarrierModule } from '../moduleSchema.js';

// Built-in carrier modules, seeded into the DB on first run. These replace the
// old src/carriers/scraper/{usps,speedpak}.ts providers, so the selectors are
// now editable in the admin UI. "Reset to default" restores these definitions.

export interface BuiltinSeed {
  code: string;
  name: string;
  kind: 'scraper' | 'json';
  seedVersion: string;
  module: CarrierModule;
}

const usps: CarrierModule = {
  schema: MODULE_SCHEMA,
  code: 'usps',
  name: 'USPS',
  kind: 'scraper',
  detect: [
    { pattern: '^9[0-9]{19,21}$' },
    { pattern: '^\\d{22}$' },
    { pattern: '^[A-Z]{2}\\d{9}US$' },
  ],
  request: {
    url: 'https://tools.usps.com/go/TrackConfirmAction.action?tLabels={tn}',
    method: 'GET',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    maxRedirections: 3,
    timeoutMs: 45000,
  },
  notFound: ['could not locate the tracking information', 'status not available'],
  // USPS phrasing -> normalized status. Checked against the latest scan, in this
  // order (first match wins), so "On the Way" reads as in-transit rather than
  // unknown. The milestone progress bar always contains the literal word
  // "Delivered" as a future step, so we deliberately do NOT use a status banner
  // here: status comes from the newest scan event, which is accurate.
  statusMap: {
    delivered: ['delivered', 'item picked up'],
    out_for_delivery: ['out for delivery', 'vehicle for delivery'],
    exception: ['alert', 'delayed', 'no access', 'held', 'return to sender', 'undeliverable'],
    pre_transit: ['shipping label created', 'pre-shipment', 'label created', 'awaiting item'],
    in_transit: [
      'on the way',
      'in transit',
      'arriving',
      'departed',
      'arrived',
      'accepted',
      'moving within',
      'in possession',
      'picked up',
    ],
  },
  scraper: {
    browser: {
      enabled: true,
      // Visit the public site first so Akamai sets its clearance cookie.
      warmupUrl: 'https://www.usps.com/tracking/',
      waitFor: '.tb-step, .tracking-progress-bar-status-container, .banner-content',
    },
    rowSelector: '.tb-step, .tracking-progress-bar-status-container, .track-history-item',
    fields: {
      description: '.tb-status-detail, .tb-status, .tracking-status, p.tb-status',
      date: '.tb-date, .tracking-date',
      location: '.tb-location, .tracking-location',
    },
    estimatedDelivery:
      '.expected_delivery, .expected-delivery-date, .eddText, [class*="expected_delivery"], [class*="expected-delivery"]',
  },
};

const speedpak: CarrierModule = {
  schema: MODULE_SCHEMA,
  code: 'speedpak',
  name: 'SpeedPAK',
  kind: 'scraper',
  detect: [{ pattern: '^[A-Z]{2}\\d{9}(CN|HK|SG)$' }],
  request: {
    url: 'https://www.orangeconnex.com/tracking?inputValue={tn}',
    method: 'GET',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },
  notFound: ['no (tracking )?(result|information)', 'invalid tracking'],
  scraper: {
    browser: {
      enabled: true,
      waitFor: '.tracking-detail, .track-list, .timeline, [class*="track"]',
    },
    rowSelector: '.tracking-detail li, .track-list li, .timeline li, [class*="track-item"]',
    fields: {
      description: '[class*="desc"], [class*="content"], p',
      date: '[class*="time"], [class*="date"]',
      location: '[class*="location"], [class*="city"]',
    },
    // Try the page's own JSON endpoint before falling back to rendering the DOM
    fastJson: {
      url: 'https://www.orangeconnex.com/web-tracking/api/v1/tracking?trackingNumber={tn}',
      headers: { Accept: 'application/json' },
      eventsPath:
        'data.trackingList || data.details || data.events || data.traces || result.trackingList || trackingList',
      fields: {
        description: 'description || statusDesc || trackDescription || content',
        date: 'time || eventTime || trackTime || date',
        location: 'location || city',
      },
      estimatedDeliveryPath: 'data.estimatedDelivery || estimatedDelivery',
    },
  },
};

// UPS and FedEx are scrapers too (their APIs need a business account / lengthy
// approval). Both tracking pages are JS-heavy, so the browser fallback does the
// real work. Selectors are a best-effort starting point and will likely need
// tuning in the Providers panel; these carriers also use bot protection that can
// block a headless browser.
const ups: CarrierModule = {
  schema: MODULE_SCHEMA,
  code: 'ups',
  name: 'UPS',
  kind: 'scraper',
  detect: [{ pattern: '^1Z[0-9A-Z]{16}$' }, { pattern: '^(T\\d{10}|\\d{9}|\\d{26})$' }],
  request: {
    url: 'https://www.ups.com/track?loc=en_US&tracknum={tn}&requester=ST/trackdetails',
    method: 'GET',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    timeoutMs: 30000,
  },
  notFound: ['could not (locate|find)', 'no tracking information', 'check the number'],
  scraper: {
    browser: {
      enabled: true,
      waitFor: '[class*="ups-milestone"], [class*="activity"], [data-test*="tracking"]',
    },
    rowSelector:
      '[class*="ups-milestone"], [class*="activity_row"], [class*="tracking-history"] li, tbody tr',
    fields: {
      description: '[class*="status"], [class*="activity"], [class*="milestone"], td',
      date: '[class*="date"], [class*="time"], time',
      location: '[class*="location"], [class*="city"]',
    },
    banner: '[class*="ups-status"], [class*="package_status"], [class*="current-status"]',
    estimatedDelivery:
      '[class*="estimated-delivery"], [class*="scheduledDelivery"], [class*="delivery-date"]',
  },
};

const fedex: CarrierModule = {
  schema: MODULE_SCHEMA,
  code: 'fedex',
  name: 'FedEx',
  kind: 'scraper',
  detect: [{ pattern: '^\\d{12}$' }, { pattern: '^\\d{15}$' }, { pattern: '^\\d{20}$' }],
  request: {
    url: 'https://www.fedex.com/fedextrack/?trknbr={tn}',
    method: 'GET',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    timeoutMs: 30000,
  },
  notFound: ['unable to (locate|retrieve)', 'no record', 'check the number'],
  scraper: {
    browser: {
      enabled: true,
      waitFor: '[class*="travel-history"], [class*="scan-event"], [class*="status"]',
    },
    rowSelector:
      '[class*="travel-history"] [class*="row"], [class*="scan-event"], [class*="activity"] li, tbody tr',
    fields: {
      description: '[class*="status"], [class*="scan"], [class*="activity"], td',
      date: '[class*="date"], [class*="time"], time',
      location: '[class*="location"], [class*="city"]',
    },
    banner: '[class*="redesignStatus"], [class*="package-status"], [class*="current-status"]',
    estimatedDelivery:
      '[class*="estimated-delivery"], [class*="deliveryDate"], [class*="delivery-date"]',
  },
};

export const BUILTIN_SEEDS: BuiltinSeed[] = [
  { code: 'ups', name: 'UPS', kind: 'scraper', seedVersion: '2', module: ups },
  { code: 'fedex', name: 'FedEx', kind: 'scraper', seedVersion: '2', module: fedex },
  { code: 'usps', name: 'USPS', kind: 'scraper', seedVersion: '6', module: usps },
  { code: 'speedpak', name: 'SpeedPAK', kind: 'scraper', seedVersion: '1', module: speedpak },
];
