/**
 * One-off maintenance for context.db, run with the service stopped:
 *
 *   docker compose stop ai-service
 *   docker compose run --rm --no-deps ai-service bun run apps/ai-service/src/context-store/maintenance-cli.ts
 *   docker compose up -d ai-service
 *
 * Opening the database rebuilds the vector tables when they need it (see
 * vec-maintenance.ts); VACUUM then returns the freed pages to the disk.
 * Pass --no-vacuum to skip the second step.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from './db'

const path = join(process.env.DATA_DIR ?? '/app/data', 'context.db')
const gb = (): string => `${(statSync(path).size / 1024 ** 3).toFixed(2)} GB`

console.log(`context.db: ${gb()}`)
const { db, vecAvailable } = openDb(path)
if (!vecAvailable) console.warn('sqlite-vec did not load: vector tables were not touched')
for (const table of ['captures_vec', 'events_vec', 'daily_summary_vec', 'procedural_chunks_vec']) {
  try {
    const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}_rowids`).get()?.n
    console.log(`${table}: ${n} vectors`)
  } catch {
    /* table absent */
  }
}
if (!process.argv.includes('--no-vacuum')) {
  const started = Date.now()
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  console.log(`vacuum: ${Math.round((Date.now() - started) / 1000)}s`)
}
db.close()
console.log(`context.db: ${gb()}`)
