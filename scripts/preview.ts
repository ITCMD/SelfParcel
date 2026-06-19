// Dev preview launcher. Loads the seeded UI database with scrapers off so the
// interface shows deterministic sample data. These env vars have to be set
// before the app is imported (it reads config at import time), so we import
// dynamically further down.
process.env.DATABASE_PATH ||= './data/ui.sqlite';
process.env.SCRAPER_BROWSER_FALLBACK ||= 'false';
process.env.PORT ||= '8099';
// Local auth so the login gate and admin UI can be exercised in preview.
process.env.AUTH_MODE ||= 'local';
process.env.SESSION_SECRET ||= 'preview-only-secret-do-not-use';

await import('../src/index.js');
