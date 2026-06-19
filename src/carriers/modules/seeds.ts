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
    url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={tn}',
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirections: 3,
  },
  notFound: ['could not locate the tracking information', 'status not available'],
  scraper: {
    browser: {
      enabled: true,
      waitFor:
        '.tracking-progress-bar-status-container, .track-bar-container, .banner-content',
    },
    rowSelector: '.tracking-progress-bar-status-container, .track-history-item, .tb-step',
    fields: {
      description: '.tb-status-detail, .tracking-status, p.tb-status, p',
      date: '.tb-date, .tracking-date, p.tb-date',
      location: '.tb-location, .tracking-location',
    },
    banner: '.banner-content .tb-status, .delivery_status, .current-step .tb-status-detail',
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

export const BUILTIN_SEEDS: BuiltinSeed[] = [
  { code: 'usps', name: 'USPS', kind: 'scraper', seedVersion: '1', module: usps },
  { code: 'speedpak', name: 'SpeedPAK', kind: 'scraper', seedVersion: '1', module: speedpak },
];
