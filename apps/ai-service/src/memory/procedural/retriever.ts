/**
 * Hybrid retrieval over procedural_chunks: FTS5 (BM25) + sqlite-vec
 * (cosine) fused via Reciprocal Rank Fusion (RRF). Same recipe as the
 * memory module's `HybridRetriever`, scoped to playbook chunks.
 *
 * Returns rows sorted by RRF score desc. If sqlite-vec is unavailable,
 * falls back to FTS-only (still useful).
 */

import type { Database } from 'bun:sqlite'
import {
  embeddingToBytes,
  type EmbeddingsProvider,
} from '../../context-store/embeddings'
import type { ProceduralChunkRow, ProceduralStore } from './store'

const RRF_K = 60

export interface RetrieveOptions {
  query: string
  /** Candidates per channel before fusion. Default 30. */
  perChannel?: number
  /** Final result cap. Default 8. */
  limit?: number
  /** Restrict to a single source (e.g. 'openclaw'). */
  source?: string
}

export interface RetrievedChunk extends ProceduralChunkRow {
  score: number
  ranks: { fts?: number; vec?: number }
}

export class ProceduralRetriever {
  constructor(
    private readonly store: ProceduralStore,
    private readonly embeddings: EmbeddingsProvider | null
  ) {}

  async retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
    const perChannel = opts.perChannel ?? 30
    const limit = opts.limit ?? 8

    const ftsCandidates = ftsSearch(this.store.db, opts.query, perChannel, opts.source)
    const vecCandidates =
      this.embeddings && this.store.vecAvailable
        ? await vecSearch(this.store.db, this.embeddings, opts.query, perChannel, opts.source)
        : []

    const fused = rrfFuse(ftsCandidates, vecCandidates)
    if (fused.length === 0) return []
    const topIds = fused.slice(0, limit)
    const rows = this.store.loadByIds(topIds.map((c) => c.id))
    const byId = new Map(rows.map((r) => [r.id, r]))
    return topIds.flatMap((c) => {
      const r = byId.get(c.id)
      if (!r) return []
      return [{ ...r, score: c.score, ranks: c.ranks }]
    })
  }
}

// ---------------- channel: FTS5 ----------------

function ftsSearch(
  db: Database,
  query: string,
  limit: number,
  source: string | undefined
): Array<{ id: string; rank: number }> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const ftsQuery = sanitizeFtsQuery(trimmed)
  if (!ftsQuery) return []
  try {
    const sql = source
      ? `SELECT c.id AS id, bm25(procedural_chunks_fts) AS r
         FROM procedural_chunks_fts
         JOIN procedural_chunks c ON c.rowid = procedural_chunks_fts.rowid
         WHERE procedural_chunks_fts MATCH ? AND c.source = ?
         ORDER BY r ASC
         LIMIT ?`
      : `SELECT c.id AS id, bm25(procedural_chunks_fts) AS r
         FROM procedural_chunks_fts
         JOIN procedural_chunks c ON c.rowid = procedural_chunks_fts.rowid
         WHERE procedural_chunks_fts MATCH ?
         ORDER BY r ASC
         LIMIT ?`
    const params: Array<string | number> = source ? [ftsQuery, source, limit] : [ftsQuery, limit]
    const rows = db
      .query<{ id: string; r: number }, Array<string | number>>(sql)
      .all(...params)
    return rows.map((r, idx) => ({ id: r.id, rank: idx }))
  } catch {
    return []
  }
}

/** Escape FTS5 syntax in a free-form query. */
function sanitizeFtsQuery(q: string): string {
  // Quote each whitespace-separated term so FTS5 treats it as a phrase
  // literal; strip surrounding quotes from the input. Drops terms < 2 chars.
  const terms = q
    .toLowerCase()
    .replace(/["()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 32)
  if (terms.length === 0) return ''
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

// ---------------- channel: vec ----------------

async function vecSearch(
  db: Database,
  embeddings: EmbeddingsProvider,
  query: string,
  limit: number,
  source: string | undefined
): Promise<Array<{ id: string; rank: number }>> {
  const trimmed = query.trim()
  if (!trimmed) return []
  let vec: Float32Array
  try {
    vec = await embeddings.embed(trimmed.slice(0, 8000))
  } catch {
    return []
  }
  try {
    const sql = source
      ? `SELECT v.chunk_id AS id, v.distance AS d
         FROM procedural_chunks_vec v
         JOIN procedural_chunks c ON c.id = v.chunk_id
         WHERE v.embedding MATCH ? AND k = ? AND c.source = ?
         ORDER BY v.distance ASC`
      : `SELECT chunk_id AS id, distance AS d
         FROM procedural_chunks_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance ASC`
    const params: Array<Uint8Array | number | string> = source
      ? [embeddingToBytes(vec), limit, source]
      : [embeddingToBytes(vec), limit]
    const rows = db
      .query<{ id: string; d: number }, Array<Uint8Array | number | string>>(sql)
      .all(...params)
    return rows.map((r, idx) => ({ id: r.id, rank: idx }))
  } catch {
    return []
  }
}

// ---------------- RRF fusion ----------------

function rrfFuse(
  fts: Array<{ id: string; rank: number }>,
  vec: Array<{ id: string; rank: number }>
): Array<{ id: string; score: number; ranks: { fts?: number; vec?: number } }> {
  const map = new Map<string, { score: number; ranks: { fts?: number; vec?: number } }>()
  for (const c of fts) {
    const e = map.get(c.id) ?? { score: 0, ranks: {} }
    e.score += 1 / (RRF_K + c.rank)
    e.ranks.fts = c.rank
    map.set(c.id, e)
  }
  for (const c of vec) {
    const e = map.get(c.id) ?? { score: 0, ranks: {} }
    e.score += 1 / (RRF_K + c.rank)
    e.ranks.vec = c.rank
    map.set(c.id, e)
  }
  return [...map.entries()]
    .map(([id, v]) => ({ id, score: v.score, ranks: v.ranks }))
    .sort((a, b) => b.score - a.score)
}
