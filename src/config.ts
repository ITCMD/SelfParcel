// Read once from the environment at startup.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

// Package version from package.json (one level above src/ and dist/ alike).
function pkgVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function csv(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// AUTH_MODE wins; otherwise fall back to the old AUTH_ENABLED boolean, which
// only ever meant OIDC.
type AuthMode = 'none' | 'local' | 'oidc';
const authMode: AuthMode = (() => {
  const m = str('AUTH_MODE').toLowerCase();
  if (m === 'none' || m === 'local' || m === 'oidc') return m;
  return bool('AUTH_ENABLED', false) ? 'oidc' : 'none';
})();

export const config = {
  // Human-readable app version from package.json, and the git commit baked in at
  // Docker build time (empty when running from source). Together they let the UI
  // show, at a glance, exactly which build is running.
  version: pkgVersion(),
  commit: str('APP_COMMIT').trim(),
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  databasePath: str('DATABASE_PATH', './data/selfparcel.sqlite'),
  pollIntervalMinutes: int('POLL_INTERVAL_MINUTES', 30),
  minRefreshMinutes: int('MIN_REFRESH_MINUTES', 10),
  // Public base URL, used for notification click-throughs.
  // e.g. https://parcels.example.com (trailing slash optional)
  baseUrl: str('APP_BASE_URL'),

  scraper: {
    browserFallback: bool('SCRAPER_BROWSER_FALLBACK', true),
    // Connect to an external real Chrome over CDP instead of launching the
    // bundled headless-shell. Best chance against bot protection (Akamai).
    // e.g. ws://chrome:9222/... or http://chrome:9222
    cdpUrl: str('BROWSER_CDP_URL'),
    // Or launch a real Chrome binary instead of the bundled chromium.
    executablePath: str('BROWSER_EXECUTABLE_PATH'),
    // Run headful (needs a display / xvfb); harder to fingerprint than headless.
    headful: bool('BROWSER_HEADFUL', false),
  },

  notify: {
    // Skip notifications on a package's first successful fetch, so adding old
    // packages doesn't fire off a burst.
    onFirstFetch: bool('NOTIFY_ON_FIRST_FETCH', false),
    // Default trigger for new users; each user can change it in the UI.
    defaultTrigger: str('NOTIFY_TRIGGER', 'status_change') as
      | 'status_change'
      | 'every_event'
      | 'delivered_exceptions',

    // Channel TARGETS are per-user (set in the UI). Only shared infrastructure
    // lives here: the SMTP relay, the Apprise sidecar URL, and the VAPID keypair.
    smtp: {
      host: str('SMTP_HOST'),
      port: int('SMTP_PORT', 587),
      secure: bool('SMTP_SECURE', false),
      user: str('SMTP_USER'),
      pass: str('SMTP_PASS'),
      from: str('SMTP_FROM'),
    },
    apprise: {
      // Apprise API "stateless" endpoint, e.g. http://apprise:8000/notify
      apiUrl: str('APPRISE_API_URL'),
    },
    webpush: {
      publicKey: str('VAPID_PUBLIC_KEY'),
      privateKey: str('VAPID_PRIVATE_KEY'),
      subject: str('VAPID_SUBJECT', 'mailto:admin@example.com'),
    },
  },

  auth: {
    // 'none' (wide open), 'local' (username/password), or 'oidc' (SSO).
    // `enabled` stays derived so the OIDC code path is untouched.
    mode: authMode,
    enabled: authMode !== 'none',
    issuer: str('OIDC_ISSUER'),
    clientId: str('OIDC_CLIENT_ID'),
    clientSecret: str('OIDC_CLIENT_SECRET'),
    // If unset, the callback URL is derived from the incoming request
    // (honouring X-Forwarded-* behind a reverse proxy).
    redirectUri: str('OIDC_REDIRECT_URI'),
    scopes: str('OIDC_SCOPES', 'openid profile email'),
    postLogoutRedirectUri: str('OIDC_POST_LOGOUT_REDIRECT_URI'),
    // Optional allow-lists. If both are empty, any authenticated user is accepted.
    allowedEmails: csv('OIDC_ALLOWED_EMAILS'),
    allowedDomains: csv('OIDC_ALLOWED_DOMAINS'),
    sessionSecret: str('SESSION_SECRET'),
    sessionTtlHours: int('SESSION_TTL_HOURS', 168),
    // Allow plain-HTTP issuers. Local dev only, never in production.
    allowInsecure: bool('OIDC_ALLOW_INSECURE', false),
  },
} as const;

export type Config = typeof config;
