/**
 * Keeps the vec0 tables small enough to scan.
 *
 * sqlite-vec searches by reading every stored vector, and it never gives
 * space back: a deleted row leaves its slot in the chunk, and the chunk is
 * still read. So the tables are rebuilt — copied into fresh ones — when
 *   - they were created with another vector length (1536 → EMBEDDING_DIMS), or
 *   - a large share of their slots is dead.
 * The rebuild is also where rows that should no longer be searched are left
 * behind: event vectors past the retention window, and vectors whose capture
 * has been purged. The events themselves stay; they remain searchable by text.
 */
import type { Database } from 'bun:sqlite'
import { EMBEDDING_DIMS, embeddingToBytes, shortenEmbedding } from './embeddings'

/** Event vectors older than this are dropped. 0 keeps everything. */
export const EVENT_VECTOR_DAYS = (() => {
  const n = Number(process.env.EVENT_VECTOR_DAYS ?? 120)
  return Number.isFinite(n) && n >= 0 ? n : 120
})()

/** vec0 stores vectors in chunks of this many slots. */
const CHUNK_SLOTS = 1024

interface VecTable {
  table: string
  idColumn: string
  /** Ids worth keeping; null keeps every row. */
  keep: (db: Database, now: Date) => Set<string> | null
}

const eventCutoff = (now: Date): string | null =>
  EVENT_VECTOR_DAYS > 0 ? new Date(now.getTime() - EVENT_VECTOR_DAYS * 86_400_000).toISOString() : null

const idSet = (db: Database, sql: string, params: string[] = []): Set<string> =>
  new Set(db.query<{ id: string }, string[]>(sql).all(...params).map((r) => String(r.id)))

const TABLES: VecTable[] = [
  { table: 'captures_vec', idColumn: 'capture_id', keep: (db) => idSet(db, 'SELECT id FROM captures') },
  {
    table: 'events_vec',
    idColumn: 'event_id',
    keep: (db, now) => {
      const cutoff = eventCutoff(now)
      return cutoff ? idSet(db, 'SELECT id FROM events WHERE ts >= ?', [cutoff]) : idSet(db, 'SELECT id FROM events')
    },
  },
  { table: 'daily_summary_vec', idColumn: 'date', keep: () => null },
  { table: 'procedural_chunks_vec', idColumn: 'chunk_id', keep: (db) => idSet(db, 'SELECT id FROM procedural_chunks') },
]

function dimsOf(db: Database, table: string): number | null {
  const row = db.query<{ sql: string }, [string]>('SELECT sql FROM sqlite_master WHERE name = ?').get(table)
  const m = row?.sql.match(/FLOAT\[(\d+)\]/i)
  return m ? Number(m[1]) : null
}

const count = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0

/** Share of chunk slots that hold no live vector. */
function deadShare(db: Database, table: string): { live: number; slots: number } {
  return { live: count(db, `${table}_rowids`), slots: count(db, `${table}_chunks`) * CHUNK_SLOTS }
}

export interface RebuildResult {
  table: string
  before: number
  after: number
  ms: number
}

/** Copy the table into a fresh one, shortening vectors and leaving unwanted rows behind. */
export function rebuildVecTable(db: Database, spec: VecTable, now = new Date()): RebuildResult {
  const started = Date.now()
  const before = count(db, `${spec.table}_rowids`)
  const keep = spec.keep(db, now)
  const stage = `${spec.table}_rebuild`
  let after = 0
  db.transaction(() => {
    db.run(`DROP TABLE IF EXISTS ${stage}`)
    db.run(`CREATE TABLE ${stage} (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)`)
    const stash = db.query(`INSERT OR REPLACE INTO ${stage} (id, embedding) VALUES (?, ?)`)
    const rows = db.query<{ id: string; embedding: Uint8Array }, []>(`SELECT ${spec.idColumn} AS id, embedding FROM ${spec.table}`)
    for (const row of rows.iterate()) {
      const id = String(row.id)
      if (keep && !keep.has(id)) continue
      const bytes = row.embedding
      // Copy: the blob is not guaranteed to be aligned for a Float32Array view.
      const floats = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      const vec = floats.length === EMBEDDING_DIMS ? floats : shortenEmbedding(floats, EMBEDDING_DIMS)
      if (vec.length !== EMBEDDING_DIMS) continue // shorter than the target: cannot be searched
      stash.run(id, embeddingToBytes(vec))
    }
    db.run(`DROP TABLE ${spec.table}`)
    db.run(`CREATE VIRTUAL TABLE ${spec.table} USING vec0(${spec.idColumn} TEXT PRIMARY KEY, embedding FLOAT[${EMBEDDING_DIMS}])`)
    const insert = db.query(`INSERT INTO ${spec.table} (${spec.idColumn}, embedding) VALUES (?, ?)`)
    const staged = db.query<{ id: string; embedding: Uint8Array }, []>(`SELECT id, embedding FROM ${stage}`)
    for (const row of staged.iterate()) {
      insert.run(row.id, row.embedding)
      after++
    }
    db.run(`DROP TABLE ${stage}`)
  })()
  return { table: spec.table, before, after, ms: Date.now() - started }
}

/**
 * Called when the database is opened. Rebuilds a table only when it has to:
 * the usual start costs four small counts.
 */
export function maintainVecTables(db: Database, log: (line: string) => void = console.log): RebuildResult[] {
  const done: RebuildResult[] = []
  for (const spec of TABLES) {
    try {
      const dims = dimsOf(db, spec.table)
      if (dims === null) continue
      const { live, slots } = deadShare(db, spec.table)
      const wrongLength = dims !== EMBEDDING_DIMS
      // Worth it once at least 20 chunks exist and under 60% of the slots are live.
      const sparse = slots >= 20 * CHUNK_SLOTS && live < slots * 0.6
      if (!wrongLength && !sparse) continue
      log(`[vec] rebuilding ${spec.table}: ${wrongLength ? `${dims} → ${EMBEDDING_DIMS} dims` : `${live} live of ${slots} slots`}`)
      const result = rebuildVecTable(db, spec)
      log(`[vec] ${spec.table}: ${result.before} → ${result.after} vectors in ${Math.round(result.ms / 1000)}s`)
      done.push(result)
    } catch (err) {
      console.error(`[vec] rebuild of ${spec.table} failed, table left as it was:`, (err as Error).message)
    }
  }
  return done
}

/**
 * Drop the vectors of events that have just left the retention window. Looks
 * only at the last few days before the cutoff: older ones went on an earlier
 * call or at the last rebuild.
 */
export function pruneEventVectors(db: Database, now = new Date(), lookbackDays = 3): number {
  const cutoff = eventCutoff(now)
  if (!cutoff) return 0
  const from = new Date(Date.parse(cutoff) - lookbackDays * 86_400_000).toISOString()
  const before = count(db, 'events_vec_rowids')
  db.run('DELETE FROM events_vec WHERE event_id IN (SELECT id FROM events WHERE ts >= ? AND ts < ?)', [from, cutoff])
  return before - count(db, 'events_vec_rowids')
}
