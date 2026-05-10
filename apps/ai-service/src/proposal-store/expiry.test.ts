import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import { ProposalStore } from './store'
import { ProposalExpiryJob } from './expiry'

const DAY = 24 * 60 * 60 * 1000

let dir: string
let db: DB
let store: ProposalStore

/** Backdate a proposal's created_at and (optionally) inject a message at messageDaysAgo. */
function backdate(
  proposalId: string,
  createdAt: Date,
  messageAt: Date | null = null
): void {
  db.run(`UPDATE proposals SET created_at = ? WHERE id = ?`, [createdAt.toISOString(), proposalId])
  // Backdate the row in proposal_versions as well since it was created at "now" originally.
  db.run(
    `UPDATE proposal_versions SET created_at = ? WHERE proposal_id = ? AND version = 1`,
    [createdAt.toISOString(), proposalId]
  )
  if (messageAt !== null) {
    // Insert a synthetic user message with the given timestamp.
    db.run(
      `INSERT INTO proposal_messages (id, proposal_id, role, text, ref_version, created_at)
       VALUES (?, ?, 'user', '...', 1, ?)`,
      [`msg-${proposalId}`, proposalId, messageAt.toISOString()]
    )
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-exp-'))
  db = openDb(join(dir, 'test.db')).db
  store = new ProposalStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ProposalExpiryJob', () => {
  it('expires pending proposals older than 7 days with no messages', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const stale = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    backdate(stale.id, new Date(now.getTime() - 10 * DAY))

    const fresh = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    backdate(fresh.id, new Date(now.getTime() - 2 * DAY))

    const job = new ProposalExpiryJob(db, store)
    const result = job.run(now)
    expect(result.expired.map((p) => p.id)).toEqual([stale.id])
    expect(store.get(stale.id)!.status).toBe('expired')
    expect(store.get(fresh.id)!.status).toBe('pending')
  })

  it('does not expire proposal with recent comment activity', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    backdate(p.id, new Date(now.getTime() - 10 * DAY), new Date(now.getTime() - 1 * DAY))

    const job = new ProposalExpiryJob(db, store)
    const result = job.run(now)
    expect(result.expired).toHaveLength(0)
    expect(store.get(p.id)!.status).toBe('pending')
  })

  it('expires proposal whose last message is also older than the window', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    backdate(p.id, new Date(now.getTime() - 30 * DAY), new Date(now.getTime() - 14 * DAY))

    const job = new ProposalExpiryJob(db, store)
    const result = job.run(now)
    expect(result.expired.map((p) => p.id)).toEqual([p.id])
    expect(store.get(p.id)!.status).toBe('expired')
    const audit = store.auditLog(p.id)
    const expiredRow = audit.find((a) => a.event === 'expired')!
    expect(expiredRow.actor).toBe('system')
    expect(expiredRow.eventMeta).toEqual({ maxIdleDays: 7 })
  })

  it('skips already-resolved proposals', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    backdate(p.id, new Date(now.getTime() - 30 * DAY))
    store.transition(p.id, 'rejected', 'user')

    const job = new ProposalExpiryJob(db, store)
    const result = job.run(now)
    expect(result.expired).toHaveLength(0)
    expect(store.get(p.id)!.status).toBe('rejected')
  })

  it('respects per-source-agent override', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const tightAgent = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'fast-decay',
      payload: {},
    })
    backdate(tightAgent.id, new Date(now.getTime() - 3 * DAY))

    const looseAgent = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'commitment-detector',
      payload: {},
    })
    backdate(looseAgent.id, new Date(now.getTime() - 3 * DAY))

    const job = new ProposalExpiryJob(db, store, {
      defaultMaxIdleDays: 7,
      perSourceAgentDays: { 'fast-decay': 1 },
    })
    job.run(now)
    expect(store.get(tightAgent.id)!.status).toBe('expired')
    expect(store.get(looseAgent.id)!.status).toBe('pending')
  })
})
