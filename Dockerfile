# Official Playwright image: ships Node 20, matching Chromium, and the system
# libs the headless browser needs (the annoying part of running it in Docker).
# Keep this tag in lockstep with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy AS base
WORKDIR /app

# better-sqlite3 may need to compile a native addon; ensure build tools exist.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ── Dependencies (cached layer) ─────────────────────────────────────────────
FROM base AS deps
COPY package.json ./
# Browsers are already in the image; skip the postinstall download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund \
    && cp -r node_modules /tmp/prod_node_modules \
    && npm install --no-audit --no-fund

# ── Build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/selfparcel.sqlite
COPY package.json ./
COPY --from=deps /tmp/prod_node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Persist the SQLite database on a mounted volume.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
