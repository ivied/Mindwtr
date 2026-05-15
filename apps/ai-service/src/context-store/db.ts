/**
 * Context Store database layer — wraps bun:sqlite + sqlite-vec extension.
 * Owns connection, migrations, schema versioning.
 */

import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database

const SCHEMA_VERSION = 5

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

-- ---------------- Memory module (event+facts) ----------------
-- Distinct from \`captures\` (which is the short-TTL Context Store).
-- Events are long-lived per-capture rows used as the LLM-context corpus.
-- Backfilled once from wiki/captures/**/*.md, then appended at capture time.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,                  -- capture id (HHMMSS-source-<8hex> by convention)
  ts TEXT NOT NULL,                     -- ISO timestamp the capture happened
  source TEXT NOT NULL,                 -- screen|audio
  app TEXT,
  title TEXT,
  body TEXT NOT NULL,                   -- OCR text or transcript (truncated upstream if huge)
  meta TEXT,                            -- JSON: display_index, sent_to_inbox, etc.
  capture_path TEXT,                    -- path to wiki/captures/.../*.md if known
  content_hash TEXT NOT NULL,           -- sha256 of body for dedup
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_source_app ON events(source, app);
CREATE INDEX IF NOT EXISTS idx_events_content_hash ON events(content_hash);

-- FTS over body+title. content='events' keeps storage contentless (no row duplication).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title,
  body,
  content='events',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, body) VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, body) VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
END;

CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, body) VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
  INSERT INTO events_fts(rowid, title, body) VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

-- Many-to-many: which entities are mentioned in which events. Slug-only
-- pointer so this table doesn't bind us to the wiki .md format — entity
-- definitions stay in wiki/entities/<slug>.md.
CREATE TABLE IF NOT EXISTS event_entities (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_slug TEXT NOT NULL,
  PRIMARY KEY (event_id, entity_slug)
);
CREATE INDEX IF NOT EXISTS idx_event_entities_slug ON event_entities(entity_slug);

-- Facts: typed LLM-extracted statements about an entity with validity
-- windows. valid_to IS NULL → still active. fact_type is free-form (the
-- extractor picks from a hint list: working_on | waiting_on | met_with |
-- knows_about | location | role | status | other) — we don't enforce.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement TEXT NOT NULL,
  entity_slug TEXT,
  fact_type TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_slug);
CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to);

-- One LLM-written summary per calendar day. Embedded for query, but
-- mostly used as a cheap rollup so weekly/monthly context doesn't
-- require pulling thousands of events.
CREATE TABLE IF NOT EXISTS daily_summary (
  date TEXT PRIMARY KEY,                -- YYYY-MM-DD (UTC)
  summary TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  facts_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ---------------- Procedural memory (v4) ----------------
-- Markdown chunks from \`shared-memory/\` (initially OpenClaw's MEMORY.md
-- mirrored via rsync). Each chunk = one section of a source file, indexed
-- for hybrid retrieval and surfaced to the Proposer as KNOWN_PLAYBOOK.
--
-- Idempotent: \`id\` is sha256(source||path||section_index||content), so
-- re-importing an unchanged file is a no-op; replacing content yields a
-- new \`id\` and the stale one is deleted by the reader.
CREATE TABLE IF NOT EXISTS procedural_chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- 'openclaw' | 'notion' | 'mindwtr-derived' | ...
  path TEXT NOT NULL,                   -- relative path within source root ('MEMORY.md', 'journals/2026-05-14.md')
  section_index INTEGER NOT NULL,       -- 0..N within the file
  section_title TEXT,                   -- '## Slack' / heading text for prompt rendering
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_mtime INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  -- Phase 0.5 (schema v5): visibility classification.
  -- 'needs-review' — default for new chunks; NOT surfaced to Mindwtr Proposer
  --                  until classifier (heuristic / LLM / user) categorises.
  -- 'universal'    — applies to any assistant acting on Sergey's behalf.
  -- 'openclaw-only'— specific to OpenClaw runtime ([[skill_call]]s, its own
  --                  algorithm, cron job IDs it controls). Hidden from us.
  -- 'mindwtr-only' — added later by Mindwtr-side curation.
  -- 'archived'     — superseded / out-of-date; preserved for audit.
  applies_to TEXT NOT NULL DEFAULT 'needs-review',
  -- 0..1 score updated by usage feedback (Proposer used this rule → user
  -- confirmed/denied). NULL == no signal yet.
  reliability_score REAL,
  -- Provenance of the current classification: 'heuristic' | 'llm' | 'user' | null.
  classified_by TEXT,
  classified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proc_source ON procedural_chunks(source);
CREATE INDEX IF NOT EXISTS idx_proc_path ON procedural_chunks(source, path);
CREATE INDEX IF NOT EXISTS idx_proc_applies_to ON procedural_chunks(applies_to);

-- FTS5 over section_title + text (lexical channel).
CREATE VIRTUAL TABLE IF NOT EXISTS procedural_chunks_fts USING fts5(
  section_title,
  text,
  content='procedural_chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS procedural_chunks_fts_ai AFTER INSERT ON procedural_chunks BEGIN
  INSERT INTO procedural_chunks_fts(rowid, section_title, text)
  VALUES (new.rowid, COALESCE(new.section_title, ''), new.text);
END;

CREATE TRIGGER IF NOT EXISTS procedural_chunks_fts_ad AFTER DELETE ON procedural_chunks BEGIN
  INSERT INTO procedural_chunks_fts(procedural_chunks_fts, rowid, section_title, text)
  VALUES ('delete', old.rowid, COALESCE(old.section_title, ''), old.text);
END;

CREATE TRIGGER IF NOT EXISTS procedural_chunks_fts_au AFTER UPDATE ON procedural_chunks BEGIN
  INSERT INTO procedural_chunks_fts(procedural_chunks_fts, rowid, section_title, text)
  VALUES ('delete', old.rowid, COALESCE(old.section_title, ''), old.text);
  INSERT INTO procedural_chunks_fts(rowid, section_title, text)
  VALUES (new.rowid, COALESCE(new.section_title, ''), new.text);
END;
`

const VEC_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS captures_vec USING vec0(
  capture_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);

-- Memory module: parallel vec table for events. Keyed by events.id so
-- joins are direct. sqlite-vec's vec0 doesn't support FKs, so we rely
-- on application-level cleanup (events ON DELETE → also remove vec row).
CREATE VIRTUAL TABLE IF NOT EXISTS events_vec USING vec0(
  event_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);

-- And one over daily_summary.summary so weekly/monthly context lookups
-- can pull summary rows by semantic similarity.
CREATE VIRTUAL TABLE IF NOT EXISTS daily_summary_vec USING vec0(
  date TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);

-- Procedural memory vector channel. Keyed by procedural_chunks.id so
-- joins are direct. App-level cleanup keeps it consistent (DELETE on
-- procedural_chunks → also DELETE the vec row).
CREATE VIRTUAL TABLE IF NOT EXISTS procedural_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
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
  applyAdditiveMigrations(db)

  recordMigration(db, SCHEMA_VERSION)
  return { db, vecAvailable }
}

function recordMigration(db: DB, version: number): void {
  db.run(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    [version, new Date().toISOString()]
  )
}

/**
 * Apply idempotent ALTER TABLE migrations for already-existing databases.
 * `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL only fires on fresh DBs — when
 * we add columns to an existing table, we need explicit ALTERs guarded by
 * PRAGMA table_info checks.
 */
function applyAdditiveMigrations(db: DB): void {
  // v5: procedural_chunks gains applies_to + reliability_score + classified_by + classified_at.
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(procedural_chunks)")
    .all()
    .map((r) => r.name)
  if (!cols.includes('applies_to')) {
    db.run(
      "ALTER TABLE procedural_chunks ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'needs-review'"
    )
  }
  if (!cols.includes('reliability_score')) {
    db.run('ALTER TABLE procedural_chunks ADD COLUMN reliability_score REAL')
  }
  if (!cols.includes('classified_by')) {
    db.run('ALTER TABLE procedural_chunks ADD COLUMN classified_by TEXT')
  }
  if (!cols.includes('classified_at')) {
    db.run('ALTER TABLE procedural_chunks ADD COLUMN classified_at TEXT')
  }
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_proc_applies_to ON procedural_chunks(applies_to)'
  )
}
