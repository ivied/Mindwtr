/**
 * Hybrid retrieval over events: FTS5 (BM25) + sqlite-vec (cosine) fused
 * via Reciprocal Rank Fusion (RRF). The classic recipe from Cormack et
 * al. 2009 — fuses ranked lists without needing comparable raw scores.
 *
 *   score_rrf(item) = Σ_channel 1 / (k + rank_channel(item))
 *
 * k=60 is the empirical sweet spot (slightly down-weights deep tails).
 *
 * Returns up to `limit` events sorted by RRF score descending. Ties are
 * broken by event recency. If sqlite-vec is unavailable, falls back to
 * FTS-only ranks (which is still useful).
 */

import type { Database } from 'bun:sqlite'
import { embeddingToBytes, type EmbeddingsProvider } from '../context-store/embeddings'
import type { MemoryStore } from './store'
import type { Event, RetrievedEvent } from './types'

const RRF_K = 60

export interface RetrieveOptions {
  query: string
  /** Number of candidates per channel before fusion. Default 40. */
  perChannel?: number
  /** Final result cap. Default 20. */
  limit?: number
  /** Restrict to events within the last N days. Optional. */
  withinDays?: number
  /** Restrict to events tagged with any of these entity slugs. Optional. */
  entitySlugs?: string[]
}

interface CandidateRow {
  id: string
  rank: number
}

export class HybridRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingsProvider | null
  ) {}

  async retrieve(opts: RetrieveOptions): Promise<RetrievedEvent[]> {
    const perChannel = opts.perChannel ?? 40
    const limit = opts.limit ?? 20

    const ftsCandidates = ftsSearch(this.store.db, opts.query, perChannel, opts)
    const vecCandidates =
      this.embeddings && this.store.vecAvailable
        ? await vecSearch(this.store.db, this.embeddings, opts.query, perChannel, opts)
        : []

    const fused = rrfFuse([
      { name: 'fts', candidates: ftsCandidates },
      { name: 'vec', candidates: vecCandidates },
    ])

    if (fused.length === 0) return []
    const topIds = fused.slice(0, limit)
    const events = loadEventsById(
      this.store.db,
      topIds.map((c) => c.id)
    )
    const byId = new Map(events.map((e) => [e.id, e]))

    return topIds.flatMap((c) => {
      const ev = byId.get(c.id)
      if (!ev) return []
      return [{ ...ev, score: c.score, ranks: c.ranks }]
    })
  }
}

// ---------------- channel: FTS5 (BM25) ----------------

function ftsSearch(
  db: Database,
  query: string,
  perChannel: number,
  filters: { withinDays?: number; entitySlugs?: string[] }
): CandidateRow[] {
  const ftsQ = toFtsQuery(query)
  if (!ftsQ) return []

  const params: Array<string | number> = [ftsQ]
  let sql = `
    SELECT events.id AS id, events_fts.rank AS rank
    FROM events_fts
    JOIN events ON events.rowid = events_fts.rowid
    WHERE events_fts MATCH ?
  `
  if (filters.withinDays && filters.withinDays > 0) {
    const since = new Date(Date.now() - filters.withinDays * 86_400_000).toISOString()
    sql += ' AND events.ts >= ?'
    params.push(since)
  }
  if (filters.entitySlugs && filters.entitySlugs.length > 0) {
    sql += ` AND events.id IN (
      SELECT event_id FROM event_entities WHERE entity_slug IN (${filters.entitySlugs.map(() => '?').join(',')})
    )`
    params.push(...filters.entitySlugs)
  }
  sql += ' ORDER BY events_fts.rank ASC LIMIT ?'
  params.push(perChannel)

  try {
    return db.query<{ id: string; rank: number }, (string | number)[]>(sql).all(...params)
  } catch (err) {
    // bad FTS syntax in query → return empty rather than blow up
    console.warn('[memory:retrieve] FTS query failed:', (err as Error).message)
    return []
  }
}

/**
 * FTS5 query syntax doesn't like punctuation. Tokenize generously: split
 * on non-word chars, drop stopwords-of-length-1, join with OR. Quote
 * tokens that look like identifiers (contain dot/dash).
 */
function toFtsQuery(s: string): string {
  const tokens = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}.\-_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return ''
  return tokens
    .map((t) => (t.includes('.') || t.includes('-') || t.includes('_') ? `"${t}"` : t))
    .join(' OR ')
}

// ---------------- channel: vector ----------------

async function vecSearch(
  db: Database,
  embeddings: EmbeddingsProvider,
  query: string,
  perChannel: number,
  filters: { withinDays?: number; entitySlugs?: string[] }
): Promise<CandidateRow[]> {
  const vec = await embeddings.embed(query)
  // sqlite-vec returns rows by distance ascending; we keep that as rank.
  // Filters are applied with a join.
  const params: Array<string | number | Uint8Array> = [embeddingToBytes(vec), perChannel * 3]
  let inner = `
    SELECT events_vec.event_id AS id, events_vec.distance AS distance
    FROM events_vec
    WHERE events_vec.embedding MATCH ? AND k = ?
    ORDER BY distance
  `
  let sql = `
    SELECT inner.id AS id, ROW_NUMBER() OVER (ORDER BY inner.distance) AS rank
    FROM (${inner}) AS inner
    JOIN events ON events.id = inner.id
    WHERE 1=1
  `
  if (filters.withinDays && filters.withinDays > 0) {
    const since = new Date(Date.now() - filters.withinDays * 86_400_000).toISOString()
    sql += ' AND events.ts >= ?'
    params.push(since)
  }
  if (filters.entitySlugs && filters.entitySlugs.length > 0) {
    sql += ` AND events.id IN (
      SELECT event_id FROM event_entities WHERE entity_slug IN (${filters.entitySlugs.map(() => '?').join(',')})
    )`
    params.push(...filters.entitySlugs)
  }
  sql += ' ORDER BY rank LIMIT ?'
  params.push(perChannel)

  try {
    return db
      .query<{ id: string; rank: number }, (string | number | Uint8Array)[]>(sql)
      .all(...params)
  } catch (err) {
    console.warn('[memory:retrieve] vec query failed:', (err as Error).message)
    return []
  }
}

// ---------------- fusion ----------------

interface FusedRow {
  id: string
  score: number
  ranks: { fts?: number; vec?: number }
}

function rrfFuse(channels: Array<{ name: 'fts' | 'vec'; candidates: CandidateRow[] }>): FusedRow[] {
  const scores = new Map<string, FusedRow>()
  for (const ch of channels) {
    ch.candidates.forEach((c, idx) => {
      const rank = idx + 1 // 1-based rank within this channel
      const contribution = 1 / (RRF_K + rank)
      const cur = scores.get(c.id) ?? { id: c.id, score: 0, ranks: {} }
      cur.score += contribution
      cur.ranks[ch.name] = rank
      scores.set(c.id, cur)
    })
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}

// ---------------- helpers ----------------

function loadEventsById(db: Database, ids: string[]): Event[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .query<
      {
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
      },
      string[]
    >(`SELECT * FROM events WHERE id IN (${placeholders})`)
    .all(...ids)
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    source: r.source,
    app: r.app,
    title: r.title,
    body: r.body,
    meta: r.meta ? safeJson(r.meta) : null,
    capturePath: r.capture_path,
    contentHash: r.content_hash,
    ingestedAt: r.ingested_at,
  }))
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
}
