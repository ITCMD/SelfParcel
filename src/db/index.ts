import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

// One shared SQLite connection. better-sqlite3 is synchronous, which keeps the
// data layer simple and is plenty fast here.

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_number TEXT    NOT NULL,
      carrier         TEXT    NOT NULL,
      label           TEXT,
      status          TEXT    NOT NULL DEFAULT 'unknown',
      est_delivery    TEXT,
      archived        INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_error      TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tracking_number, carrier)
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      timestamp   TEXT,
      status      TEXT    NOT NULL,
      description TEXT    NOT NULL,
      location    TEXT,
      -- Stable hash so re-fetching the same scan doesn't duplicate rows.
      dedupe_key  TEXT    NOT NULL,
      UNIQUE (package_id, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_events_package ON events(package_id);
    CREATE INDEX IF NOT EXISTS idx_packages_active ON packages(archived, status);

    -- OIDC login sessions. Only used when auth is enabled.
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      sub        TEXT NOT NULL,
      email      TEXT,
      name       TEXT,
      id_token   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    -- Simple key/value store for user-editable settings (e.g. notify trigger).
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Web Push (browser notification) subscriptions.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      label      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- User accounts (local + OIDC). The first account created becomes admin.
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,            -- 'local' | 'oidc'
      oidc_sub      TEXT,
      email         TEXT,
      name          TEXT,
      username      TEXT,
      password_hash TEXT,
      password_salt TEXT,
      role          TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub
      ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
      ON users(username) WHERE username IS NOT NULL;

    -- Declarative carrier provider modules (UPS/FedEx remain native code).
    CREATE TABLE IF NOT EXISTS carrier_modules (
      code         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,             -- 'scraper' | 'json'
      enabled      INTEGER NOT NULL DEFAULT 1,
      builtin      INTEGER NOT NULL DEFAULT 0,
      seed_version TEXT,
      module       TEXT NOT NULL,             -- validated module JSON
      source_url   TEXT,
      fetched_at   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Per-package mute flag, added after v1.
  addColumnIfMissing('packages', 'notify', 'INTEGER NOT NULL DEFAULT 1');
  // Sessions link to a persistent user row; old sub/email/name columns stay for now.
  addColumnIfMissing('sessions', 'user_id', 'TEXT');
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
