import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import { ProposalStore } from './store'
import { TaskChangeProcessor } from './task-change-processor'
import type {
  CreatePayload,
  DeletePayload,
  MergePayload,
  ModifyPayload,
  MovePayload,
  SplitPayload,
} from './payloads'

let dir: string
let db: DB
let store: ProposalStore
let proc: TaskChangeProcessor

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-tcp-'))
  db = openDb(join(dir, 'test.db')).db
  store = new ProposalStore(db)
  proc = new TaskChangeProcessor(store)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('TaskChangeProcessor — edit', () => {
  it('approves modify proposal implicitly when edit matches diff to-values', () => {
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [{ field: 'title', from: 'Old', to: 'New' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['t1'], sourceAgent: 'a', payload })

    const out = proc.process({ kind: 'edit', taskId: 't1', fields: { title: 'New' } })
    expect(out).toHaveLength(1)
    expect(out[0]!.result).toBe('approved-implicit')

    const refreshed = store.get(p.id)!
    expect(refreshed.status).toBe('approved')
    const audit = store.auditLog(p.id)
    const approvedRow = audit.find((a) => a.event === 'approved')!
    expect(approvedRow.actor).toBe('system')
    expect(approvedRow.eventMeta).toMatchObject({ implicit: true })
  })

  it('marks modify proposal superseded when edit diverges from diff', () => {
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [{ field: 'title', from: 'Old', to: 'New' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['t1'], sourceAgent: 'a', payload })

    proc.process({ kind: 'edit', taskId: 't1', fields: { title: 'Something else entirely' } })
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('compares multi-field diff: all must match for implicit approve', () => {
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [
        { field: 'title', from: 'Old', to: 'New' },
        { field: 'tags', from: ['a'], to: ['a', 'b'] },
      ],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['t1'], sourceAgent: 'a', payload })

    // Title matches, tags don't yet — superseded.
    proc.process({ kind: 'edit', taskId: 't1', fields: { title: 'New', tags: ['a'] } })
    expect(store.get(p.id)!.status).toBe('superseded')

    // New proposal: same scenario but both match.
    const p2 = store.create({ type: 'modify', targetTaskIds: ['t2'], sourceAgent: 'a', payload: {
      ...payload,
      taskId: 't2',
    } as ModifyPayload })
    proc.process({ kind: 'edit', taskId: 't2', fields: { title: 'New', tags: ['a', 'b'] } })
    expect(store.get(p2.id)!.status).toBe('approved')
  })

  it('move proposal: implicit approve when project moves to proposed target', () => {
    const payload: MovePayload = {
      kind: 'move',
      taskId: 't1',
      fromProject: 'projA',
      toProject: 'projB',
    }
    const p = store.create({ type: 'move', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    proc.process({ kind: 'edit', taskId: 't1', fields: { projectId: 'projB' } })
    expect(store.get(p.id)!.status).toBe('approved')
  })

  it('move proposal: superseded when project moves elsewhere', () => {
    const payload: MovePayload = {
      kind: 'move',
      taskId: 't1',
      fromProject: 'projA',
      toProject: 'projB',
    }
    const p = store.create({ type: 'move', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    proc.process({ kind: 'edit', taskId: 't1', fields: { projectId: 'projZ' } })
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('delete proposal is superseded by edit (user chose to keep & edit instead of deleting)', () => {
    const payload: DeletePayload = { kind: 'delete', taskId: 't1', reason: 'duplicate' }
    const p = store.create({ type: 'delete', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    proc.process({ kind: 'edit', taskId: 't1', fields: { title: 'still here' } })
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('merge proposal is superseded when any source edited mid-flight', () => {
    const payload: MergePayload = {
      kind: 'merge',
      sourceTaskIds: ['s1', 's2'],
      resultTask: { title: 'C', status: 'inbox', tags: [], description: '', metadata: {} },
    }
    const p = store.create({ type: 'merge', targetTaskIds: ['s1', 's2'], sourceAgent: 'a', payload })
    proc.process({ kind: 'edit', taskId: 's1', fields: { title: 'edited' } })
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('split proposal: implicit approve when source edited to first resultTask shape', () => {
    const payload: SplitPayload = {
      kind: 'split',
      sourceTaskId: 'src',
      deleteSource: false,
      resultTasks: [
        { title: 'Part A', status: 'inbox', tags: ['x'], description: '', metadata: {} },
        { title: 'Part B', status: 'inbox', tags: [], description: '', metadata: {} },
      ],
    }
    const p = store.create({ type: 'split', targetTaskIds: ['src'], sourceAgent: 'a', payload })
    proc.process({
      kind: 'edit',
      taskId: 'src',
      fields: { title: 'Part A', status: 'inbox', tags: ['x'] },
    })
    expect(store.get(p.id)!.status).toBe('approved')
  })

  it('does not affect proposals targeting other tasks', () => {
    const payloadA: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [{ field: 'title', from: 'O', to: 'N' }],
    }
    const a = store.create({ type: 'modify', targetTaskIds: ['t1'], sourceAgent: 'a', payload: payloadA })
    const payloadB: ModifyPayload = {
      kind: 'modify',
      taskId: 't2',
      diff: [{ field: 'title', from: 'O', to: 'N' }],
    }
    const b = store.create({ type: 'modify', targetTaskIds: ['t2'], sourceAgent: 'a', payload: payloadB })
    proc.process({ kind: 'edit', taskId: 't1', fields: { title: 'random' } })
    expect(store.get(a.id)!.status).toBe('superseded')
    expect(store.get(b.id)!.status).toBe('pending')
  })

  it('ignores create-typed proposals', () => {
    const payload: CreatePayload = {
      kind: 'create',
      task: { title: 'X', status: 'inbox', tags: [], description: '', metadata: {} },
      traceback: { captureExcerpt: '', sourceChannel: 's' },
    }
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload })
    proc.process({ kind: 'edit', taskId: 'whatever', fields: { title: 'x' } })
    expect(store.get(p.id)!.status).toBe('pending')
  })
})

describe('TaskChangeProcessor — delete', () => {
  it('approves delete proposal implicitly when target gone', () => {
    const payload: DeletePayload = { kind: 'delete', taskId: 't1', reason: 'old' }
    const p = store.create({ type: 'delete', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    proc.process({ kind: 'delete', taskId: 't1' })
    expect(store.get(p.id)!.status).toBe('approved')
    const audit = store.auditLog(p.id)
    expect(audit.find((a) => a.event === 'approved')!.eventMeta).toMatchObject({ implicit: true })
  })

  it('supersedes modify proposal when target deleted (user gave up on it)', () => {
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [{ field: 'title', from: 'O', to: 'N' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    proc.process({ kind: 'delete', taskId: 't1' })
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('supersedes merge proposal when any source deleted', () => {
    const payload: MergePayload = {
      kind: 'merge',
      sourceTaskIds: ['s1', 's2'],
      resultTask: { title: 'C', status: 'inbox', tags: [], description: '', metadata: {} },
    }
    const p = store.create({ type: 'merge', targetTaskIds: ['s1', 's2'], sourceAgent: 'a', payload })
    proc.process({ kind: 'delete', taskId: 's2' })
    expect(store.get(p.id)!.status).toBe('superseded')
  })
})
