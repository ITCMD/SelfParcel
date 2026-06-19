# SelfParcel

Self-hosted package tracking for US carriers. Add tracking numbers and get one
unified timeline across UPS, USPS, FedEx and SpeedPAK. Runs in Docker, keeps
everything in a local SQLite file, no third-party tracking service in the loop.

## How carriers work

By default every carrier (UPS, USPS, FedEx, SpeedPAK) is read by **scraping** its
public tracking page, so it works with no API keys. The official APIs aren't
practical for everyone: UPS needs a lengthy application, FedEx requires a
business account, and USPS moved tracking to a paid commercial contract in
Jan 2026.

For **UPS and FedEx**, if you do have API keys you can use the official API
instead: each user adds their own keys under **Settings → Carrier API keys**.
A package then uses its owner's keys when present, and falls back to the scraper
otherwise. USPS and SpeedPAK are scrape-only.

Scrapers are HTTP-first: a plain request first, then a **stealth-hardened**
headless Chromium (Playwright + stealth, realistic fingerprint, a landing-page
warmup, and persisted session cookies) for JS-rendered or bot-protected pages.
USPS and UPS sit behind Akamai; the stealth browser gets past it in testing.

> If a carrier still gets blocked from your server's IP, point at a real external
> Chrome over CDP with `BROWSER_CDP_URL` (e.g. a browserless container) — that's
> the most reliable option. An admin can also fix any carrier's selectors and
> **test a real tracking number** from the **Providers** panel — the test shows
> the HTTP status, page title, and a snippet so a bot-block is easy to spot
> (see [Provider modules](#provider-modules)).

### Getting UPS / FedEx API keys

Both are free but involve some sign-up. Once you have the keys, add them in
**Settings → Carrier API keys** (steps and portals can change over time):

**UPS** ([developer.ups.com](https://developer.ups.com))
1. Create/sign in to a UPS account, then open the UPS Developer Portal.
2. Add an app to your account and request access to the **Tracking** API.
3. Copy the app's **Client ID** and **Client Secret** into SelfParcel and set the
   environment to **production**.

**FedEx** ([developer.fedex.com](https://developer.fedex.com))
1. Create/sign in to a FedEx account, then open the FedEx Developer Portal.
2. Create a project and enable the **Track API**. New projects start in a test
   sandbox; moving to production needs organization/business details.
3. Copy the project's **API Key** (→ Client ID) and **Secret Key**
   (→ Client Secret) into SelfParcel. Use **test** while in the sandbox,
   **production** once approved.

If the sign-up is more than you want to deal with, just skip it — that carrier
keeps working via the scraper.

## Quick start (Docker)

```bash
cp .env.example .env        # optional; defaults work out of the box
docker compose up -d --build
```

Open <http://localhost:8080>. All four carriers work with no configuration.

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

      # --- Notifications (infrastructure only; channel targets are per-user) ---
      # NOTIFY_TRIGGER: "status_change"  # default for new users; status_change | every_event | delivered_exceptions
      # NOTIFY_ON_FIRST_FETCH: "false"
      # SMTP_HOST: ""                    # relay the app sends through
      # SMTP_PORT: "587"
      # SMTP_SECURE: "false"
      # SMTP_USER: ""
      # SMTP_PASS: ""
      # SMTP_FROM: ""
      # APPRISE_API_URL: ""             # Apprise sidecar endpoint
      # VAPID_PUBLIC_KEY: ""            # browser push; npm run gen:vapid
      # VAPID_PRIVATE_KEY: ""
      # VAPID_SUBJECT: "mailto:you@example.com"

volumes:
  selfparcel-data:
```

Persist the `/data` volume so the SQLite database survives restarts. The
container has a healthcheck on `/api/health` that both tools display.

## Notifications

SelfParcel can ping you when a package moves. Each user sets their own channels
and trigger preference in the Settings panel; channels all fire together. When a
package is shared, the owner and everyone it's shared with are each notified
through their own channels. (Not heavily tested, so file an issue if something
misbehaves.)

| Channel | What the user sets | Notes |
|---------|-------------------|-------|
| ntfy | topic URL, token | self-hostable |
| Pushover | app token, user key | |
| Gotify | server URL, app token | self-hosted |
| Email | recipient address | uses the server's SMTP relay |
| Webhook | URL, format | `json`, `discord`, or `slack` |
| Apprise | target URLs | uses the server's [Apprise API](https://github.com/caronc/apprise-api) sidecar |
| Browser push | enable per device | Web Push, see below |

Only shared infrastructure is configured in env: the **SMTP relay**
(`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`), the **Apprise API URL**
(`APPRISE_API_URL`), and the **VAPID keypair**. The per-person targets (ntfy
topic, Pushover keys, email recipient, etc.) live in each user's settings.

`NOTIFY_TRIGGER` sets the default trigger for new users (`status_change`,
`every_event`, or `delivered_exceptions`); each user can change theirs in the UI.
The owner's bell button mutes a package. The first successful fetch is silent
unless `NOTIFY_ON_FIRST_FETCH=true`.

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

## Sharing

When auth is on, packages are private to whoever added them, but you can share
one with other users. Click the **share button** on a package (or right-click
the card) to open the share dialog. Pick a user from the list, which suggests
people you've shared with recently at the top. Recipients see the package in
their own list, can open it and refresh it (it still uses the owner's carrier
keys), and can remove it from their list. Only the owner can edit, delete, or
manage who it's shared with.

## Provider modules

Carriers are data-driven. UPS, FedEx, USPS, and SpeedPAK all ship as built-in
declarative scraper modules (UPS and FedEx also have the optional official-API
path described above). Admins manage everything from the Providers panel:

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
| `SCRAPER_BROWSER_FALLBACK` | `true` | allow the headless-browser fallback |
| `BROWSER_CDP_URL` | — | connect scraping to an external Chrome over CDP |
| `BROWSER_EXECUTABLE_PATH` / `BROWSER_HEADFUL` | — | use a real Chrome binary / run headful |
| `AUTH_MODE` | `none` | `none`, `local`, or `oidc` |
| `SESSION_SECRET` | | signs session cookies; required for local/oidc |
| `OIDC_*` | | OIDC provider config |
| `NOTIFY_TRIGGER` | `status_change` | default notify trigger (overridable in UI) |
| `NOTIFY_TRIGGER` | `status_change` | default trigger for new users |
| `SMTP_*` (relay), `APPRISE_API_URL`, `VAPID_*` | | notification infrastructure (targets are per-user) |
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
    detect.ts           carrier detection from module patterns
    registry.ts         providers built from DB modules
    moduleSchema.ts     module schema + validator
    engine.ts           runs a module as a provider
    modules/seeds.ts    built-in UPS/FedEx/USPS/SpeedPAK scraper modules
    api/{ups,fedex}.ts  optional official-API providers (per-user keys)
    apiProviders.ts     API provider registry
    scraper/browser.ts  shared headless Chromium
  db/                   SQLite schema + queries
  services/             refresh + background poller
  routes/               REST handlers
  web/public/           single-page UI (vanilla JS)
```

Every carrier is a declarative module run by the engine, which implements
`CarrierProvider.track()` and returns a normalized `TrackingResult`.

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
| GET/POST/DELETE | `/api/packages/:id/shares[/:userId]` | manage who a package is shared with (owner) |
| POST | `/api/packages/:id/leave` | recipient removes a shared package |
| GET | `/api/share/candidates?q=` | users to share with, recent first |
| GET | `/auth/me` | session `{mode, authenticated, user, isAdmin}` |
| GET/PUT/DELETE | `/api/me/credentials[/:carrier]` | your own UPS/FedEx API keys |
| GET/PUT | `/api/me/notify` | your channels + trigger |
| POST | `/api/me/notify/test` | send yourself a test |
| POST | `/auth/local-login`, `/auth/register` | local auth |
| GET | `/auth/login`, `/auth/callback`, `/auth/logout` | OIDC flow |
| (admin) | `/api/admin/users...` | user CRUD + registration toggle |
| (admin) | `/api/admin/modules...` | module CRUD, install-url, validate, test, reset |
| GET/POST | `/api/push/*` | Web Push key + subscribe |

## License

See [LICENSE](LICENSE).
