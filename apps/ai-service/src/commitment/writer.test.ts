import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import { ProposalStore } from '../proposal-store/store'
import type { CreatePayload } from '../proposal-store/payloads'
import { ProposalWriter, SOURCE_AGENT_COMMITMENT_DETECTOR } from './writer'
import type { Proposal } from './proposer'

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    is_actionable: true,
    title: 'Pay Acme invoice',
    who_owes: 'user',
    recipient: 'unclear',
    who_to: 'Acme',
    what: 'Pay $500 invoice from Acme by Friday',
    by_when: 'Friday',
    confidence: 0.88,
    reasoning: 'Invoice with explicit due date',
    evidence_quote: 'Invoice from Acme due Friday',
    cues_detected: ['money amount', 'deadline phrase'],
    reasoning_steps: [
      'Spotted "Invoice from Acme due Friday" in capture.',
      'Concrete money + deadline → personal commitment.',
    ],
    duplicate_of_title: '',
    suggested_category: 'next',
    ...overrides,
  }
}

let dir: string
let db: DB
let store: ProposalStore

function seedCapture(id: string, text: string): void {
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO captures (id, text, source_channel, source_meta, captured_at, received_at, content_hash, ttl_at, is_pull)
     VALUES (?, ?, 'screen_capture', NULL, ?, ?, 'hash-' || ?, ?, 1)`,
    [id, text, now, now, id, now]
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-w-'))
  db = openDb(join(dir, 'test.db')).db
  store = new ProposalStore(db)
  seedCapture('cap-default', 'default capture text')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ProposalWriter', () => {
  it('creates a Proposal entity (type=create) with clean task blueprint and traceback', async () => {
    seedCapture('cap-uuid', 'Invoice from Acme due 2026-04-25, $500')
    const writer = new ProposalWriter(store)
    const result = await writer.write({
      proposal: makeProposal(),
      captureText: 'Invoice from Acme due 2026-04-25, $500',
      sourceCaptureId: 'cap-uuid',
      sourceChannel: 'screen_capture',
      sourceMeta: { app: 'Mail', windowTitle: 'Inbox' },
    })

    expect(result.proposalId).toBeDefined()
    expect(result.version).toBe(1)
    expect(result.title).toBe('Pay Acme invoice')

    const detail = store.getDetail(result.proposalId)!
    expect(detail.type).toBe('create')
    expect(detail.targetTaskIds).toEqual([])
    expect(detail.sourceAgent).toBe(SOURCE_AGENT_COMMITMENT_DETECTOR)
    expect(detail.sourceCaptureId).toBe('cap-uuid')
    expect(detail.status).toBe('pending')

    const payload = detail.currentPayload as CreatePayload
    expect(payload.kind).toBe('create')
    expect(payload.task.title).toBe('Pay Acme invoice')
    expect(payload.task.title.startsWith('[AI]')).toBe(false)
    expect(payload.task.tags).toEqual([])
    expect(payload.task.status).toBe('inbox')
    expect(payload.task.metadata.ai_origin).toBe(true)
    expect(payload.task.metadata.ai_confidence).toBe(0.88)
    expect(payload.task.metadata.source_capture_id).toBe('cap-uuid')
    expect(payload.task.metadata.source_channel).toBe('screen_capture')

    expect(payload.traceback.captureExcerpt).toContain('Invoice from Acme')
    expect(payload.traceback.sourceChannel).toBe('screen_capture')
    expect(payload.traceback.sourceMeta).toEqual({ app: 'Mail', windowTitle: 'Inbox' })
  })

  it('strips legacy [AI] prefix if present in proposed title', async () => {
    const writer = new ProposalWriter(store)
    const result = await writer.write({
      proposal: makeProposal({ title: '[AI] Already prefixed' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const payload = store.get(result.proposalId)!.currentPayload as CreatePayload
    expect(payload.task.title).toBe('Already prefixed')
    expect(result.title).toBe('Already prefixed')
  })

  it('builds description from what/by_when/who_to (no [AI] / proposal-ai mentions)', async () => {
    const writer = new ProposalWriter(store)
    const result = await writer.write({
      proposal: makeProposal({
        title: 'Ping Alice',
        what: 'Send Q4 plan to Alice',
        by_when: 'Friday',
        who_to: 'Alice',
      }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const desc = (store.get(result.proposalId)!.currentPayload as CreatePayload).task.description
    expect(desc).toContain('Send Q4 plan to Alice')
    expect(desc).toContain('Due: Friday')
    expect(desc).toContain('With/to: Alice')
    expect(desc).not.toContain('[AI]')
    expect(desc).not.toContain('proposal-ai')
  })

  it('truncates very long capture text in traceback excerpt', async () => {
    const writer = new ProposalWriter(store)
    const longText = 'A'.repeat(2000)
    const result = await writer.write({
      proposal: makeProposal(),
      captureText: longText,
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const traceback = (store.get(result.proposalId)!.currentPayload as CreatePayload).traceback
    expect(traceback.captureExcerpt.length).toBeLessThan(longText.length)
    expect(traceback.captureExcerpt.endsWith('…')).toBe(true)
  })

  it('builds smart excerpt centered on evidence_quote with ±200 char window', async () => {
    seedCapture('cap-smart', 'long text')
    const writer = new ProposalWriter(store)
    const prefix = 'A '.repeat(300) // ~600 chars of noise before
    const cue = 'I will pay Acme invoice by Friday'
    const suffix = ' B'.repeat(300) // ~600 chars after
    const longText = `${prefix}${cue}${suffix}`
    const result = await writer.write({
      proposal: makeProposal({ evidence_quote: cue }),
      captureText: longText,
      sourceCaptureId: 'cap-smart',
      sourceChannel: 'screen_capture',
    })
    const tb = (store.get(result.proposalId)!.currentPayload as { traceback: { captureExcerpt: string; evidenceQuote?: string } }).traceback
    expect(tb.captureExcerpt).toContain(cue)
    expect(tb.captureExcerpt.startsWith('…')).toBe(true)
    expect(tb.captureExcerpt.endsWith('…')).toBe(true)
    // window is roughly 200 + cue + 200 = ~440, far smaller than the source.
    expect(tb.captureExcerpt.length).toBeLessThan(longText.length / 2)
    expect(tb.evidenceQuote).toBe(cue)
  })

  it('locates evidence quote case-insensitively / whitespace-relaxed', async () => {
    const writer = new ProposalWriter(store)
    const source = 'Random preamble.  Hey  Sergey, please send me Polina info.  More text.'
    const result = await writer.write({
      proposal: makeProposal({ evidence_quote: 'hey sergey, please send me polina info' }),
      captureText: source,
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const tb = (store.get(result.proposalId)!.currentPayload as { traceback: { captureExcerpt: string } }).traceback
    expect(tb.captureExcerpt).toContain('Hey  Sergey, please send me Polina info')
  })

  it('falls back to first-N-chars when evidence quote not found', async () => {
    const writer = new ProposalWriter(store)
    const source = 'X'.repeat(2000)
    const result = await writer.write({
      proposal: makeProposal({ evidence_quote: 'something completely unrelated' }),
      captureText: source,
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const tb = (store.get(result.proposalId)!.currentPayload as { traceback: { captureExcerpt: string } }).traceback
    expect(tb.captureExcerpt.endsWith('…')).toBe(true)
    expect(tb.captureExcerpt.length).toBeLessThanOrEqual(501)
  })

  it('persists cuesDetected and reasoningSteps onto the traceback', async () => {
    const writer = new ProposalWriter(store)
    const result = await writer.write({
      proposal: makeProposal({
        cues_detected: ['direct request', 'named recipient'],
        reasoning_steps: ['Spotted X', 'Therefore Y'],
      }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const tb = (store.get(result.proposalId)!.currentPayload as { traceback: { cuesDetected?: string[]; reasoningSteps?: string[] } }).traceback
    expect(tb.cuesDetected).toEqual(['direct request', 'named recipient'])
    expect(tb.reasoningSteps).toEqual(['Spotted X', 'Therefore Y'])
  })

  it('records summary on initial version (uses Proposer reasoning)', async () => {
    const writer = new ProposalWriter(store)
    const result = await writer.write({
      proposal: makeProposal({ reasoning: 'Explicit "I will" cue spotted' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const detail = store.getDetail(result.proposalId)!
    expect(detail.versions[0]!.summary).toBe('Explicit "I will" cue spotted')
    expect(detail.audit[0]!.event).toBe('created')
  })
})

describe('ProposalWriter — dedup', () => {
  it('reuses existing proposal when title+who_to+by_when match within window', async () => {
    const writer = new ProposalWriter(store)
    const first = await writer.write({
      proposal: makeProposal(),
      captureText: 'first capture',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    expect(first.duplicate).toBeUndefined()

    // Second write with the SAME proposer output — should not create new row.
    const second = await writer.write({
      proposal: makeProposal(),
      captureText: 'second capture (different excerpt)',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    expect(second.duplicate).toBe(true)
    expect(second.proposalId).toBe(first.proposalId)

    // Verify only one proposal row exists.
    const recent = store.listRecentByAgent('commitment-detector', 60_000)
    expect(recent).toHaveLength(1)
  })

  it('treats title differing only in punctuation/case as duplicate', async () => {
    const writer = new ProposalWriter(store)
    await writer.write({
      proposal: makeProposal({ title: 'Pay Acme invoice' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const second = await writer.write({
      proposal: makeProposal({ title: 'pay  acme  INVOICE!' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    expect(second.duplicate).toBe(true)
  })

  it('does NOT dedup when who_to differs', async () => {
    const writer = new ProposalWriter(store)
    await writer.write({
      proposal: makeProposal({ who_to: 'Alice' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const second = await writer.write({
      proposal: makeProposal({ who_to: 'Bob' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    expect(second.duplicate).toBeUndefined()
    expect(store.listRecentByAgent('commitment-detector', 60_000)).toHaveLength(2)
  })

  it('does NOT dedup when by_when differs', async () => {
    const writer = new ProposalWriter(store)
    await writer.write({
      proposal: makeProposal({ by_when: 'Friday' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    const second = await writer.write({
      proposal: makeProposal({ by_when: 'Monday' }),
      captureText: 'x',
      sourceCaptureId: 'cap-default',
      sourceChannel: 'screen_capture',
    })
    expect(second.duplicate).toBeUndefined()
  })
})
