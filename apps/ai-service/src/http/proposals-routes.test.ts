import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpServer } from './server'
import { ContextStore } from '../context-store/store'
import { ProposalStore } from '../proposal-store/store'
import { ProposalApplier } from '../proposal-store/apply'
import { TaskChangeProcessor } from '../proposal-store/task-change-processor'
import { CommentHandler } from '../proposal-store/comment-handler'
import type { MindwtrClient, Task } from '../api/mindwtr-client'
import type { Reviser, ReviseOutcome } from '../commitment/reviser'
import type { CreatePayload } from '../proposal-store/payloads'

const TOKEN = 'test-token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

let dir: string
let contextStore: ContextStore
let store: ProposalStore
let mindwtr: MindwtrClient

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Hi',
    status: 'inbox',
    contexts: [],
    tags: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...over,
  }
}

function makeMindwtr(over: Partial<MindwtrClient> = {}): MindwtrClient {
  return {
    createTask: mock(async () => taskOf({ id: 'created-t' })),
    getTask: mock(async (id: string) => taskOf({ id })),
    updateTask: mock(async (id, patch) => taskOf({ id, ...patch })),
    deleteTask: mock(async () => true),
    completeTask: mock(async (id) => taskOf({ id })),
    listTasks: mock(async () => []),
    search: mock(async () => ({ tasks: [], projects: [] })),
    healthCheck: mock(async () => true),
    ...over,
  } as unknown as MindwtrClient
}

function reviserReturning(outcome: ReviseOutcome): Reviser {
  return { revise: mock(async () => outcome) } as unknown as Reviser
}

function setupServer(reviser: Reviser = reviserReturning({ kind: 'clarify', agentMessage: 'ok' })) {
  const applier = new ProposalApplier(store, mindwtr)
  const commentHandler = new CommentHandler({
    store,
    reviser,
    mindwtr,
    contextStore,
  })
  const taskChangeProcessor = new TaskChangeProcessor(store)
  const server = createHttpServer({
    port: 0,
    authToken: TOKEN,
    capture: async () => {},
    contextStore: null,
    proposals: { store, applier, commentHandler, taskChangeProcessor },
    persons: null,
  })
  return server.handler
}

const baseCreatePayload: CreatePayload = {
  kind: 'create',
  task: { title: 'Pay invoice', status: 'inbox', tags: [], description: '', metadata: {} },
  traceback: { captureExcerpt: 'invoice', sourceChannel: 'screen_capture' },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-r-'))
  contextStore = ContextStore.open({ dbPath: join(dir, 'test.db') })
  store = new ProposalStore(contextStore.rawDb)
  mindwtr = makeMindwtr()
})

afterEach(() => {
  contextStore.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /v1/proposals', () => {
  it('lists pending with filters', async () => {
    const handler = setupServer()
    const a = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'commitment-detector',
      payload: baseCreatePayload,
    })
    const b = store.create({
      type: 'modify',
      targetTaskIds: ['task-x'],
      sourceAgent: 'dedup-agent',
      payload: { kind: 'modify', taskId: 'task-x', diff: [] },
    })
    store.transition(a.id, 'rejected', 'user')

    const res = await handler(new Request('http://x/v1/proposals', { headers: AUTH }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string }[] }
    expect(body.items.map((i) => i.id)).toEqual([b.id])
  })

  it('returns 401 without auth', async () => {
    const handler = setupServer()
    const res = await handler(new Request('http://x/v1/proposals'))
    expect(res.status).toBe(401)
  })
})

describe('GET /v1/proposals/:id', () => {
  it('returns full detail', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}`, { headers: AUTH })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      versions: { version: number }[]
      audit: { event: string }[]
    }
    expect(body.id).toBe(p.id)
    expect(body.versions.length).toBe(1)
    expect(body.audit[0]!.event).toBe('created')
  })

  it('returns 404 for unknown id', async () => {
    const handler = setupServer()
    const res = await handler(
      new Request('http://x/v1/proposals/nope', { headers: AUTH })
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/proposals/:id/approve', () => {
  it('applies and transitions to approved', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, { method: 'POST', headers: AUTH })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; appliedTaskIds: string[] }
    expect(body.ok).toBe(true)
    expect(body.appliedTaskIds).toEqual(['created-t'])
    expect(store.get(p.id)!.status).toBe('approved')
  })

  it('partial approval: includeFields filters modify diff before apply', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['task-x'],
      sourceAgent: 'enricher',
      payload: {
        kind: 'modify',
        taskId: 'task-x',
        diff: [
          { field: 'title', from: 'old', to: 'new' },
          { field: 'status', from: 'inbox', to: 'next' },
          { field: 'tags', from: [], to: ['@phone'] },
        ],
      },
      originSnapshot: { taskId: 'task-x', title: 'old', tags: [] },
    })
    mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 'task-x', title: 'old', tags: [] })),
    } as Partial<MindwtrClient>)
    // Rebuild server so the new mindwtr stub is used by the applier.
    const applier = new ProposalApplier(store, mindwtr)
    const commentHandler = new CommentHandler({
      store,
      reviser: reviserReturning({ kind: 'clarify', agentMessage: 'x' }),
      mindwtr,
      contextStore,
    })
    const taskChangeProcessor = new TaskChangeProcessor(store)
    const server = createHttpServer({
      port: 0,
      authToken: TOKEN,
      capture: async () => {},
      contextStore: null,
      proposals: { store, applier, commentHandler, taskChangeProcessor },
      persons: null,
    })

    const res = await server.handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ includeFields: ['title', 'status'] }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const updateCalls = (mindwtr.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls
    const patch = updateCalls[0][1]
    expect(patch).toHaveProperty('title', 'new')
    expect(patch).toHaveProperty('status', 'next')
    expect(patch).not.toHaveProperty('tags')

    const detail = store.getDetail(p.id)!
    expect(detail.versions.length).toBe(2)
    expect(detail.versions[1]!.author).toBe('user')
    expect(detail.versions[1]!.summary).toContain('partial approval')
  })

  it('partial approval: rejects 400 when modify payload has none of the listed fields', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['t'],
      sourceAgent: 'enricher',
      payload: {
        kind: 'modify',
        taskId: 't',
        diff: [{ field: 'title', from: 'a', to: 'b' }],
      },
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ includeFields: ['status'] }),
      })
    )
    expect(res.status).toBe(400)
    expect(store.get(p.id)!.status).toBe('pending')
  })

  it('partial approval: 400 when proposal is not modify type', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ includeFields: ['title'] }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('full approve still works (no includeFields → applies whole diff)', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['task-y'],
      sourceAgent: 'enricher',
      payload: {
        kind: 'modify',
        taskId: 'task-y',
        diff: [
          { field: 'title', from: 'a', to: 'b' },
          { field: 'status', from: 'inbox', to: 'next' },
        ],
      },
      originSnapshot: { taskId: 'task-y', title: 'a' },
    })
    mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 'task-y', title: 'a' })),
    } as Partial<MindwtrClient>)
    const applier = new ProposalApplier(store, mindwtr)
    const commentHandler = new CommentHandler({
      store,
      reviser: reviserReturning({ kind: 'clarify', agentMessage: 'x' }),
      mindwtr,
      contextStore,
    })
    const taskChangeProcessor = new TaskChangeProcessor(store)
    const server = createHttpServer({
      port: 0,
      authToken: TOKEN,
      capture: async () => {},
      contextStore: null,
      proposals: { store, applier, commentHandler, taskChangeProcessor },
      persons: null,
    })
    const res = await server.handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, { method: 'POST', headers: AUTH })
    )
    expect(res.status).toBe(200)
    expect(store.getDetail(p.id)!.versions.length).toBe(1)
  })

  it('returns 409 on stale (drift detected)', async () => {
    const handler = setupServer()
    mindwtr = makeMindwtr({
      getTask: mock(async () => taskOf({ id: 'task-x', title: 'user-edited' })),
    } as Partial<MindwtrClient>)
    // need to rebuild applier with new mindwtr
    const applier = new ProposalApplier(store, mindwtr)
    const commentHandler = new CommentHandler({
      store,
      reviser: reviserReturning({ kind: 'clarify', agentMessage: 'x' }),
      mindwtr,
      contextStore,
    })
    const taskChangeProcessor = new TaskChangeProcessor(store)
    const server = createHttpServer({
      port: 0,
      authToken: TOKEN,
      capture: async () => {},
      contextStore: null,
      proposals: { store, applier, commentHandler, taskChangeProcessor },
      persons: null,
    })
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['task-x'],
      sourceAgent: 'a',
      payload: {
        kind: 'modify',
        taskId: 'task-x',
        diff: [{ field: 'title', from: 'original', to: 'updated' }],
      },
    })
    const res = await server.handler(
      new Request(`http://x/v1/proposals/${p.id}/approve`, { method: 'POST', headers: AUTH })
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: boolean; reason: string }
    expect(body.reason).toBe('stale')
    expect(store.get(p.id)!.status).toBe('stale')
  })
})

describe('POST /v1/proposals/:id/reject', () => {
  it('marks rejected with reason saved as message', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/reject`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ reason: 'not relevant' }),
      })
    )
    expect(res.status).toBe(200)
    expect(store.get(p.id)!.status).toBe('rejected')
    expect(store.messages(p.id)[0]!.text).toBe('not relevant')
  })

  it('rejects without body', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/reject`, { method: 'POST', headers: AUTH })
    )
    expect(res.status).toBe(200)
    expect(store.get(p.id)!.status).toBe('rejected')
  })

  it('kind=already-done records audit meta as already-done, no apply', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/reject`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ kind: 'already-done' }),
      })
    )
    expect(res.status).toBe(200)
    expect(store.get(p.id)!.status).toBe('rejected')
    const detail = store.getDetail(p.id)!
    const rejectedEvt = detail.audit.find((a) => a.event === 'rejected')!
    expect((rejectedEvt.eventMeta as { kind?: string }).kind).toBe('already-done')
  })

  it('kind=not-applicable records distinct audit meta', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/reject`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ kind: 'not-applicable', reason: 'meeting cancelled' }),
      })
    )
    expect(res.status).toBe(200)
    const detail = store.getDetail(p.id)!
    const rejectedEvt = detail.audit.find((a) => a.event === 'rejected')!
    expect((rejectedEvt.eventMeta as { kind?: string; reason?: string }).kind).toBe('not-applicable')
    expect((rejectedEvt.eventMeta as { reason?: string }).reason).toBe('meeting cancelled')
  })
})

describe('POST /v1/proposals/:id/comments', () => {
  it('appends comment, runs reviser, returns updated detail', async () => {
    const reviser = reviserReturning({
      kind: 'clarify',
      agentMessage: 'Which Alice?',
    })
    const handler = setupServer(reviser)
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/comments`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ text: 'change recipient' }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; outcome: { kind: string } }
    expect(body.ok).toBe(true)
    expect(body.outcome.kind).toBe('clarify')
    const messages = store.messages(p.id)
    expect(messages.map((m) => m.text)).toEqual(['change recipient', 'Which Alice?'])
  })

  it('returns 400 on missing text', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'a',
      payload: baseCreatePayload,
    })
    const res = await handler(
      new Request(`http://x/v1/proposals/${p.id}/comments`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/proposals/task-changes (webhook)', () => {
  it('processes edit event and supersedes pending modify proposals', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'modify',
      targetTaskIds: ['task-x'],
      sourceAgent: 'a',
      payload: {
        kind: 'modify',
        taskId: 'task-x',
        diff: [{ field: 'title', from: 'old', to: 'new' }],
      },
    })
    const res = await handler(
      new Request('http://x/v1/proposals/task-changes', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          kind: 'edit',
          taskId: 'task-x',
          fields: { title: 'something user typed' },
        }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      outcomes: { proposalId: string; result: string; reason?: string }[]
    }
    expect(body.outcomes).toHaveLength(1)
    expect(body.outcomes[0]!.proposalId).toBe(p.id)
    expect(body.outcomes[0]!.result).toBe('superseded')
    expect(typeof body.outcomes[0]!.reason).toBe('string')
    expect(store.get(p.id)!.status).toBe('superseded')
  })

  it('processes delete event and approves matching delete proposal', async () => {
    const handler = setupServer()
    const p = store.create({
      type: 'delete',
      targetTaskIds: ['task-x'],
      sourceAgent: 'a',
      payload: { kind: 'delete', taskId: 'task-x', reason: 'gone' },
    })
    const res = await handler(
      new Request('http://x/v1/proposals/task-changes', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ kind: 'delete', taskId: 'task-x' }),
      })
    )
    expect(res.status).toBe(200)
    expect(store.get(p.id)!.status).toBe('approved')
  })

  it('400 on invalid event shape', async () => {
    const handler = setupServer()
    const res = await handler(
      new Request('http://x/v1/proposals/task-changes', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ kind: 'edit' }),
      })
    )
    expect(res.status).toBe(400)
  })
})
