/**
 * Runs a read query off the main thread.
 *
 * bun:sqlite is synchronous, and a nearest-neighbour scan over a few hundred
 * thousand embeddings takes seconds. On the main thread that froze every HTTP
 * request (the agent runner's claims timed out). A worker with its own
 * read-only connection does the scan instead; the caller awaits the rows.
 *
 * Falls back to the caller's connection for in-memory databases (tests) and
 * whenever the worker cannot be used.
 */
import type { Database } from 'bun:sqlite'

type Param = string | number | bigint | boolean | null | Uint8Array
type Waiter = { resolve: (rows: unknown[]) => void; reject: (err: Error) => void; sql: string }

interface Reader {
  worker: Worker
  ready: Promise<boolean>
  waiting: Map<number, Waiter>
  nextId: number
}

const readers = new Map<string, Reader>()
const SLOW_MS = Number(process.env.SQLITE_SLOW_MS ?? 1000)

function start(path: string): Reader {
  const worker = new Worker(new URL('./offthread.worker.ts', import.meta.url).href)
  const waiting = new Map<number, Waiter>()
  let settle!: (ok: boolean) => void
  const ready = new Promise<boolean>((r) => (settle = r))
  const failAll = (message: string) => {
    for (const w of waiting.values()) w.reject(new Error(message))
    waiting.clear()
  }
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { ready?: boolean; id?: number; rows?: unknown[]; error?: string; ms?: number }
    if (m.ready !== undefined) {
      if (!m.ready) console.warn('[context-store] off-thread reader unavailable:', m.error)
      settle(m.ready)
      return
    }
    const waiter = waiting.get(m.id!)
    if (!waiter) return
    waiting.delete(m.id!)
    if ((m.ms ?? 0) >= SLOW_MS) {
      console.warn(`[slow-sql] ${Math.round(m.ms!)}ms off-thread: ${waiter.sql.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    if (m.error) waiter.reject(new Error(m.error))
    else waiter.resolve(m.rows ?? [])
  }
  worker.onerror = (e: ErrorEvent) => {
    console.warn('[context-store] off-thread reader failed:', e.message)
    settle(false)
    failAll(e.message)
    readers.delete(path)
  }
  ;(worker as unknown as { unref?: () => void }).unref?.()
  worker.postMessage({ open: { path, cacheKb: Math.max(2000, Number(process.env.SQLITE_READER_CACHE_KB ?? 1_200_000)) } })
  return { worker, ready, waiting, nextId: 1 }
}

export async function offThreadAll<Row>(db: Database, sql: string, params: Param[]): Promise<Row[]> {
  const path = db.filename
  const onMain = () => db.query<Row, Param[]>(sql).all(...params)
  if (!path || path === ':memory:' || process.env.SQLITE_OFFTHREAD === '0') return onMain()
  let reader = readers.get(path)
  if (!reader) {
    try {
      reader = start(path)
      readers.set(path, reader)
    } catch (err) {
      console.warn('[context-store] off-thread reader not started:', (err as Error).message)
      return onMain()
    }
  }
  if (!(await reader.ready)) return onMain()
  const id = reader.nextId++
  const active = reader
  return new Promise<Row[]>((resolve, reject) => {
    active.waiting.set(id, { resolve: resolve as (rows: unknown[]) => void, reject, sql })
    active.worker.postMessage({ id, sql, params })
  })
}
