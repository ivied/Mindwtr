/**
 * Storage layer for the memory module. Shares the same SQLite handle as
 * Context Store and Proposal Store — pass `contextStore.rawDb` in.
 *
 * Responsibilities (keep this thin — no LLM, no retrieval logic):
 *   - INSERT/SELECT events with FTS auto-sync via triggers
 *   - INSERT events_vec rows with the embedding bytes
 *   - Append-only facts CRUD + "supersede previous active fact" helper
 *   - Daily summary upsert
 *   - Cleanup helpers for tests
 */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { embeddingToBytes } from '../context-store/embeddings'
import type {
  DailySummary,
  Event,
  Fact,
  NewEventInput,
  NewFactInput,
} from './types'

export interface MemoryStoreOptions {
  /** Provided by ContextStore.rawDb so we share the same SQLite handle. */
  db: Database
  /** True if sqlite-vec loaded successfully. When false, vec writes/reads are skipped. */
  vecAvailable: boolean
}

interface EventRow {
  id: string
  ts: string
  source: string
  app: string | null
  title: string | null
  body: string
  meta: string | null
  capture_path: string | null
  content_hash: string
  ingested_at: string
}

interface FactRow {
  id: number
  statement: string
  entity_slug: string | null
  fact_type: string | null
  valid_from: string
  valid_to: string | null
  source_event_id: string | null
  confidence: number | null
  created_at: string
}

interface DailySummaryRow {
  date: string
  summary: string
  event_count: number
  facts_added: number
  created_at: string
}

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export class MemoryStore {
  constructor(private readonly opts: MemoryStoreOptions) {}

  get db(): Database {
    return this.opts.db
  }

  get vecAvailable(): boolean {
    return this.opts.vecAvailable
  }

  // -------- events --------

  /**
   * Insert a new event. Returns true if inserted, false if a row with the
   * same content_hash already exists (dedup). Idempotent on duplicate ids
   * — same id + same hash is a no-op; same id + different hash throws to
   * surface accidental overwrites.
   */
  insertEvent(input: NewEventInput, embedding: Float32Array | null): boolean {
    const hash = contentHash(input.body)
    const ingestedAt = new Date().toISOString()

    // Dedup by content hash → don't re-embed the same body.
    const dup = this.db
      .query<{ id: string }, [string]>(
        'SELECT id FROM events WHERE content_hash = ? LIMIT 1'
      )
      .get(hash)
    if (dup) return false

    try {
      this.db
        .query(
          `INSERT INTO events (id, ts, source, app, title, body, meta, capture_path, content_hash, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.ts,
          input.source,
          input.app ?? null,
          input.title ?? null,
          input.body,
          input.meta ? JSON.stringify(input.meta) : null,
          input.capturePath ?? null,
          hash,
          ingestedAt
        )
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('UNIQUE constraint failed: events.id')) {
        // same id but different body — caller should pick a fresh id
        throw new Error(
          `event id "${input.id}" already exists with a different body — refusing to overwrite`
        )
      }
      throw err
    }

    if (embedding && this.vecAvailable) {
      this.db
        .query('INSERT OR REPLACE INTO events_vec (event_id, embedding) VALUES (?, ?)')
        .run(input.id, embeddingToBytes(embedding))
    }
    return true
  }

  /** Attach entity slugs to an event (idempotent). */
  linkEntities(eventId: string, slugs: string[]): void {
    if (slugs.length === 0) return
    const stmt = this.db.query(
      'INSERT OR IGNORE INTO event_entities (event_id, entity_slug) VALUES (?, ?)'
    )
    this.db.transaction(() => {
      for (const slug of slugs) stmt.run(eventId, slug)
    })()
  }

  getEvent(id: string): Event | null {
    const row = this.db
      .query<EventRow, [string]>('SELECT * FROM events WHERE id = ?')
      .get(id)
    return row ? rowToEvent(row) : null
  }

  /** For test/admin use — count rows fast. */
  countEvents(): number {
    const r = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()
    return r?.n ?? 0
  }

  /** Date range scan, ts-ascending. */
  eventsBetween(startIso: string, endIso: string, limit = 5000): Event[] {
    const rows = this.db
      .query<EventRow, [string, string, number]>(
        'SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?'
      )
      .all(startIso, endIso, limit)
    return rows.map(rowToEvent)
  }

  // -------- facts --------

  /**
   * Insert a fact. If `supersedePrevious` is set, any currently-active fact
   * for the same (entitySlug, factType) is closed (valid_to set to the new
   * fact's valid_from) before the new one is inserted.
   */
  insertFact(input: NewFactInput, supersedePrevious = false): Fact {
    const createdAt = new Date().toISOString()

    if (supersedePrevious && input.entitySlug && input.factType) {
      this.db
        .query(
          `UPDATE facts
             SET valid_to = ?
           WHERE entity_slug = ?
             AND fact_type = ?
             AND valid_to IS NULL`
        )
        .run(input.validFrom, input.entitySlug, input.factType)
    }

    const inserted = this.db
      .query<{ id: number }, [string, string | null, string | null, string, string | null, number | null, string]>(
        `INSERT INTO facts (statement, entity_slug, fact_type, valid_from, source_event_id, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        input.statement,
        input.entitySlug ?? null,
        input.factType ?? null,
        input.validFrom,
        input.sourceEventId ?? null,
        input.confidence ?? null,
        createdAt
      )
    if (!inserted) throw new Error('insertFact: RETURNING returned nothing')

    return {
      id: inserted.id,
      statement: input.statement,
      entitySlug: input.entitySlug ?? null,
      factType: input.factType ?? null,
      validFrom: input.validFrom,
      validTo: null,
      sourceEventId: input.sourceEventId ?? null,
      confidence: input.confidence ?? null,
      createdAt,
    }
  }

  /** All currently-active facts for a slug. */
  activeFactsFor(entitySlug: string): Fact[] {
    const rows = this.db
      .query<FactRow, [string]>(
        'SELECT * FROM facts WHERE entity_slug = ? AND valid_to IS NULL ORDER BY valid_from DESC'
      )
      .all(entitySlug)
    return rows.map(rowToFact)
  }

  /** All currently-active facts across all slugs. */
  allActiveFacts(limit = 200): Fact[] {
    const rows = this.db
      .query<FactRow, [number]>(
        'SELECT * FROM facts WHERE valid_to IS NULL ORDER BY valid_from DESC LIMIT ?'
      )
      .all(limit)
    return rows.map(rowToFact)
  }

  countFacts(): number {
    const r = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM facts').get()
    return r?.n ?? 0
  }

  // -------- daily summary --------

  upsertDailySummary(s: DailySummary, embedding: Float32Array | null): void {
    this.db
      .query(
        `INSERT INTO daily_summary (date, summary, event_count, facts_added, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           summary = excluded.summary,
           event_count = excluded.event_count,
           facts_added = excluded.facts_added,
           created_at = excluded.created_at`
      )
      .run(s.date, s.summary, s.eventCount, s.factsAdded, s.createdAt)
    if (embedding && this.vecAvailable) {
      this.db
        .query(
          'INSERT OR REPLACE INTO daily_summary_vec (date, embedding) VALUES (?, ?)'
        )
        .run(s.date, embeddingToBytes(embedding))
    }
  }

  getDailySummary(date: string): DailySummary | null {
    const row = this.db
      .query<DailySummaryRow, [string]>('SELECT * FROM daily_summary WHERE date = ?')
      .get(date)
    return row
      ? {
          date: row.date,
          summary: row.summary,
          eventCount: row.event_count,
          factsAdded: row.facts_added,
          createdAt: row.created_at,
        }
      : null
  }

  /** Last N daily summaries, newest first. */
  recentDailySummaries(limit = 7): DailySummary[] {
    const rows = this.db
      .query<DailySummaryRow, [number]>(
        'SELECT * FROM daily_summary ORDER BY date DESC LIMIT ?'
      )
      .all(limit)
    return rows.map((r) => ({
      date: r.date,
      summary: r.summary,
      eventCount: r.event_count,
      factsAdded: r.facts_added,
      createdAt: r.created_at,
    }))
  }
}

// ---------------- row mappers ----------------

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    app: row.app,
    title: row.title,
    body: row.body,
    meta: row.meta ? safeJson(row.meta) : null,
    capturePath: row.capture_path,
    contentHash: row.content_hash,
    ingestedAt: row.ingested_at,
  }
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    statement: row.statement,
    entitySlug: row.entity_slug,
    factType: row.fact_type,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    sourceEventId: row.source_event_id,
    confidence: row.confidence,
    createdAt: row.created_at,
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
