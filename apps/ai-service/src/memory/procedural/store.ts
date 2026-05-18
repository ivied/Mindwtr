/**
 * SQLite-backed CRUD for procedural memory chunks (FR85, Phase 0).
 *
 * Tables (declared in context-store/db.ts schema v4):
 *   procedural_chunks       — primary rows
 *   procedural_chunks_fts   — FTS5 lexical index (auto-synced via triggers)
 *   procedural_chunks_vec   — sqlite-vec channel (app-level sync)
 *
 * Idempotent upsert: caller computes `id = sha256(source||path||index||content_hash)`.
 * Same id → no-op. Different id for same (source, path, section_index) → replaces
 * (via deleteChunksAt + insert).
 */

import type { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { embeddingToBytes } from '../../context-store/embeddings'

export interface ProceduralChunkRow {
  id: string
  source: string
  path: string
  sectionIndex: number
  sectionTitle: string | null
  text: string
  contentHash: string
  fileMtime: number
  indexedAt: string
  /** v5: visibility class — only 'universal' / 'mindwtr-only' chunks are
   *  surfaced to the Proposer by default. */
  appliesTo: AppliesTo
  reliabilityScore: number | null
  classifiedBy: ClassifiedBy
  classifiedAt: string | null
}

export type AppliesTo =
  | 'universal'
  | 'openclaw-only'
  | 'mindwtr-only'
  | 'archived'
  | 'needs-review'

export type ClassifiedBy = 'heuristic' | 'llm' | 'user' | null

/** Raw row shape as stored in SQLite (snake_case columns). */
interface ProceduralChunkDbRow {
  id: string
  source: string
  path: string
  section_index: number
  section_title: string | null
  text: string
  content_hash: string
  file_mtime: number
  indexed_at: string
  applies_to: string
  reliability_score: number | null
  classified_by: string | null
  classified_at: string | null
}

export interface ProceduralStoreOptions {
  db: Database
  vecAvailable: boolean
}

export interface UpsertInput {
  source: string
  path: string
  sectionIndex: number
  sectionTitle: string | null
  text: string
  fileMtime: number
  embedding?: Float32Array | null
  /** Pre-classified verdict from the heuristic. Defaults to 'needs-review'
   *  on fresh inserts. On update of an existing row, the prior classification
   *  is preserved (re-classifying changed content stays caller's job). */
  appliesTo?: AppliesTo
  classifiedBy?: ClassifiedBy
}

export class ProceduralStore {
  readonly db: Database
  readonly vecAvailable: boolean

  constructor(opts: ProceduralStoreOptions) {
    this.db = opts.db
    this.vecAvailable = opts.vecAvailable
  }

  /**
   * Idempotent insert/replace at (source, path, section_index).
   * Returns the row's stable id so callers can correlate.
   * The embedding parameter is optional — caller can pass null when
   * embeddings are not available; vector retrieval will skip those rows
   * gracefully.
   */
  upsert(input: UpsertInput): string {
    const contentHash = createHash('sha256').update(input.text).digest('hex')
    const id = createHash('sha256')
      .update(`${input.source} ${input.path} ${input.sectionIndex} ${contentHash}`)
      .digest('hex')

    const existing = this.db
      .query<{ id: string }, [string, string, number]>(
        'SELECT id FROM procedural_chunks WHERE source = ? AND path = ? AND section_index = ?'
      )
      .get(input.source, input.path, input.sectionIndex)

    if (existing && existing.id === id) {
      // Same content; refresh mtime/indexed_at only.
      this.db.run(
        'UPDATE procedural_chunks SET file_mtime = ?, indexed_at = ? WHERE id = ?',
        [input.fileMtime, new Date().toISOString(), id]
      )
      return id
    }

    // Different content — replace.
    if (existing) {
      this.deleteById(existing.id)
    }

    const appliesTo: AppliesTo = input.appliesTo ?? 'needs-review'
    const classifiedBy: ClassifiedBy = input.classifiedBy ?? null
    const classifiedAt = classifiedBy ? new Date().toISOString() : null
    this.db.run(
      `INSERT INTO procedural_chunks
       (id, source, path, section_index, section_title, text, content_hash, file_mtime, indexed_at,
        applies_to, classified_by, classified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.source,
        input.path,
        input.sectionIndex,
        input.sectionTitle,
        input.text,
        contentHash,
        input.fileMtime,
        new Date().toISOString(),
        appliesTo,
        classifiedBy,
        classifiedAt,
      ]
    )

    if (this.vecAvailable && input.embedding) {
      this.db.run(
        'INSERT INTO procedural_chunks_vec(chunk_id, embedding) VALUES (?, ?)',
        [id, embeddingToBytes(input.embedding)]
      )
    }
    return id
  }

  /**
   * Update the visibility class of an existing chunk. Used by the LLM
   * classifier batch (Phase 0.5) and by user-confirmation flow.
   */
  classify(
    id: string,
    appliesTo: AppliesTo,
    classifiedBy: ClassifiedBy
  ): void {
    this.db.run(
      `UPDATE procedural_chunks
       SET applies_to = ?, classified_by = ?, classified_at = ?
       WHERE id = ?`,
      [appliesTo, classifiedBy, new Date().toISOString(), id]
    )
  }

  // ---------------- FR89: reliability feedback ----------------

  /**
   * Record which chunks the Proposer cited when it produced `proposalId`.
   * Idempotent (PRIMARY KEY (proposal_id, chunk_id)). No-op on empty list.
   */
  recordProposalRefs(proposalId: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO procedural_proposal_refs
         (proposal_id, chunk_id, recorded_at) VALUES (?, ?, ?)`
    )
    for (const cid of chunkIds) stmt.run(proposalId, cid, now)
  }

  /**
   * Apply a resolution signal to every chunk the proposal cited. EMA so
   * one noisy data point can't bury a good rule:
   *
   *   score' = score == null ? SEED[signal]
   *                          : score + ALPHA * (TARGET[signal] - score)
   *
   * `positive` (proposal approved / already-done — AI was useful) pulls
   * toward 1.0; `negative` (plain reject — AI was wrong) toward 0.0.
   * `not-applicable` is intentionally NOT fed here (neither chunk's
   * fault). Returns the number of chunks updated (for logging).
   *
   * NOTE: this is an *implicit, weak* signal — a proposal can be rejected
   * for reasons unrelated to the cited rule. ALPHA is deliberately small
   * and Phase 1b.1 does NOT let the score affect retrieval yet; we only
   * accumulate so the signal can be eyeballed before acting on it
   * (Phase 1b.2).
   */
  applyResolutionFeedback(
    proposalId: string,
    signal: 'positive' | 'negative'
  ): number {
    const ALPHA = 0.2
    const SEED = signal === 'positive' ? 0.6 : 0.4
    const TARGET = signal === 'positive' ? 1.0 : 0.0
    const refs = this.db
      .query<{ chunk_id: string }, [string]>(
        'SELECT chunk_id FROM procedural_proposal_refs WHERE proposal_id = ?'
      )
      .all(proposalId)
    let updated = 0
    for (const { chunk_id } of refs) {
      const row = this.db
        .query<{ reliability_score: number | null }, [string]>(
          'SELECT reliability_score FROM procedural_chunks WHERE id = ?'
        )
        .get(chunk_id)
      if (!row) continue // chunk re-chunked away since citation; skip
      const cur = row.reliability_score
      const next =
        cur == null ? SEED : cur + ALPHA * (TARGET - cur)
      this.db.run(
        'UPDATE procedural_chunks SET reliability_score = ? WHERE id = ?',
        [next, chunk_id]
      )
      updated += 1
    }
    return updated
  }

  /** Aggregate reliability stats for the review dashboard / telemetry. */
  reliabilitySummary(): {
    scored: number
    avg: number | null
    min: number | null
    belowHalf: number
  } {
    const r = this.db
      .query<
        { n: number; avg: number | null; mn: number | null; lo: number },
        []
      >(
        `SELECT count(reliability_score) AS n,
                avg(reliability_score) AS avg,
                min(reliability_score) AS mn,
                sum(CASE WHEN reliability_score < 0.5 THEN 1 ELSE 0 END) AS lo
         FROM procedural_chunks`
      )
      .get()
    return {
      scored: r?.n ?? 0,
      avg: r?.avg ?? null,
      min: r?.mn ?? null,
      belowHalf: r?.lo ?? 0,
    }
  }

  /** Fetch a single chunk by id, or null. */
  getById(id: string): ProceduralChunkRow | null {
    const r = this.db
      .query<ProceduralChunkDbRow, [string]>(
        `SELECT id, source, path, section_index, section_title, text,
                content_hash, file_mtime, indexed_at,
                applies_to, reliability_score, classified_by, classified_at
         FROM procedural_chunks WHERE id = ?`
      )
      .get(id)
    return r ? rowToRecord(r) : null
  }

  /**
   * Paged listing for the review API (FR88). Optional filters by
   * visibility class and source. Ordered by section then sub-index so
   * sub-chunks of the same `##` appear together.
   */
  listChunks(opts: {
    applies?: AppliesTo[]
    source?: string
    limit?: number
    offset?: number
  } = {}): { total: number; items: ProceduralChunkRow[] } {
    const where: string[] = []
    const params: Array<string | number> = []
    if (opts.applies && opts.applies.length > 0) {
      where.push(`applies_to IN (${opts.applies.map(() => '?').join(',')})`)
      params.push(...opts.applies)
    }
    if (opts.source) {
      where.push('source = ?')
      params.push(opts.source)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total =
      this.db
        .query<{ n: number }, Array<string | number>>(
          `SELECT count(*) AS n FROM procedural_chunks ${whereSql}`
        )
        .get(...params)?.n ?? 0
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    const offset = Math.max(opts.offset ?? 0, 0)
    const items = this.db
      .query<ProceduralChunkDbRow, Array<string | number>>(
        `SELECT id, source, path, section_index, section_title, text,
                content_hash, file_mtime, indexed_at,
                applies_to, reliability_score, classified_by, classified_at
         FROM procedural_chunks ${whereSql}
         ORDER BY source, path, section_index
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map(rowToRecord)
    return { total, items }
  }

  /**
   * List chunks in a given visibility class. Used by the heuristic
   * back-pass (which is idempotent so re-seeing a row is harmless).
   */
  listByApplies(applies: AppliesTo, limit = 100): ProceduralChunkRow[] {
    return this.db
      .query<ProceduralChunkDbRow, [string, number]>(
        `SELECT id, source, path, section_index, section_title, text,
                content_hash, file_mtime, indexed_at,
                applies_to, reliability_score, classified_by, classified_at
         FROM procedural_chunks
         WHERE applies_to = ?
         ORDER BY indexed_at ASC
         LIMIT ?`
      )
      .all(applies, limit)
      .map(rowToRecord)
  }

  /**
   * Workload for the LLM classifier: chunks still 'needs-review' that the
   * LLM hasn't already adjudicated. A chunk classified_by='llm' is
   * terminal — even when the verdict was 'needs-review' (e.g. a bare
   * heading with no content), the LLM has spoken; re-asking every tick
   * just burns tokens. classified_by='user' is likewise terminal.
   * Only NULL (untouched) or 'heuristic' (heuristic found no signal)
   * rows are eligible.
   *
   * A content change resets the row via the upsert path (new id, fresh
   * heuristic verdict, classified_by back to 'heuristic'/'needs-review'),
   * so genuinely-changed chunks re-enter this queue naturally.
   */
  listPendingLlmClassification(limit = 100): ProceduralChunkRow[] {
    return this.db
      .query<ProceduralChunkDbRow, [number]>(
        `SELECT id, source, path, section_index, section_title, text,
                content_hash, file_mtime, indexed_at,
                applies_to, reliability_score, classified_by, classified_at
         FROM procedural_chunks
         WHERE applies_to = 'needs-review'
           AND (classified_by IS NULL OR classified_by = 'heuristic')
         ORDER BY indexed_at ASC
         LIMIT ?`
      )
      .all(limit)
      .map(rowToRecord)
  }

  deleteById(id: string): void {
    if (this.vecAvailable) {
      this.db.run('DELETE FROM procedural_chunks_vec WHERE chunk_id = ?', [id])
    }
    this.db.run('DELETE FROM procedural_chunks WHERE id = ?', [id])
  }

  /**
   * Remove rows from a single source/path that have section_index >= keepCount.
   * Used after re-chunking a file: insert the new chunks 0..N-1, then drop
   * any leftover rows from a previously longer version of the file.
   */
  truncateAbove(source: string, path: string, keepCount: number): void {
    const stale = this.db
      .query<{ id: string }, [string, string, number]>(
        'SELECT id FROM procedural_chunks WHERE source = ? AND path = ? AND section_index >= ?'
      )
      .all(source, path, keepCount)
    for (const r of stale) this.deleteById(r.id)
  }

  /**
   * Delete all rows for a file that no longer exists on disk.
   */
  deleteByPath(source: string, path: string): void {
    const rows = this.db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM procedural_chunks WHERE source = ? AND path = ?'
      )
      .all(source, path)
    for (const r of rows) this.deleteById(r.id)
  }

  listKnownPaths(source: string): Array<{ path: string; fileMtime: number }> {
    return this.db
      .query<{ path: string; file_mtime: number }, [string]>(
        'SELECT path, MAX(file_mtime) AS file_mtime FROM procedural_chunks WHERE source = ? GROUP BY path'
      )
      .all(source)
      .map((r) => ({ path: r.path, fileMtime: r.file_mtime }))
  }

  countChunks(): number {
    const r = this.db
      .query<{ n: number }, []>('SELECT count(*) AS n FROM procedural_chunks')
      .get()
    return r?.n ?? 0
  }

  /**
   * Fetch rows by id list, preserving the input order.
   */
  loadByIds(ids: string[]): ProceduralChunkRow[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .query<ProceduralChunkDbRow, string[]>(
        `SELECT id, source, path, section_index, section_title, text,
                content_hash, file_mtime, indexed_at,
                applies_to, reliability_score, classified_by, classified_at
         FROM procedural_chunks WHERE id IN (${placeholders})`
      )
      .all(...ids)
    const byId = new Map(rows.map((r) => [r.id, rowToRecord(r)]))
    return ids.flatMap((id) => {
      const r = byId.get(id)
      return r ? [r] : []
    })
  }
}

function rowToRecord(r: ProceduralChunkDbRow): ProceduralChunkRow {
  return {
    id: r.id,
    source: r.source,
    path: r.path,
    sectionIndex: r.section_index,
    sectionTitle: r.section_title,
    text: r.text,
    contentHash: r.content_hash,
    fileMtime: r.file_mtime,
    indexedAt: r.indexed_at,
    appliesTo: (r.applies_to as AppliesTo) ?? 'needs-review',
    reliabilityScore: r.reliability_score,
    classifiedBy: (r.classified_by as ClassifiedBy) ?? null,
    classifiedAt: r.classified_at,
  }
}
