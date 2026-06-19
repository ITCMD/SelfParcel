# SelfParcel

Self-hosted package tracking for US carriers. Add tracking numbers and get one
unified timeline across UPS, USPS, FedEx and SpeedPAK. Runs in Docker, keeps
everything in a local SQLite file, no third-party tracking service in the loop.

## How carriers work

Not every carrier still has a usable free API, so SelfParcel uses two approaches
behind one interface:

| Carrier | Method | Notes | Credentials |
|---------|--------|-------|-------------|
| UPS | Official API | Track API is free, recipient-side tracking allowed | [developer.ups.com](https://developer.ups.com) |
| FedEx | Official API | Free, ~100k requests/day | [developer.fedex.com](https://developer.fedex.com) |
| USPS | Scraper | Their tracking API went to a paid commercial contract in Jan 2026; the free account is testing/address only | none |
| SpeedPAK | Scraper | No public API exists | none |

Scrapers are HTTP-first: a plain request first, and only spin up headless
Chromium (Playwright) if the page needs JavaScript to render.

The scrapers parse public HTML, which carriers change from time to time. If a
tracking page gets redesigned you can fix the selectors from the Providers panel
in the app without redeploying (see [Provider modules](#provider-modules)).

## Quick start (Docker)

```bash
cp .env.example .env        # optional: add UPS/FedEx API keys
docker compose up -d --build
```

Open <http://localhost:8080>. USPS and SpeedPAK work with no keys. UPS and FedEx
stay off until you add credentials; the chips at the top of the page show what's
ready.

### API credentials

These are the server-wide defaults. Put them in `.env` (read by
`docker-compose.yml`) or pass them into the container:

```
UPS_CLIENT_ID=...
UPS_CLIENT_SECRET=...
FEDEX_CLIENT_ID=...
FEDEX_CLIENT_SECRET=...
```

When auth is on, each signed-in user can also set their own UPS/FedEx keys under
Settings. A package uses its owner's keys and falls back to these `.env` defaults
when the owner hasn't set any. With `AUTH_MODE=none` there are no per-user keys,
so everything uses the `.env` values.

### Komodo / Portainer

The compose file works whether the image is built on the host or pulled from a
registry, so you have two options:

**Build from the repo (no registry needed).** Point Komodo or Portainer at this
Git repo as a stack. They clone it and the `build:` section compiles the image on
the host. Set environment variables in the stack's env/secrets UI.

**Pull a pre-built image.** Push an image to a registry once, then set
`SELFPARCEL_IMAGE` to its tag. This is required for Portainer's inline web editor
(it has no build context and can only pull). The included GitHub Actions workflow
([.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml))
builds and pushes to GHCR (`ghcr.io/<you>/selfparcel`) on every push to `main`;
make the package public or add a registry pull credential.

**Paste-ready stack.** Drop this into Komodo or Portainer's web editor and
uncomment whatever you need. Everything except the image and volume is optional.

```yaml
services:
  selfparcel:
    image: ghcr.io/<you>/selfparcel:latest   # replace <you>; or remove and add `build: .` for repo builds
    container_name: selfparcel
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - selfparcel-data:/data
    environment:
      TZ: "UTC"
      # POLL_INTERVAL_MINUTES: "30"
      # MIN_REFRESH_MINUTES: "10"
      # APP_BASE_URL: "https://parcels.example.com"   # used for notification links
      # SCRAPER_BROWSER_FALLBACK: "true"

      # --- Carrier API keys (server-wide default; users can also set their own) ---
      # UPS_CLIENT_ID: ""
      # UPS_CLIENT_SECRET: ""
      # UPS_ENV: "production"
      # FEDEX_CLIENT_ID: ""
      # FEDEX_CLIENT_SECRET: ""
      # FEDEX_ENV: "production"

      # --- Authentication: none | local | oidc ---
      # AUTH_MODE: "none"
      # SESSION_SECRET: ""                # required for local/oidc; openssl rand -hex 32
      # SESSION_TTL_HOURS: "168"
      # OIDC_ISSUER: ""
      # OIDC_CLIENT_ID: ""
      # OIDC_CLIENT_SECRET: ""
      # OIDC_REDIRECT_URI: ""            # blank = derived from the request
      # OIDC_SCOPES: "openid profile email"
      # OIDC_POST_LOGOUT_REDIRECT_URI: ""
      # OIDC_ALLOWED_EMAILS: ""          # comma-separated
      # OIDC_ALLOWED_DOMAINS: ""         # comma-separated

      # --- Notifications (all optional, fire together) ---
      # NOTIFY_TRIGGER: "status_change"  # status_change | every_event | delivered_exceptions
      # NOTIFY_ON_FIRST_FETCH: "false"
      # NTFY_URL: ""
      # NTFY_TOKEN: ""
      # PUSHOVER_TOKEN: ""
      # PUSHOVER_USER: ""
      # GOTIFY_URL: ""
      # GOTIFY_TOKEN: ""
      # SMTP_HOST: ""
      # SMTP_PORT: "587"
      # SMTP_SECURE: "false"
      # SMTP_USER: ""
      # SMTP_PASS: ""
      # SMTP_FROM: ""
      # SMTP_TO: ""
      # WEBHOOK_URL: ""
      # WEBHOOK_FORMAT: "json"           # json | discord | slack
      # APPRISE_API_URL: ""
      # APPRISE_URLS: ""
      # VAPID_PUBLIC_KEY: ""             # browser push; npm run gen:vapid
      # VAPID_PRIVATE_KEY: ""
      # VAPID_SUBJECT: "mailto:you@example.com"

volumes:
  selfparcel-data:
```

Persist the `/data` volume so the SQLite database survives restarts. The
container has a healthcheck on `/api/health` that both tools display.

## Notifications

SelfParcel can ping you when a package moves. Configure any mix of channels via
environment variables; they all fire together. Pick when to be notified in the
Settings panel. These haven't been heavily tested, so file an issue if something
misbehaves.

| Channel | What you set | Notes |
|---------|-------------|-------|
| ntfy | `NTFY_URL`, `NTFY_TOKEN` | self-hostable |
| Pushover | `PUSHOVER_TOKEN`, `PUSHOVER_USER` | |
| Gotify | `GOTIFY_URL`, `GOTIFY_TOKEN` | self-hosted |
| Email | `SMTP_HOST`, `SMTP_FROM`, `SMTP_TO`, ... | standard SMTP |
| Webhook | `WEBHOOK_URL`, `WEBHOOK_FORMAT` | `json`, `discord`, or `slack` |
| Apprise | `APPRISE_API_URL`, `APPRISE_URLS` | bridge to 80+ services via an [Apprise API](https://github.com/caronc/apprise-api) container |
| Browser push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push, see below |

`NOTIFY_TRIGGER` (also settable in the UI) controls when notifications fire:
`status_change` (default), `every_event`, or `delivered_exceptions`. Use the bell
button on a package to mute it. The first successful fetch of a package is silent
unless you set `NOTIFY_ON_FIRST_FETCH=true`.

### Browser push

There's a web manifest and service worker, so the app installs as a PWA and
supports Web Push on desktop Chrome/Firefox and on iOS 16.4+. On iOS push only
works after you Add to Home Screen.

1. Generate VAPID keys: `npm run gen:vapid`, then put them in your env.
2. Open Settings, Browser notifications, Enable on this device.
3. iOS: Share, Add to Home Screen, open from the icon, then enable.

Web Push and PWA install need HTTPS, so put it behind a TLS-terminating proxy.

## Authentication

Pick one mode with `AUTH_MODE` (default `none`):

| Mode | What it is |
|------|-----------|
| `none` | Open. Use this if a reverse proxy already handles auth. |
| `local` | Built-in username/password accounts. |
| `oidc` | SSO via any OpenID Connect provider (auth code + PKCE). |

For `local` and `oidc`, the first user becomes admin. Sessions live in SQLite
(the cookie only carries a signed opaque id), and disabling or deleting a user
kills their session on the next request. The app won't start if the chosen mode
is misconfigured. `SESSION_SECRET` (`openssl rand -hex 32`) is required for both.

### Local accounts

```
AUTH_MODE=local
SESSION_SECRET=...
```

First registration becomes admin. Admins use the Users panel to add/remove
accounts, set roles, disable users, reset passwords, and turn open registration
on or off. The last admin can't be removed or demoted. Passwords use scrypt.

### OIDC

```
AUTH_MODE=oidc
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=selfparcel
OIDC_CLIENT_SECRET=...
SESSION_SECRET=$(openssl rand -hex 32)
```

Register `https://your-host/auth/callback` as the redirect URI, or set
`OIDC_REDIRECT_URI`; otherwise it's derived from the request (honours
`X-Forwarded-*`). `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_DOMAINS` restrict who can
sign in. Users are created on first login, so there's no manual user creation in
this mode, but admins can still promote/disable/delete from the Users panel.

## Provider modules

Carriers are data-driven. UPS and FedEx are native code (OAuth); USPS and
SpeedPAK ship as built-in declarative modules. Admins manage everything from the
Providers panel:

- Edit the selectors of any module (including the built-in scrapers) in the UI,
  test against a real tracking number, and reset a built-in to its default.
- Add a carrier by pasting module JSON or fetching one from an https URL (e.g. a
  GitHub raw link). Modules installed from a URL start disabled so you can look
  them over before turning them on.

A module is plain JSON, never executed as code. It holds detection regexes, a
request template, and extraction rules (CSS selectors for `scraper` modules, JSON
paths for `json` modules). Both installing a module from a URL and a module's own
tracking requests go through an SSRF check that blocks private/loopback/link-local
addresses and pins the connection to the resolved IP, so a hostname can't be
re-pointed at an internal address after validation.

Minimal example:

```jsonc
{
  "schema": "selfparcel.module/v1",
  "code": "dhl", "name": "DHL", "kind": "scraper",
  "detect": [{ "pattern": "^JD\\d{18}$" }],
  "request": { "url": "https://www.dhl.com/track?id={tn}" },
  "scraper": {
    "browser": { "enabled": true, "waitFor": ".tracking-result" },
    "rowSelector": ".checkpoint",
    "fields": { "description": ".desc", "date": ".time", "location": ".loc" },
    "banner": ".current-status"
  }
}
```

`{tn}` is replaced with the tracking number. For `"kind": "json"`, give a `json`
block with `eventsPath`, per-field paths (both support `a || b` fallbacks), and
an optional `statusPath`.

## Development

```bash
npm install
npm run dev          # tsx watch, serves on PORT (default 8080)
npm run typecheck
npm run build && npm start
```

## Configuration

All via environment variables; see [`.env.example`](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `UTC` | container timezone, e.g. `America/New_York` |
| `PORT` | `8080` | HTTP port |
| `DATABASE_PATH` | `./data/selfparcel.sqlite` | SQLite file location |
| `POLL_INTERVAL_MINUTES` | `30` | how often active packages refresh |
| `MIN_REFRESH_MINUTES` | `10` | min age before a package is re-fetched |
| `UPS_*`, `FEDEX_*` | | API credentials + `production`/`test` env |
| `SCRAPER_BROWSER_FALLBACK` | `true` | allow the headless-browser fallback |
| `AUTH_MODE` | `none` | `none`, `local`, or `oidc` |
| `SESSION_SECRET` | | signs session cookies; required for local/oidc |
| `OIDC_*` | | OIDC provider config |
| `NOTIFY_TRIGGER` | `status_change` | default notify trigger (overridable in UI) |
| `NTFY_*`, `PUSHOVER_*`, `GOTIFY_*`, `SMTP_*`, `WEBHOOK_*`, `APPRISE_*`, `VAPID_*` | | notification channels |
| `APP_BASE_URL` | | public URL, used for notification links |

## Layout

```
src/
  index.ts              server + static UI + scheduler wiring
  config.ts             env config
  auth/                 local + OIDC login, scrypt, sessions, guard
  net/safeFetch.ts      SSRF-guarded fetch
  notify/               channels + dispatch + trigger rules
  carriers/
    types.ts            CarrierProvider interface + result types
    detect.ts           carrier detection (native + modules)
    registry.ts         native providers + DB modules
    moduleSchema.ts     module schema + validator
    engine.ts           runs a module as a provider
    modules/seeds.ts    built-in USPS/SpeedPAK modules
    api/{ups,fedex}.ts  native OAuth providers
    scraper/browser.ts  shared headless Chromium
  db/                   SQLite schema + queries
  services/             refresh + background poller
  routes/               REST handlers
  web/public/           single-page UI (vanilla JS)
```

Every provider implements `CarrierProvider.track()` and returns a normalized
`TrackingResult`, so the rest of the app doesn't care whether the data came from
an API or a scraped page.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | liveness |
| GET | `/api/carriers` | carrier list + ready state |
| GET | `/api/detect?trackingNumber=` | detect carrier |
| GET | `/api/packages?archived=0\|1` | list packages |
| GET | `/api/packages/:id` | package + timeline |
| POST | `/api/packages` | add `{trackingNumber, carrier?, label?}` |
| POST | `/api/packages/:id/refresh` | refresh now |
| POST | `/api/packages/:id/archive` | archive `{archived}` |
| POST | `/api/packages/:id/notify` | mute/unmute `{notify}` |
| DELETE | `/api/packages/:id` | delete package + history |
| GET | `/auth/me` | session `{mode, authenticated, user, isAdmin}` |
| GET/PUT/DELETE | `/api/me/credentials[/:carrier]` | your own UPS/FedEx keys |
| POST | `/auth/local-login`, `/auth/register` | local auth |
| GET | `/auth/login`, `/auth/callback`, `/auth/logout` | OIDC flow |
| (admin) | `/api/admin/users...` | user CRUD + registration toggle |
| (admin) | `/api/admin/modules...` | module CRUD, install-url, validate, test, reset |
| GET/POST | `/api/notify/*`, `/api/push/*` | notification settings + Web Push |

## License

See [LICENSE](LICENSE).
