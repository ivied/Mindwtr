/**
 * Read-only SQLite connection on its own thread. Vector scans over the event
 * and capture embeddings take seconds; run here, they no longer stop the
 * HTTP server and the channels that share the main thread.
 */
import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'

type Request = { open: { path: string; cacheKb: number } } | { id: number; sql: string; params: unknown[] }
type Port = { onmessage: (e: { data: Request }) => void; postMessage: (m: unknown) => void }

const port = globalThis as unknown as Port
let db: Database | null = null

port.onmessage = ({ data }) => {
  if ('open' in data) {
    try {
      db = new Database(data.open.path, { readonly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec(`PRAGMA cache_size = -${data.open.cacheKb}`)
      sqliteVec.load(db)
      port.postMessage({ ready: true })
    } catch (err) {
      port.postMessage({ ready: false, error: (err as Error).message })
    }
    return
  }
  const started = performance.now()
  try {
    if (!db) throw new Error('database is not open')
    const rows = db.query(data.sql).all(...(data.params as never[]))
    port.postMessage({ id: data.id, rows, ms: performance.now() - started })
  } catch (err) {
    port.postMessage({ id: data.id, error: (err as Error).message, ms: performance.now() - started })
  }
}
