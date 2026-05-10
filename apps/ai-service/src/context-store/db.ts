/**
 * Context Store database layer — wraps bun:sqlite + sqlite-vec extension.
 * Owns connection, migrations, schema versioning.
 */

import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database

const SCHEMA_VERSION = 2

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_meta TEXT,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ttl_at TEXT NOT NULL,
  is_pull INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_captures_received_at ON captures(received_at);
CREATE INDEX IF NOT EXISTS idx_captures_content_hash ON captures(content_hash);
CREATE INDEX IF NOT EXISTS idx_captures_ttl_at ON captures(ttl_at);
CREATE INDEX IF NOT EXISTS idx_captures_source_channel ON captures(source_channel);

CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  text,
  content='captures',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS captures_fts_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS captures_fts_ad AFTER DELETE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

-- Proposals: first-class entity for AI-suggested changes (replaces legacy
-- 'proposal-ai'-tagged Mindwtr inbox tasks). See architecture-addendum-
-- proposal-entity-2026-05-05.md.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                   -- create|modify|delete|merge|split|move
  target_task_ids TEXT NOT NULL,        -- JSON array of Mindwtr task ids; [] for create
  source_capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  source_agent TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending|approved|rejected|superseded|stale|expired
  current_payload TEXT NOT NULL,        -- JSON: latest diff/payload (mirrors latest version)
  current_version INTEGER NOT NULL DEFAULT 1,
  origin_snapshot TEXT,                 -- JSON: snapshot of target tasks at creation
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_source_agent ON proposals(source_agent);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at);

CREATE TABLE IF NOT EXISTS proposal_versions (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,                -- JSON snapshot of payload at this version
  author TEXT NOT NULL,                 -- agent|user
  summary TEXT,                         -- one-liner explaining what changed
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, version)
);

CREATE TABLE IF NOT EXISTS proposal_messages (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                   -- user|agent
  text TEXT NOT NULL,
  ref_version INTEGER,                  -- which version the message refers to
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_messages_proposal ON proposal_messages(proposal_id, created_at);

CREATE TABLE IF NOT EXISTS proposal_audit (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  event TEXT NOT NULL,                  -- created|revised|commented|approved|rejected
                                        -- |superseded|stale|expired|applied|apply_failed
  event_meta TEXT,                      -- JSON
  actor TEXT NOT NULL,                  -- agent|user|system
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_audit_proposal ON proposal_audit(proposal_id, ts);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`

const VEC_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS captures_vec USING vec0(
  capture_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);
`

export interface OpenDbResult {
  db: DB
  vecAvailable: boolean
}

/**
 * Open and initialize the context store DB. Returns the connection plus a flag
 * indicating whether sqlite-vec loaded (false → vector search disabled, FTS still works).
 */
export function openDb(dbPath: string): OpenDbResult {
  mkdirSync(dirname(dbPath), { recursive: true })
  // enableLoadExtension is required for sqlite-vec
  const db = new Database(dbPath, { create: true })
  // bun:sqlite gates loadExtension behind a runtime flag
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  let vecAvailable = false
  try {
    sqliteVec.load(db)
    vecAvailable = true
  } catch (err) {
    console.warn(
      '[context-store] sqlite-vec failed to load — vector search disabled, FTS only:',
      (err as Error).message
    )
  }

  db.exec(SCHEMA_SQL)
  if (vecAvailable) {
    db.exec(VEC_SCHEMA_SQL)
  }

  recordMigration(db, SCHEMA_VERSION)
  return { db, vecAvailable }
}

function recordMigration(db: DB, version: number): void {
  db.run(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    [version, new Date().toISOString()]
  )
}
