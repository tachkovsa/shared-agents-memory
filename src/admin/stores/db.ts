import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operators (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  role          TEXT NOT NULL,
  is_disabled   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id                  TEXT PRIMARY KEY,
  operator_id         TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  csrf_token          TEXT NOT NULL,
  ip                  TEXT,
  user_agent          TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_operator ON operator_sessions(operator_id);
`;

/**
 * Open (and migrate) the admin SQLite database. Pass ':memory:' for tests.
 * Holds operator accounts and sessions only — engine file-stores are untouched
 * (ADR-0008 §3.4).
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
