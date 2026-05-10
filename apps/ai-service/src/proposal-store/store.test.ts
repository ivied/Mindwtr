import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import { ProposalStore } from './store'

let dir: string
let db: DB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-ps-'))
  db = openDb(join(dir, 'test.db')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ProposalStore.create', () => {
  it('creates a pending proposal with version 1 and a created audit row', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'commitment-detector',
      payload: { title: 'Pay invoice', tags: ['finance'] },
      summary: 'invoice spotted on screen',
    })

    expect(p.status).toBe('pending')
    expect(p.currentVersion).toBe(1)
    expect(p.type).toBe('create')
    expect(p.targetTaskIds).toEqual([])

    const detail = store.getDetail(p.id)!
    expect(detail.versions).toHaveLength(1)
    expect(detail.versions[0]!.version).toBe(1)
    expect(detail.versions[0]!.author).toBe('agent')
    expect(detail.versions[0]!.payload).toEqual({ title: 'Pay invoice', tags: ['finance'] })
    expect(detail.audit.map((a) => a.event)).toEqual(['created'])
  })

  it('round-trips origin_snapshot and target_task_ids', () => {
    const store = new ProposalStore(db)
    const snapshot = { taskA: { title: 'old' }, taskB: { title: 'older' } }
    const p = store.create({
      type: 'merge',
      targetTaskIds: ['taskA', 'taskB'],
      sourceAgent: 'dedup-agent',
      payload: { mergedTitle: 'combined' },
      originSnapshot: snapshot,
    })
    const fetched = store.get(p.id)!
    expect(fetched.targetTaskIds).toEqual(['taskA', 'taskB'])
    expect(fetched.originSnapshot).toEqual(snapshot)
  })
})

describe('ProposalStore.addVersion', () => {
  it('bumps current_version, mirrors current_payload, logs revised audit', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['taskX'],
      sourceAgent: 'a',
      payload: { v: 1 },
    })
    store.addVersion({ proposalId: p.id, payload: { v: 2 }, author: 'agent', summary: 'updated' })

    const refreshed = store.get(p.id)!
    expect(refreshed.currentVersion).toBe(2)
    expect(refreshed.currentPayload).toEqual({ v: 2 })

    const detail = store.getDetail(p.id)!
    expect(detail.versions.map((v) => v.version)).toEqual([1, 2])
    expect(detail.audit.map((a) => a.event)).toEqual(['created', 'revised'])
  })

  it('rejects addVersion on resolved proposal', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    store.transition(p.id, 'rejected', 'user')
    expect(() =>
      store.addVersion({ proposalId: p.id, payload: { x: 1 }, author: 'agent' })
    ).toThrow(/rejected/)
  })
})

describe('ProposalStore.addMessage', () => {
  it('stores message with default refVersion = currentVersion and logs commented audit', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: { v: 1 },
    })
    store.addVersion({ proposalId: p.id, payload: { v: 2 }, author: 'agent' })
    const msg = store.addMessage({ proposalId: p.id, role: 'user', text: 'looks good' })

    expect(msg.refVersion).toBe(2)
    const detail = store.getDetail(p.id)!
    expect(detail.messages).toHaveLength(1)
    expect(detail.audit.map((a) => a.event)).toEqual(['created', 'revised', 'commented'])
  })

  it('rejects addMessage on resolved proposal', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {},
    })
    store.transition(p.id, 'approved', 'user')
    expect(() =>
      store.addMessage({ proposalId: p.id, role: 'user', text: 'hi' })
    ).toThrow(/approved/)
  })
})

describe('ProposalStore.transition', () => {
  it('moves to approved with resolved_at and audit row', () => {
    const store = new ProposalStore(db)
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: {} })
    store.transition(p.id, 'approved', 'user', { reason: 'looks right' }, 'user-1')

    const refreshed = store.get(p.id)!
    expect(refreshed.status).toBe('approved')
    expect(refreshed.resolvedAt).not.toBeNull()
    expect(refreshed.resolvedBy).toBe('user-1')

    const audit = store.auditLog(p.id)
    expect(audit.map((a) => a.event)).toEqual(['created', 'approved'])
    expect(audit[1]!.eventMeta).toEqual({ reason: 'looks right' })
  })

  it('records implicit-approval meta', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['t1'],
      sourceAgent: 'a',
      payload: {},
    })
    store.transition(p.id, 'approved', 'system', { implicit: true })
    const audit = store.auditLog(p.id)
    expect(audit[1]!.eventMeta).toEqual({ implicit: true })
    expect(audit[1]!.actor).toBe('system')
  })

  it('moves through superseded → terminal', () => {
    const store = new ProposalStore(db)
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['t1'],
      sourceAgent: 'a',
      payload: {},
    })
    store.transition(p.id, 'superseded', 'system', { reason: 'user edited target' })
    expect(store.get(p.id)!.status).toBe('superseded')
    expect(store.get(p.id)!.resolvedAt).not.toBeNull()
  })

  it('is no-op when already in target status (no extra audit row)', () => {
    const store = new ProposalStore(db)
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: {} })
    store.transition(p.id, 'approved', 'user')
    store.transition(p.id, 'approved', 'user')
    const audit = store.auditLog(p.id)
    expect(audit.filter((a) => a.event === 'approved')).toHaveLength(1)
  })
})

describe('ProposalStore.audit', () => {
  it('appends free-form audit events without state change', () => {
    const store = new ProposalStore(db)
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: {} })
    store.audit({
      proposalId: p.id,
      event: 'applied',
      actor: 'system',
      meta: { taskId: 'new-task-id' },
    })
    const audit = store.auditLog(p.id)
    expect(audit.map((a) => a.event)).toEqual(['created', 'applied'])
    expect(audit[1]!.eventMeta).toEqual({ taskId: 'new-task-id' })
    expect(store.get(p.id)!.status).toBe('pending') // status unchanged
  })
})

describe('ProposalStore.listPending', () => {
  it('returns only pending, newest first, with filters', () => {
    const store = new ProposalStore(db)
    const p1 = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'commitment-detector',
      payload: {},
    })
    const p2 = store.create({
      type: 'modify',
      targetTaskIds: ['task-1'],
      sourceAgent: 'commitment-detector',
      payload: {},
    })
    const p3 = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'dedup-agent',
      payload: {},
    })
    store.transition(p1.id, 'rejected', 'user')

    const all = store.listPending()
    expect(all.map((p) => p.id)).toEqual([p3.id, p2.id])

    const byAgent = store.listPending({ sourceAgent: 'commitment-detector' })
    expect(byAgent.map((p) => p.id)).toEqual([p2.id])

    const byTarget = store.listPending({ targetTaskId: 'task-1' })
    expect(byTarget.map((p) => p.id)).toEqual([p2.id])

    const byType = store.listPending({ type: 'modify' })
    expect(byType.map((p) => p.id)).toEqual([p2.id])
  })
})
