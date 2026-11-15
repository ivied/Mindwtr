import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { EMBEDDING_DIMS, embeddingToBytes } from './embeddings'
import { maintainVecTables, pruneEventVectors } from './vec-maintenance'

/** sqlite-vec does not load into the SQLite that ships with macOS; these run in the Linux container. */
function vecDb(): Database | null {
  const db = new Database(':memory:')
  try {
    sqliteVec.load(db)
    return db
  } catch {
    return null
  }
}

const unit = (dims: number, hot: number): Float32Array => {
  const v = new Float32Array(dims)
  v[hot % 8] = 1
  v[dims - 1] = 0.5 // lives past the shortened prefix when dims is 1536
  return v
}

function seed(db: Database, dims: number): void {
  db.exec(`
    CREATE TABLE captures (id TEXT PRIMARY KEY);
    CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL);
    CREATE TABLE procedural_chunks (id TEXT PRIMARY KEY);
    CREATE VIRTUAL TABLE captures_vec USING vec0(capture_id TEXT PRIMARY KEY, embedding FLOAT[${dims}]);
    CREATE VIRTUAL TABLE events_vec USING vec0(event_id TEXT PRIMARY KEY, embedding FLOAT[${dims}]);
    CREATE VIRTUAL TABLE daily_summary_vec USING vec0(date TEXT PRIMARY KEY, embedding FLOAT[${dims}]);
    CREATE VIRTUAL TABLE procedural_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[${dims}]);
  `)
}

const day = (ago: number): string => new Date(Date.now() - ago * 86_400_000).toISOString()

describe('vec maintenance', () => {
  const probe = vecDb()
  const run = probe ? it : it.skip
  probe?.close()

  run('shortens vectors and leaves old events and purged captures behind', () => {
    const db = vecDb()!
    seed(db, 1536)
    db.run("INSERT INTO captures (id) VALUES ('live')")
    for (const id of ['live', 'purged']) db.run('INSERT INTO captures_vec (capture_id, embedding) VALUES (?, ?)', [id, embeddingToBytes(unit(1536, 1))])
    const events: Array<[string, number, number]> = [['fresh', 1, 2], ['recent', 100, 3], ['old', 200, 4]]
    for (const [id, ago, hot] of events) {
      db.run('INSERT INTO events (id, ts) VALUES (?, ?)', [id, day(ago)])
      db.run('INSERT INTO events_vec (event_id, embedding) VALUES (?, ?)', [id, embeddingToBytes(unit(1536, hot))])
    }
    db.run("INSERT INTO daily_summary_vec (date, embedding) VALUES ('2026-01-01', ?)", [embeddingToBytes(unit(1536, 5))])

    const done = maintainVecTables(db, () => {})
    expect(done.map((d) => d.table).sort()).toEqual(['captures_vec', 'daily_summary_vec', 'events_vec', 'procedural_chunks_vec'])

    const ids = (sql: string) => db.query<{ id: string }, []>(sql).all().map((r) => r.id).sort()
    expect(ids('SELECT capture_id AS id FROM captures_vec')).toEqual(['live'])
    expect(ids('SELECT event_id AS id FROM events_vec')).toEqual(['fresh', 'recent'])
    expect(ids('SELECT date AS id FROM daily_summary_vec')).toEqual(['2026-01-01'])

    // Search works at the new length and still tells the vectors apart.
    const hit = db
      .query<{ id: string; distance: number }, [Uint8Array, number]>('SELECT event_id AS id, distance FROM events_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(embeddingToBytes(unit(EMBEDDING_DIMS, 3)), 1)
    expect(hit[0]?.id).toBe('recent')

    // A second pass has nothing to do.
    expect(maintainVecTables(db, () => {})).toEqual([])
    db.close()
  })

  run('prunes vectors of events that just left the window', () => {
    const db = vecDb()!
    seed(db, EMBEDDING_DIMS)
    const events: Array<[string, number]> = [['in', 119], ['out', 121]]
    for (const [id, ago] of events) {
      db.run('INSERT INTO events (id, ts) VALUES (?, ?)', [id, day(ago)])
      db.run('INSERT INTO events_vec (event_id, embedding) VALUES (?, ?)', [id, embeddingToBytes(unit(EMBEDDING_DIMS, 1))])
    }
    expect(pruneEventVectors(db)).toBe(1)
    expect(db.query<{ id: string }, []>('SELECT event_id AS id FROM events_vec').all().map((r) => r.id)).toEqual(['in'])
    db.close()
  })
})
