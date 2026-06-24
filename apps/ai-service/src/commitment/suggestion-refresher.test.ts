import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore } from '../context-store/store'
import { ProposalStore } from '../proposal-store/store'
import { SuggestionRefresher } from './suggestion-refresher'
import { SOURCE_AGENT_COMMITMENT_DETECTOR } from './writer'
import type { Reviser, ReviseOutcome } from './reviser'
import type { CreatePayload } from '../proposal-store/payloads'

let dir: string
let contextStore: ContextStore
let store: ProposalStore

function reviserReturning(out: ReviseOutcome): Reviser {
  return { revise: mock(async () => out) } as unknown as Reviser
}

function createPayload(title: string, whoTo?: string, byWhen?: string): CreatePayload {
  return {
    kind: 'create',
    task: {
      title,
      status: 'inbox',
      tags: [],
      description: '',
      metadata: {
        ...(whoTo ? { ai_who_to: whoTo } : {}),
        ...(byWhen ? { ai_by_when: byWhen } : {}),
      },
    },
    traceback: { captureExcerpt: '', sourceChannel: 'screen_capture' },
  }
}

function seedPending(payload: CreatePayload): string {
  const p = store.create({
    type: 'create',
    targetTaskIds: [],
    sourceAgent: SOURCE_AGENT_COMMITMENT_DETECTOR,
    payload,
  })
  return p.id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-sr-'))
  contextStore = ContextStore.open({ dbPath: join(dir, 'test.db') })
  store = new ProposalStore(contextStore.rawDb)
})

afterEach(() => {
  contextStore.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SuggestionRefresher', () => {
  it('finds pending create-suggestion by normalized title and adds a v2 on revise', async () => {
    const id = seedPending(createPayload('Pay Acme invoice'))
    const newPayload = createPayload('Pay Acme invoice $500')
    const reviser = reviserReturning({
      kind: 'revise',
      newPayload,
      summary: 'added amount',
      agentMessage: 'Folded in the $500 amount from the new capture.',
    })
    const refresher = new SuggestionRefresher({ store, reviser, contextStore })

    // Proposer's duplicate_of_title carries only a title (word order drift ok).
    const result = await refresher.refresh({
      existingTitle: 'Pay the invoice from Acme',
      captureText: 'It is $500, due Friday',
    })

    expect(result.kind).toBe('revised')
    const detail = store.getDetail(id)!
    expect(detail.currentVersion).toBe(2)
    expect(detail.versions[1]!.payload).toEqual(newPayload)
    expect(detail.versions[1]!.summary).toContain('refreshed on new evidence')
    expect(detail.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'agent:Folded in the $500 amount from the new capture.',
    ])
  })

  it('returns no-match when no pending suggestion title matches', async () => {
    seedPending(createPayload('Pay Acme invoice'))
    const reviser = reviserReturning({ kind: 'clarify', agentMessage: 'x' })
    const refresher = new SuggestionRefresher({ store, reviser, contextStore })

    const result = await refresher.refresh({
      existingTitle: 'Book flight to Berlin',
      captureText: 'whatever',
    })

    expect(result.kind).toBe('no-match')
    // Reviser must not be called when there is no match.
    expect((reviser.revise as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  it('clarify outcome posts an agent message without a version bump', async () => {
    const id = seedPending(createPayload('Pay Acme invoice'))
    const reviser = reviserReturning({
      kind: 'clarify',
      agentMessage: 'No new detail to add.',
    })
    const refresher = new SuggestionRefresher({ store, reviser, contextStore })

    const result = await refresher.refresh({
      existingTitle: 'Pay Acme invoice',
      captureText: 'duplicate ping',
    })

    expect(result.kind).toBe('clarified')
    const detail = store.getDetail(id)!
    expect(detail.currentVersion).toBe(1)
    expect(detail.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'agent:No new detail to add.',
    ])
  })

  it('withdraw outcome is ignored — a fresh capture never rejects a pending suggestion', async () => {
    const id = seedPending(createPayload('Pay Acme invoice'))
    const reviser = reviserReturning({
      kind: 'withdraw',
      reason: 'no comment',
      agentMessage: 'Withdrawing.',
    })
    const refresher = new SuggestionRefresher({ store, reviser, contextStore })

    const result = await refresher.refresh({
      existingTitle: 'Pay Acme invoice',
      captureText: 'duplicate ping',
    })

    expect(result.kind).toBe('skipped')
    const detail = store.getDetail(id)!
    expect(detail.status).toBe('pending')
    expect(detail.currentVersion).toBe(1)
    expect(detail.messages.length).toBe(0)
  })

  it('skips on kind mismatch (reviser returned a non-create payload)', async () => {
    const id = seedPending(createPayload('Pay Acme invoice'))
    const reviser = reviserReturning({
      kind: 'revise',
      newPayload: { kind: 'modify', taskId: 't1', diff: [] },
      summary: 'oops',
      agentMessage: 'changed kind',
    })
    const refresher = new SuggestionRefresher({ store, reviser, contextStore })

    const result = await refresher.refresh({
      existingTitle: 'Pay Acme invoice',
      captureText: 'duplicate ping',
    })

    expect(result.kind).toBe('skipped')
    const detail = store.getDetail(id)!
    expect(detail.currentVersion).toBe(1)
  })
})
