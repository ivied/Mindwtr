/**
 * Context Store API.
 *
 * Single ingestion path for all captures (push + pull). Provides:
 *   - insert(item)        — write capture, dedup L2 (hash) + L3 (semantic via embedding)
 *   - searchVec(query)    — semantic top-K via sqlite-vec
 *   - searchFts(query)    — keyword top-K via FTS5 (fallback when embeddings unavailable)
 *   - retrieve(query)     — high-level: vec if available, otherwise FTS, returns formatted hits
 *   - purgeExpired()      — drop captures past ttl_at (called periodically)
 */

import { createHash, randomUUID } from 'node:crypto'
import type { CapturedItem } from '../capture/normalizer'
import { openDb, type DB } from './db'
import { cosine, embeddingToBytes, type EmbeddingsProvider } from './embeddings'
import type {
  CaptureRecord,
  ContextStoreConfig,
  InsertResult,
  SearchHit,
  SearchOptions,
} from './types'
import { DEFAULT_CONTEXT_STORE_CONFIG } from './types'

const PULL_CHANNELS = new Set<CapturedItem['sourceChannel']>([
  'screen_capture',
])

const L3_SIMILARITY_THRESHOLD = 0.95

interface CaptureRow {
  id: string
  text: string
  source_channel: string
  source_meta: string | null
  captured_at: string
  received_at: string
  content_hash: string
  ttl_at: string
  is_pull: number
  rowid?: number
}

export class ContextStore {
  private db: DB
  private vecAvailable: boolean
  private config: ContextStoreConfig
  /** Optional. When set, insert() computes embeddings + L3 dedup; retrieve() uses vec search. */
  embeddings: EmbeddingsProvider | null

  private constructor(
    db: DB,
    vecAvailable: boolean,
    config: ContextStoreConfig,
    embeddings: EmbeddingsProvider | null
  ) {
    this.db = db
    this.vecAvailable = vecAvailable
    this.config = config
    this.embeddings = embeddings
  }

  static open(
    config: Partial<ContextStoreConfig> = {},
    embeddings: EmbeddingsProvider | null = null
  ): ContextStore {
    const merged = { ...DEFAULT_CONTEXT_STORE_CONFIG, ...config }
    const { db, vecAvailable } = openDb(merged.dbPath)
    return new ContextStore(db, vecAvailable, merged, embeddings)
  }

  get hasVectorSearch(): boolean {
    return this.vecAvailable && this.embeddings !== null
  }

  /**
   * Insert a capture. Performs L2 dedup (content hash within window). When
   * embeddings are configured AND vec is available, also runs L3 (semantic
   * similarity > 0.95 within window → drop, treat as duplicate).
   */
  async insert(item: CapturedItem): Promise<InsertResult> {
    const text = item.text.trim()
    const contentHash = sha1(`${item.sourceChannel}\n${text}`)
    const receivedAt = new Date().toISOString()

    const dupL2 = this.findRecentByHash(contentHash, this.config.l2WindowMs, receivedAt)
    if (dupL2) {
      return { inserted: false, capture: rowToRecord(dupL2) }
    }

    let embedding: Float32Array | null = null
    if (this.embeddings && this.vecAvailable) {
      try {
        embedding = await this.embeddings.embed(text)
        const dupL3 = this.findRecentBySimilarity(embedding, this.config.l2WindowMs, receivedAt)
        if (dupL3) {
          return { inserted: false, capture: dupL3 }
        }
      } catch (err) {
        console.warn('[context-store] embedding failed, inserting without vec:', err)
        embedding = null
      }
    }

    const id = randomUUID()
    const ttlAt = new Date(Date.parse(receivedAt) + this.config.ttlMs).toISOString()
    const isPull = PULL_CHANNELS.has(item.sourceChannel) ? 1 : 0

    this.db.run(
      `INSERT INTO captures (id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        text,
        item.sourceChannel,
        item.sourceMeta ? JSON.stringify(item.sourceMeta) : null,
        item.timestamp,
        receivedAt,
        contentHash,
        ttlAt,
        isPull,
      ]
    )

    if (embedding) {
      this.db.run(
        'INSERT INTO captures_vec (capture_id, embedding) VALUES (?, ?)',
        [id, embeddingToBytes(embedding)]
      )
    }

    return {
      inserted: true,
      capture: {
        id,
        text,
        sourceChannel: item.sourceChannel,
        sourceMeta: item.sourceMeta ?? null,
        capturedAt: item.timestamp,
        receivedAt,
        contentHash,
        ttlAt,
        isPull: isPull === 1,
      },
    }
  }

  /**
   * Semantic search via sqlite-vec. Returns empty array when vec is unavailable.
   */
  async searchVec(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (!this.embeddings || !this.vecAvailable) return []
    const topK = opts.topK ?? 5
    const queryEmbedding = await this.embeddings.embed(query)

    const rows = this.db
      .query<{ capture_id: string; distance: number }, [Buffer, number]>(
        `SELECT capture_id, distance FROM captures_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(embeddingToBytes(queryEmbedding), topK * 3)

    if (rows.length === 0) return []

    const captureMap = this.fetchCapturesByIds(rows.map((r) => r.capture_id))
    const hits: SearchHit[] = []

    for (const row of rows) {
      const capture = captureMap.get(row.capture_id)
      if (!capture) continue
      if (!matchesFilters(capture, opts)) continue
      hits.push({
        capture: rowToRecord(capture),
        score: 1 - row.distance, // sqlite-vec returns L2 distance for normalized vectors ≈ 2*(1-cosine), approx
        via: 'vec',
      })
      if (hits.length >= topK) break
    }
    return hits
  }

  /**
   * Keyword fallback search via FTS5. Lossy match5 syntax: query is escaped to phrase.
   */
  searchFts(query: string, opts: SearchOptions = {}): SearchHit[] {
    const topK = opts.topK ?? 5
    const ftsQuery = ftsEscape(query)
    if (!ftsQuery) return []

    const rows = this.db
      .query<{ rowid: number }, [string, number]>(
        `SELECT rowid FROM captures_fts WHERE captures_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, topK * 3)

    if (rows.length === 0) return []

    const captureRows = this.db
      .query<CaptureRow, number[]>(
        `SELECT id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull, rowid
         FROM captures WHERE rowid IN (${rows.map(() => '?').join(',')})`
      )
      .all(...rows.map((r) => r.rowid))

    const hits: SearchHit[] = []
    for (const row of captureRows) {
      if (!matchesFilters(row, opts)) continue
      hits.push({ capture: rowToRecord(row), score: null, via: 'fts' })
      if (hits.length >= topK) break
    }
    return hits
  }

  /**
   * High-level retrieval: vec when available, FTS otherwise.
   */
  async retrieve(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (this.hasVectorSearch) {
      const vec = await this.searchVec(query, opts)
      if (vec.length > 0) return vec
    }
    return this.searchFts(query, opts)
  }

  /**
   * Drop expired captures (ttl_at < now). Returns deleted count.
   * Uses count-before/after because db.run().changes includes cascaded
   * trigger changes (FTS5), inflating the number.
   */
  purgeExpired(): number {
    const now = new Date().toISOString()
    const before = this.size()
    this.db.run('DELETE FROM captures WHERE ttl_at < ?', [now])
    const after = this.size()
    return before - after
  }

  /** Total count for diagnostics. */
  size(): number {
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM captures`).get()
    return row?.n ?? 0
  }

  close(): void {
    this.db.close()
  }

  // --- internal helpers ---

  private findRecentByHash(
    contentHash: string,
    windowMs: number,
    nowIso: string
  ): CaptureRow | null {
    const since = new Date(Date.parse(nowIso) - windowMs).toISOString()
    return (
      this.db
        .query<CaptureRow, [string, string]>(
          `SELECT id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull
           FROM captures WHERE content_hash = ? AND received_at >= ? LIMIT 1`
        )
        .get(contentHash, since) ?? null
    )
  }

  private findRecentBySimilarity(
    embedding: Float32Array,
    windowMs: number,
    nowIso: string
  ): CaptureRecord | null {
    if (!this.vecAvailable) return null
    const since = new Date(Date.parse(nowIso) - windowMs).toISOString()

    // KNN over recent items only — limit pool to reduce cost
    const candidates = this.db
      .query<{ capture_id: string; distance: number }, [Buffer, number]>(
        `SELECT capture_id, distance FROM captures_vec
         WHERE embedding MATCH ? AND k = ?`
      )
      .all(embeddingToBytes(embedding), 5)

    for (const c of candidates) {
      const row = this.db
        .query<CaptureRow, [string, string]>(
          `SELECT id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull
           FROM captures WHERE id = ? AND received_at >= ? LIMIT 1`
        )
        .get(c.capture_id, since)
      if (!row) continue
      // Re-validate using exact cosine — sqlite-vec returns L2, not always reliable for threshold
      const otherVec = this.fetchEmbedding(c.capture_id)
      if (!otherVec) continue
      const sim = cosine(embedding, otherVec)
      if (sim >= L3_SIMILARITY_THRESHOLD) {
        return rowToRecord(row)
      }
    }
    return null
  }

  private fetchEmbedding(captureId: string): Float32Array | null {
    const row = this.db
      .query<{ embedding: Buffer }, [string]>(
        `SELECT embedding FROM captures_vec WHERE capture_id = ?`
      )
      .get(captureId)
    if (!row) return null
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
  }

  private fetchCapturesByIds(ids: string[]): Map<string, CaptureRow> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .query<CaptureRow, string[]>(
        `SELECT id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull
         FROM captures WHERE id IN (${placeholders})`
      )
      .all(...ids)
    const map = new Map<string, CaptureRow>()
    for (const r of rows) map.set(r.id, r)
    return map
  }
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function rowToRecord(row: CaptureRow): CaptureRecord {
  return {
    id: row.id,
    text: row.text,
    sourceChannel: row.source_channel as CapturedItem['sourceChannel'],
    sourceMeta: row.source_meta ? (JSON.parse(row.source_meta) as Record<string, unknown>) : null,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    contentHash: row.content_hash,
    ttlAt: row.ttl_at,
    isPull: row.is_pull === 1,
  }
}

function matchesFilters(row: CaptureRow, opts: SearchOptions): boolean {
  if (opts.sourceFilter && opts.sourceFilter.length > 0) {
    if (!opts.sourceFilter.some((sf) => row.source_channel.includes(sf))) return false
  }
  if (opts.withinMs !== undefined) {
    const ageMs = Date.now() - Date.parse(row.received_at)
    if (ageMs > opts.withinMs) return false
  }
  return true
}

function ftsEscape(query: string): string {
  // Tokenize on non-word chars, drop tokens shorter than 3 chars, lowercase.
  // Each token is wrapped in quotes (defensive against FTS5 reserved words);
  // tokens are joined with OR for broad recall.
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"`).join(' OR ')
}
