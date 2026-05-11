import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import { ProposalStore } from './store'
import { ProposalApplier } from './apply'
import type { MindwtrClient, Task } from '../api/mindwtr-client'
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

function makeMindwtr(overrides: Partial<MindwtrClient> = {}): MindwtrClient {
  return {
    createTask: mock(async () => taskOf({ id: 'new-task' })),
    getTask: mock(async (id: string) => taskOf({ id })),
    updateTask: mock(async (id: string) => taskOf({ id })),
    deleteTask: mock(async () => true),
    completeTask: mock(async (id: string) => taskOf({ id })),
    listTasks: mock(async () => []),
    search: mock(async () => ({ tasks: [], projects: [] })),
    healthCheck: mock(async () => true),
    createProject: mock(async (params: { title: string }) => ({
      id: 'new-project',
      title: params.title,
      status: 'active' as const,
      color: '#7c3aed',
      order: 0,
      tagIds: [],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    })),
    ...overrides,
  } as unknown as MindwtrClient
}

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Original title',
    status: 'inbox',
    contexts: [],
    tags: [],
    description: 'orig desc',
    projectId: undefined,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-app-'))
  db = openDb(join(dir, 'test.db')).db
  store = new ProposalStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ProposalApplier — create', () => {
  it('creates Mindwtr task and returns its id, with applied audit', async () => {
    const mindwtr = makeMindwtr({
      createTask: mock(async () => taskOf({ id: 'new-task-id', title: 'Pay invoice' })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: CreatePayload = {
      kind: 'create',
      task: { title: 'Pay invoice', status: 'inbox', tags: [], description: '', metadata: {} },
      traceback: { captureExcerpt: 'x', sourceChannel: 'screen_capture' },
    }
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload })

    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.appliedTaskIds).toEqual(['new-task-id'])
    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)

    const audit = store.auditLog(p.id)
    expect(audit.map((a) => a.event)).toEqual(['created', 'applied'])
  })

  it('audits apply_failed when Mindwtr createTask throws', async () => {
    const mindwtr = makeMindwtr({
      createTask: mock(async () => {
        throw new Error('mindwtr 500')
      }),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: CreatePayload = {
      kind: 'create',
      task: { title: 'X', status: 'inbox', tags: [], description: '', metadata: {} },
      traceback: { captureExcerpt: 'x', sourceChannel: 'screen_capture' },
    }
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('mindwtr_error')
      expect(result.details).toContain('mindwtr 500')
    }
    expect(store.auditLog(p.id).map((a) => a.event)).toEqual(['created', 'apply_failed'])
    expect(store.get(p.id)!.status).toBe('pending')
  })
})

describe('ProposalApplier — modify with drift detection', () => {
  it('applies diff when current task matches snapshot', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 'task-1', title: 'Old title' })),
      updateTask: mock(async (id) => taskOf({ id, title: 'New title' })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 'task-1',
      diff: [{ field: 'title', from: 'Old title', to: 'New title' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['task-1'], sourceAgent: 'a', payload })

    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.appliedTaskIds).toEqual(['task-1'])
    expect(mindwtr.updateTask).toHaveBeenCalledTimes(1)
    const updateCall = (mindwtr.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } })
      .mock.calls[0]
    expect(updateCall[0]).toBe('task-1')
    expect(updateCall[1]).toEqual({ title: 'New title' })
  })

  it('flips to stale when current title differs from snapshot from-value', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 'task-1', title: 'User edited it' })),
      updateTask: mock(async () => taskOf()),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 'task-1',
      diff: [{ field: 'title', from: 'Old title', to: 'New title' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['task-1'], sourceAgent: 'a', payload })

    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale')
    expect(mindwtr.updateTask).not.toHaveBeenCalled()
    expect(store.get(p.id)!.status).toBe('stale')
    expect(store.auditLog(p.id).map((a) => a.event)).toEqual(['created', 'stale'])
  })

  it('flips to stale when getTask fails (target gone or unreachable)', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () => {
        throw new Error('404 task not found')
      }),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 'task-1',
      diff: [{ field: 'title', from: 'X', to: 'Y' }],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['task-1'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale')
    expect(store.get(p.id)!.status).toBe('stale')
  })

  it('applies multi-field diff (title + tags + status)', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () =>
        taskOf({ id: 'task-1', title: 'Old', tags: ['a', 'b'], status: 'inbox' })
      ),
      updateTask: mock(async (id) => taskOf({ id })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 'task-1',
      diff: [
        { field: 'title', from: 'Old', to: 'New' },
        { field: 'tags', from: ['a', 'b'], to: ['a', 'c'] },
        { field: 'status', from: 'inbox', to: 'next' },
      ],
    }
    const p = store.create({ type: 'modify', targetTaskIds: ['task-1'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    const updateCall = (mindwtr.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } })
      .mock.calls[0]
    expect(updateCall[1]).toEqual({ title: 'New', tags: ['a', 'c'], status: 'next' })
  })
})

describe('ProposalApplier — delete', () => {
  it('deletes target via Mindwtr and audits applied', async () => {
    const mindwtr = makeMindwtr({
      deleteTask: mock(async () => true),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: DeletePayload = { kind: 'delete', taskId: 't1', reason: 'duplicate' }
    const p = store.create({ type: 'delete', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    expect(mindwtr.deleteTask).toHaveBeenCalledWith('t1')
  })
})

describe('ProposalApplier — move with drift', () => {
  it('moves task when current project matches fromProject', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 't1', projectId: 'projA' })),
      updateTask: mock(async (id) => taskOf({ id, projectId: 'projB' })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: MovePayload = {
      kind: 'move',
      taskId: 't1',
      fromProject: 'projA',
      toProject: 'projB',
    }
    const p = store.create({ type: 'move', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    expect(mindwtr.updateTask).toHaveBeenCalledWith('t1', { projectId: 'projB' })
  })

  it('flips to stale when current project differs from fromProject', async () => {
    const mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 't1', projectId: 'projZ' })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: MovePayload = {
      kind: 'move',
      taskId: 't1',
      fromProject: 'projA',
      toProject: 'projB',
    }
    const p = store.create({ type: 'move', targetTaskIds: ['t1'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale')
    expect(store.get(p.id)!.status).toBe('stale')
  })
})

describe('ProposalApplier — merge', () => {
  it('creates result task and deletes sources', async () => {
    const created: string[] = []
    const deleted: string[] = []
    const mindwtr = makeMindwtr({
      getTask: mock(async (id: string) => taskOf({ id })),
      createTask: mock(async (params) => {
        const id = `merged-${created.length}`
        created.push(id)
        return taskOf({ id, title: params.title })
      }),
      deleteTask: mock(async (id) => {
        deleted.push(id)
        return true
      }),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: MergePayload = {
      kind: 'merge',
      sourceTaskIds: ['s1', 's2'],
      resultTask: {
        title: 'Combined',
        status: 'inbox',
        tags: [],
        description: '',
        metadata: {},
      },
    }
    const p = store.create({ type: 'merge', targetTaskIds: ['s1', 's2'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.appliedTaskIds).toEqual(['merged-0'])
    expect(deleted).toEqual(['s1', 's2'])
  })
})

describe('ProposalApplier — split', () => {
  it('creates a Project from the first resultTask, links sub-actions, deletes source', async () => {
    let nextTaskId = 0
    let nextProjectId = 0
    const createdProjects: { title: string }[] = []
    const createdTasks: { title: string; projectId?: string }[] = []
    const deleted: string[] = []
    const mindwtr = makeMindwtr({
      getTask: mock(async (id: string) => taskOf({ id })),
      createTask: mock(async (params) => {
        nextTaskId += 1
        createdTasks.push({ title: params.title, projectId: params.projectId })
        return taskOf({ id: `task-${nextTaskId}`, title: params.title, projectId: params.projectId })
      }),
      createProject: mock(async (params) => {
        nextProjectId += 1
        createdProjects.push({ title: params.title })
        return {
          id: `proj-${nextProjectId}`,
          title: params.title,
          status: 'active' as const,
          color: '#7c3aed',
          order: 0,
          tagIds: [],
          createdAt: '2026-05-11T00:00:00Z',
          updatedAt: '2026-05-11T00:00:00Z',
        }
      }),
      deleteTask: mock(async (id) => {
        deleted.push(id)
        return true
      }),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: SplitPayload = {
      kind: 'split',
      sourceTaskId: 'src',
      deleteSource: true,
      resultTasks: [
        { title: 'Renovation project', status: 'inbox', tags: ['@home', 'project'], description: 'Done when all rooms repainted', metadata: {} },
        { title: 'Measure bathroom', status: 'next', tags: ['@home'], description: '', metadata: {} },
        { title: 'Get quotes', status: 'next', tags: ['@home'], description: '', metadata: {} },
      ],
    }
    const p = store.create({ type: 'split', targetTaskIds: ['src'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.projectId).toBe('proj-1')
      expect(result.projectTitle).toBe('Renovation project')
      expect(result.appliedTaskIds).toEqual(['task-1', 'task-2'])
    }
    expect(createdProjects).toEqual([{ title: 'Renovation project' }])
    expect(createdTasks).toEqual([
      { title: 'Measure bathroom', projectId: 'proj-1' },
      { title: 'Get quotes', projectId: 'proj-1' },
    ])
    expect(deleted).toEqual(['src'])
  })

  it('keeps source and links it to the new project when deleteSource=false', async () => {
    const createdProjects: { title: string }[] = []
    const updatedTasks: Array<{ id: string; patch: Record<string, unknown> }> = []
    const mindwtr = makeMindwtr({
      getTask: mock(async (id: string) => taskOf({ id })),
      updateTask: mock(async (id, patch) => {
        updatedTasks.push({ id, patch: patch as Record<string, unknown> })
        return taskOf({ id })
      }),
      createTask: mock(async (params) => taskOf({ id: 'task-1', title: params.title, projectId: params.projectId })),
      createProject: mock(async (params) => {
        createdProjects.push({ title: params.title })
        return {
          id: 'proj-1',
          title: params.title,
          status: 'active' as const,
          color: '#7c3aed',
          order: 0,
          tagIds: [],
          createdAt: '2026-05-11T00:00:00Z',
          updatedAt: '2026-05-11T00:00:00Z',
        }
      }),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const payload: SplitPayload = {
      kind: 'split',
      sourceTaskId: 'src',
      deleteSource: false,
      resultTasks: [
        { title: 'Project umbrella', status: 'inbox', tags: [], description: '', metadata: {} },
        { title: 'Child action', status: 'next', tags: [], description: '', metadata: {} },
      ],
    }
    const p = store.create({ type: 'split', targetTaskIds: ['src'], sourceAgent: 'a', payload })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.projectId).toBe('proj-1')
      expect(result.appliedTaskIds).toEqual(['src', 'task-1'])
    }
    expect(updatedTasks).toEqual([{ id: 'src', patch: { projectId: 'proj-1' } }])
  })
})

describe('ProposalApplier — guards', () => {
  it('refuses to apply non-pending proposal', async () => {
    const mindwtr = makeMindwtr()
    const applier = new ProposalApplier(store, mindwtr)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: {
        kind: 'create',
        task: { title: 't', status: 'inbox', tags: [], description: '', metadata: {} },
        traceback: { captureExcerpt: '', sourceChannel: 'x' },
      },
    })
    store.transition(p.id, 'rejected', 'user')
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_pending')
  })

  it('returns invalid_payload when payload kind missing', async () => {
    const mindwtr = makeMindwtr()
    const applier = new ProposalApplier(store, mindwtr)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: { foo: 'bar' } as unknown as CreatePayload,
    })
    const result = await applier.apply(p.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_payload')
  })
})
