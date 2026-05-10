import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore } from '../context-store/store'
import { ProposalStore } from './store'
import { CommentHandler } from './comment-handler'
import type { Reviser, ReviseOutcome } from '../commitment/reviser'
import type { MindwtrClient, Task } from '../api/mindwtr-client'
import type { CreatePayload, ModifyPayload } from './payloads'

let dir: string
let contextStore: ContextStore
let store: ProposalStore

function makeMindwtr(getTask?: (id: string) => Promise<Task>): MindwtrClient {
  return {
    getTask: mock(getTask ?? (async (id: string) => taskOf({ id }))),
    createTask: mock(async () => taskOf()),
    updateTask: mock(async (id) => taskOf({ id })),
    deleteTask: mock(async () => true),
    completeTask: mock(async (id) => taskOf({ id })),
    listTasks: mock(async () => []),
    search: mock(async () => ({ tasks: [], projects: [] })),
    healthCheck: mock(async () => true),
  } as unknown as MindwtrClient
}

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Hello',
    status: 'inbox',
    contexts: [],
    tags: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...over,
  }
}

function reviserReturning(out: ReviseOutcome): Reviser {
  return { revise: mock(async () => out) } as unknown as Reviser
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-ch-'))
  contextStore = ContextStore.open({ dbPath: join(dir, 'test.db') })
  store = new ProposalStore(contextStore.rawDb)
})

afterEach(() => {
  contextStore.close()
  rmSync(dir, { recursive: true, force: true })
})

const createPayload: CreatePayload = {
  kind: 'create',
  task: { title: 'Pay invoice', status: 'inbox', tags: [], description: '', metadata: {} },
  traceback: { captureExcerpt: 'invoice due Friday', sourceChannel: 'screen_capture' },
}

describe('CommentHandler — revise', () => {
  it('appends user message, calls reviser, then writes new version + agent reply', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const newPayload: CreatePayload = {
      ...createPayload,
      task: { ...createPayload.task, title: 'Pay Acme invoice $500' },
    }
    const reviser = reviserReturning({
      kind: 'revise',
      newPayload,
      summary: 'sharpened title',
      agentMessage: 'Updated title to include amount.',
    })
    const handler = new CommentHandler({
      store,
      reviser,
      mindwtr: makeMindwtr(),
      contextStore,
    })

    const result = await handler.handle({ proposalId: p.id, text: 'add the amount please' })
    expect(result.ok).toBe(true)
    expect(result.outcome?.kind).toBe('revise')

    const detail = store.getDetail(p.id)!
    expect(detail.currentVersion).toBe(2)
    expect(detail.versions[1]!.payload).toEqual(newPayload)
    expect(detail.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:add the amount please',
      'agent:Updated title to include amount.',
    ])
    expect(detail.audit.map((a) => a.event)).toEqual([
      'created',
      'commented',
      'revised',
      'commented',
    ])
  })

  it('rejects revision that switches kind, audits validation failure', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const reviser = reviserReturning({
      kind: 'revise',
      newPayload: {
        kind: 'modify',
        taskId: 'x',
        diff: [{ field: 'title', from: 'a', to: 'b' }],
      } as ModifyPayload,
      summary: 'switching kind',
      agentMessage: 'Changed shape entirely',
    })
    const handler = new CommentHandler({
      store,
      reviser,
      mindwtr: makeMindwtr(),
      contextStore,
    })

    await handler.handle({ proposalId: p.id, text: 'try again' })
    const detail = store.getDetail(p.id)!
    // Version was NOT bumped despite reviser saying "revise".
    expect(detail.currentVersion).toBe(1)
    expect(detail.audit.some((a) => a.event === 'apply_failed')).toBe(true)
    // Last message is agent's apology asking to rephrase.
    expect(detail.messages[detail.messages.length - 1]!.role).toBe('agent')
  })
})

describe('CommentHandler — clarify', () => {
  it('appends agent question without bumping version', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const reviser = reviserReturning({
      kind: 'clarify',
      agentMessage: 'Which Alice did you mean?',
    })
    const handler = new CommentHandler({
      store,
      reviser,
      mindwtr: makeMindwtr(),
      contextStore,
    })
    await handler.handle({ proposalId: p.id, text: 'change recipient' })
    const detail = store.getDetail(p.id)!
    expect(detail.currentVersion).toBe(1)
    expect(detail.messages.map((m) => m.text)).toEqual([
      'change recipient',
      'Which Alice did you mean?',
    ])
    expect(detail.status).toBe('pending')
  })
})

describe('CommentHandler — withdraw', () => {
  it('transitions to rejected with actor=agent and audit meta', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const reviser = reviserReturning({
      kind: 'withdraw',
      reason: 'user said this was unrelated',
      agentMessage: 'Got it — withdrawing.',
    })
    const handler = new CommentHandler({
      store,
      reviser,
      mindwtr: makeMindwtr(),
      contextStore,
    })
    await handler.handle({ proposalId: p.id, text: 'never mind, this is from a meme' })
    const refreshed = store.get(p.id)!
    expect(refreshed.status).toBe('rejected')
    const audit = store.auditLog(p.id)
    const rejectedRow = audit.find((a) => a.event === 'rejected')!
    expect(rejectedRow.actor).toBe('agent')
    expect(rejectedRow.eventMeta).toMatchObject({ withdraw: true })
  })
})

describe('CommentHandler — failure modes', () => {
  it('keeps user message but logs apply_failed audit when Reviser throws', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const reviser = {
      revise: mock(async () => {
        throw new Error('LLM down')
      }),
    } as unknown as Reviser
    const handler = new CommentHandler({
      store,
      reviser,
      mindwtr: makeMindwtr(),
      contextStore,
    })
    const result = await handler.handle({ proposalId: p.id, text: 'try this' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('LLM down')

    const detail = store.getDetail(p.id)!
    // User comment was preserved.
    expect(detail.messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:try this'])
    expect(detail.audit.some((a) => a.event === 'apply_failed')).toBe(true)
  })

  it('throws when text is empty', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    const handler = new CommentHandler({
      store,
      reviser: reviserReturning({ kind: 'clarify', agentMessage: 'x' }),
      mindwtr: makeMindwtr(),
      contextStore,
    })
    await expect(
      handler.handle({ proposalId: p.id, text: '   ' })
    ).rejects.toThrow(/empty/)
  })

  it('refuses comment on resolved proposal', async () => {
    const p = store.create({ type: 'create', targetTaskIds: [], sourceAgent: 'a', payload: createPayload })
    store.transition(p.id, 'rejected', 'user')
    const handler = new CommentHandler({
      store,
      reviser: reviserReturning({ kind: 'clarify', agentMessage: 'x' }),
      mindwtr: makeMindwtr(),
      contextStore,
    })
    await expect(
      handler.handle({ proposalId: p.id, text: 'still want this' })
    ).rejects.toThrow(/rejected/)
  })
})
