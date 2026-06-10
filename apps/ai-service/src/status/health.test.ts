import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { HealthMonitor } from './health'

function makeDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE captures (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_meta TEXT,
      captured_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      ttl_at TEXT NOT NULL,
      is_pull INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE recording_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      distillation_status TEXT NOT NULL DEFAULT 'pending',
      distilled_chunk_id TEXT,
      distillation_error TEXT
    );
  `)
  return db
}

function insertCapture(db: Database, receivedAt: string): void {
  db.run(
    `INSERT INTO captures (id, text, source_channel, captured_at, received_at, content_hash, ttl_at)
     VALUES (?, 'x', 'screen_capture', ?, ?, 'h', ?)`,
    [crypto.randomUUID(), receivedAt, receivedAt, receivedAt]
  )
}

describe('HealthMonitor', () => {
  it('reports all ok on a healthy system', async () => {
    const db = makeDb()
    const now = new Date('2026-06-09T12:00:00Z')
    insertCapture(db, '2026-06-09T11:50:00Z')
    const monitor = new HealthMonitor({
      db,
      cloudHealthCheck: async () => true,
      now: () => now,
    })
    const report = await monitor.check()
    expect(report.ok).toBe(true)
    expect(report.components.db.ok).toBe(true)
    expect(report.components.cloud.ok).toBe(true)
    expect(report.components.captureFeed.ok).toBe(true)
    expect(report.components.distiller.ok).toBe(true)
  })

  it('flags stale capture feed past the threshold', async () => {
    const db = makeDb()
    const now = new Date('2026-06-09T12:00:00Z')
    insertCapture(db, '2026-06-09T02:00:00Z')
    const monitor = new HealthMonitor({
      db,
      cloudHealthCheck: async () => true,
      captureStaleMinutes: 240,
      now: () => now,
    })
    const report = await monitor.check()
    expect(report.ok).toBe(false)
    expect(report.components.captureFeed.ok).toBe(false)
    expect(report.components.captureFeed.detail).toContain('600m')
  })

  it('tolerates an empty captures table (fresh install)', async () => {
    const db = makeDb()
    const monitor = new HealthMonitor({ db, cloudHealthCheck: async () => true })
    const report = await monitor.check()
    expect(report.components.captureFeed.ok).toBe(true)
  })

  it('flags unreachable cloud', async () => {
    const db = makeDb()
    const monitor = new HealthMonitor({
      db,
      cloudHealthCheck: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    const report = await monitor.check()
    expect(report.ok).toBe(false)
    expect(report.components.cloud.detail).toContain('ECONNREFUSED')
  })

  it('flags failed distillations within 24h and ignores older ones', async () => {
    const db = makeDb()
    const now = new Date('2026-06-09T12:00:00Z')
    db.run(
      `INSERT INTO recording_sessions (id, task_id, started_at, stopped_at, distillation_status)
       VALUES ('s1', 't1', '2026-06-09T10:00:00Z', '2026-06-09T10:30:00Z', 'failed')`
    )
    db.run(
      `INSERT INTO recording_sessions (id, task_id, started_at, stopped_at, distillation_status)
       VALUES ('s2', 't2', '2026-06-01T10:00:00Z', '2026-06-01T10:30:00Z', 'failed')`
    )
    const monitor = new HealthMonitor({
      db,
      cloudHealthCheck: async () => true,
      now: () => now,
    })
    const report = await monitor.check()
    expect(report.components.distiller.ok).toBe(false)
    expect(report.components.distiller.detail).toContain('1 failed')
  })
})
