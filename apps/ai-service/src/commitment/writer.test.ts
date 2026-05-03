import { describe, it, expect, mock } from 'bun:test'
import { ProposalWriter } from './writer'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { Proposal } from './proposer'

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    is_actionable: true,
    title: 'Pay Acme invoice',
    who_owes: 'user',
    who_to: 'Acme',
    what: 'Pay $500 invoice from Acme by Friday',
    by_when: 'Friday',
    confidence: 0.88,
    reasoning: 'Invoice with explicit due date',
    ...overrides,
  }
}

describe('ProposalWriter', () => {
  it('creates Mindwtr task with [AI] prefix and proposal-ai tag', async () => {
    const mindwtr = {
      createTask: mock(async () => ({
        id: 'task-1',
        title: '[AI] Pay Acme invoice',
        status: 'inbox',
        tags: ['proposal-ai'],
        contexts: [],
        createdAt: '2026-04-24T10:00:00Z',
        updatedAt: '2026-04-24T10:00:00Z',
      })),
    } as unknown as MindwtrClient

    const writer = new ProposalWriter(mindwtr)
    const result = await writer.write({
      proposal: makeProposal(),
      captureText: 'Invoice from Acme due 2026-04-25, $500',
      sourceCaptureId: 'cap-uuid',
      sourceChannel: 'screen_capture',
      sourceMeta: { app: 'Mail', windowTitle: 'Inbox' },
    })

    expect(result.taskId).toBe('task-1')
    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)

    const calls = (mindwtr.createTask as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls
    const arg = calls[0][0] as {
      title: string
      status: string
      tags: string[]
      description: string
      metadata: Record<string, unknown>
    }
    expect(arg.title.startsWith('[AI] ')).toBe(true)
    expect(arg.title).toBe('[AI] Pay Acme invoice')
    expect(arg.status).toBe('inbox')
    expect(arg.tags).toEqual(['proposal-ai'])
    expect(arg.metadata.ai_proposal).toBe(true)
    expect(arg.metadata.ai_confidence).toBe(0.88)
    expect(arg.metadata.source_capture_id).toBe('cap-uuid')
    expect(arg.metadata.source_channel).toBe('screen_capture')
    expect(arg.metadata.awaiting_decision).toBe(true)
  })

  it('description includes traceback excerpt and reasoning', async () => {
    const mindwtr = {
      createTask: mock(async () => ({
        id: 'task-1',
        title: '[AI] X',
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: '2026-04-24T10:00:00Z',
        updatedAt: '2026-04-24T10:00:00Z',
      })),
    } as unknown as MindwtrClient

    const writer = new ProposalWriter(mindwtr)
    await writer.write({
      proposal: makeProposal({ reasoning: 'because of explicit "I will" cue' }),
      captureText: 'Long capture text that we expect to appear in description',
      sourceCaptureId: 'cap',
      sourceChannel: 'screen_capture',
    })
    const calls = (mindwtr.createTask as unknown as { mock: { calls: [{ description: string }][] } }).mock.calls
    const desc = calls[0][0].description
    expect(desc).toContain('AI proposal')
    expect(desc).toContain('Reasoning:')
    expect(desc).toContain('because of explicit')
    expect(desc).toContain('Long capture text')
    expect(desc).toContain('proposal-ai')
  })

  it('truncates very long capture text in description', async () => {
    const mindwtr = {
      createTask: mock(async () => ({
        id: 't',
        title: '[AI] X',
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: '',
        updatedAt: '',
      })),
    } as unknown as MindwtrClient

    const writer = new ProposalWriter(mindwtr)
    const longText = 'A'.repeat(2000)
    await writer.write({
      proposal: makeProposal(),
      captureText: longText,
      sourceCaptureId: 'cap',
      sourceChannel: 'screen_capture',
    })
    const calls = (mindwtr.createTask as unknown as { mock: { calls: [{ description: string }][] } }).mock.calls
    expect(calls[0][0].description).toContain('…')
    expect(calls[0][0].description.length).toBeLessThan(longText.length)
  })

  it('does not double-prefix [AI] if proposer already included it', async () => {
    const mindwtr = {
      createTask: mock(async () => ({
        id: 't',
        title: '',
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: '',
        updatedAt: '',
      })),
    } as unknown as MindwtrClient

    const writer = new ProposalWriter(mindwtr)
    await writer.write({
      proposal: makeProposal({ title: '[AI] Already prefixed' }),
      captureText: 'x',
      sourceCaptureId: 'cap',
      sourceChannel: 'screen_capture',
    })
    const calls = (mindwtr.createTask as unknown as { mock: { calls: [{ title: string }][] } }).mock.calls
    expect(calls[0][0].title).toBe('[AI] Already prefixed')
  })
})
