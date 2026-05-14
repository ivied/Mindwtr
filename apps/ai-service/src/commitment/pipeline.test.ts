import { describe, it, expect, mock } from 'bun:test'
import { CommitmentPipeline } from './pipeline'
import type { Proposer, Proposal } from './proposer'
import type { ProposalWriter } from './writer'
import type { CaptureRecord } from '../context-store/types'

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-1',
    text: "I'll send the Q4 report to Alice by Friday for the quarterly review",
    sourceChannel: 'screen_capture',
    sourceMeta: null,
    capturedAt: '2026-04-24T10:00:00Z',
    receivedAt: '2026-04-24T10:00:00Z',
    contentHash: 'hash',
    ttlAt: '2026-05-01T10:00:00Z',
    isPull: true,
    ...overrides,
  }
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    is_actionable: true,
    title: 'Send Q4 report to Alice',
    who_owes: 'user',
    recipient: 'other',
    who_to: 'Alice',
    what: 'Send Q4 report',
    by_when: 'Friday',
    confidence: 0.85,
    reasoning: 'User committed via "I will" cue',
    evidence_quote: "I'll send the Q4 report to Alice by Friday",
    cues_detected: ['direct first-person verb', 'named recipient', 'deadline phrase'],
    reasoning_steps: [
      'Spotted explicit "I\'ll send" commitment from user.',
      'Named recipient and deadline make it actionable.',
    ],
    duplicate_of_title: '',
    suggested_category: 'next',
    who_to_slug: '',
    ...overrides,
  }
}

function silent() {
  return () => {}
}

describe('CommitmentPipeline', () => {
  it('returns source-denied when sourceMeta matches deny app, never calls LLM', async () => {
    const proposer = { propose: mock() } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(
      proposer,
      writer,
      {
        minConfidence: 0.7,
        useL0: true,
        sourceDeny: { apps: ['Telegram'], urlPatterns: [], windowTitlePatterns: [] },
      },
      silent()
    )
    const out = await p.run(record({ sourceMeta: { app: 'Telegram', windowTitle: '' } }))
    expect(out.kind).toBe('source-denied')
    expect(proposer.propose).not.toHaveBeenCalled()
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('returns source-denied when URL matches a deny pattern', async () => {
    const proposer = { propose: mock() } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(
      proposer,
      writer,
      {
        minConfidence: 0.7,
        useL0: true,
        sourceDeny: { apps: [], urlPatterns: ['claude.ai/design'], windowTitlePatterns: [] },
      },
      silent()
    )
    const out = await p.run(
      record({ sourceMeta: { app: 'Chrome', url: 'https://claude.ai/design/foo' } })
    )
    expect(out.kind).toBe('source-denied')
  })

  it('returns l0-skip for noise text and never calls LLM', async () => {
    const proposer = { propose: mock() } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())

    const result = await p.run(record({ text: 'just an observation about the weather' }))
    expect(result.kind).toBe('l0-skip')
    expect(proposer.propose).not.toHaveBeenCalled()
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('writes proposal when actionable + user role + confidence above threshold', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p-1', version: 1, title: 'Send Q4 report to Alice' })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())

    const result = await p.run(record())
    expect(result.kind).toBe('proposed')
    if (result.kind === 'proposed') {
      expect(result.proposalId).toBe('p-1')
      expect(result.title).toBe('Send Q4 report to Alice')
    }
    expect(writer.write).toHaveBeenCalledTimes(1)
  })

  it('skips when proposer says not-actionable', async () => {
    const proposer = {
      propose: mock(async () => makeProposal({ is_actionable: false, title: '' })),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())

    const result = await p.run(record())
    expect(result.kind).toBe('not-actionable')
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('proceeds for who_owes=other when recipient=user (waiting-for card)', async () => {
    const proposer = {
      propose: mock(async () =>
        makeProposal({
          who_owes: 'other',
          recipient: 'user',
          suggested_category: 'waiting',
          title: 'Waiting for Amir on Flutter answer',
        })
      ),
    } as unknown as Proposer
    const writer = {
      write: mock(async () => ({
        proposalId: 'p-waiting',
        version: 1,
        title: 'Waiting for Amir on Flutter answer',
        proposal: {} as unknown,
      })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const out = await p.run(record())
    expect(out.kind).toBe('proposed')
    expect(writer.write).toHaveBeenCalledTimes(1)
  })

  it('skips when commitment belongs to someone else AND recipient is also other (third-party)', async () => {
    const proposer = {
      propose: mock(async () => makeProposal({ who_owes: 'other', recipient: 'other' })),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())

    const result = await p.run(record())
    expect(result.kind).toBe('wrong-role')
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('skips when confidence is below threshold', async () => {
    const proposer = {
      propose: mock(async () => makeProposal({ confidence: 0.5 })),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(
      proposer,
      writer,
      { minConfidence: 0.7, useL0: true },
      silent()
    )

    const result = await p.run(record())
    expect(result.kind).toBe('low-confidence')
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('useL0=false bypasses regex pre-filter', async () => {
    const proposer = {
      propose: mock(async () => makeProposal({ is_actionable: false })),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(
      proposer,
      writer,
      { minConfidence: 0.7, useL0: false },
      silent()
    )

    // Text without commitment cues — would be L0-skipped — but useL0=false so passes
    await p.run(record({ text: 'just an observation about the weather' }))
    expect(proposer.propose).toHaveBeenCalledTimes(1)
  })

  it('returns error when proposer throws', async () => {
    const proposer = {
      propose: mock(async () => {
        throw new Error('LLM down')
      }),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const result = await p.run(record())
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.error.message).toBe('LLM down')
  })

  it('returns duplicate-of-existing when Proposer flags semantic match against inbox', async () => {
    const proposer = {
      propose: mock(async () =>
        makeProposal({
          is_actionable: false,
          duplicate_of_title: 'Send Q4 report — final draft',
          reasoning: 'Duplicate of: Send Q4 report — final draft',
        })
      ),
    } as unknown as Proposer
    const writer = { write: mock() } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    p.setInboxTitlesProvider({
      recentTitles: mock(async () => ['Send Q4 report — final draft', 'Pay rent']),
    })
    const out = await p.run(record())
    expect(out.kind).toBe('duplicate-of-existing')
    if (out.kind === 'duplicate-of-existing') {
      expect(out.existingTitle).toBe('Send Q4 report — final draft')
    }
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('passes knownPersons into proposer.propose when provider is set', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const persons = [
      { slug: 'amir-red', name: 'Amir Red', aliases: ['Amir', 'Амир'], mentionCount: 5 },
      { slug: 'polina', name: 'Polina', aliases: ['Полина'], mentionCount: 14 },
    ]
    p.setPersonsProvider({ recentPersons: mock(async () => persons) })
    await p.run(record())
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[4]).toEqual(persons)
  })

  it('proceeds with empty persons list when provider throws', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    p.setPersonsProvider({
      recentPersons: mock(async () => {
        throw new Error('wiki gone')
      }),
    })
    const out = await p.run(record())
    expect(out.kind).toBe('proposed')
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[4]).toBeUndefined()
  })

  it('passes userIdentity into proposer.propose when set', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const identity = { name: 'Sergey Kurdyuk', aliases: ['sergey', 'Серёжа'] }
    p.setUserIdentity(identity)
    await p.run(record())
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[3]).toEqual(identity)
  })

  it('passes recent inbox titles into proposer.propose when provider is set', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p-1', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const titles = ['Existing item 1', 'Existing item 2']
    p.setInboxTitlesProvider({ recentTitles: mock(async () => titles) })
    await p.run(record())
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[2]).toEqual(titles)
  })

  it('proceeds without inbox titles when provider throws', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p-1', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    p.setInboxTitlesProvider({
      recentTitles: mock(async () => {
        throw new Error('mindwtr down')
      }),
    })
    const out = await p.run(record())
    expect(out.kind).toBe('proposed')
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[2]).toBeUndefined()
  })

  it('passes labelled RecentItem[] into proposer when a RecentItemsProvider is set', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const items = [
      { title: 'In inbox', source: 'inbox' as const },
      { title: 'User just rejected', source: 'resolved' as const, resolution: 'rejected' as const, ageMs: 60_000 },
    ]
    p.setRecentItemsProvider({ recentItems: mock(async () => items) })
    await p.run(record())
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[2]).toEqual(items)
  })

  it('falls back to recentTitles when only a legacy InboxTitlesProvider is wired', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => ({ proposalId: 'p', version: 1, title: 'X', proposal: {} as unknown })),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const recentItemsSpy = mock(async () => [])
    const recentTitlesSpy = mock(async () => ['legacy A', 'legacy B'])
    // Legacy provider exposes only recentTitles → pipeline should NOT call recentItems.
    p.setInboxTitlesProvider({ recentTitles: recentTitlesSpy })
    await p.run(record())
    const args = (proposer.propose as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(args[2]).toEqual(['legacy A', 'legacy B'])
    expect(recentItemsSpy).not.toHaveBeenCalled()
  })

  it('returns error when writer throws', async () => {
    const proposer = { propose: mock(async () => makeProposal()) } as unknown as Proposer
    const writer = {
      write: mock(async () => {
        throw new Error('mindwtr down')
      }),
    } as unknown as ProposalWriter
    const p = new CommitmentPipeline(proposer, writer, undefined, silent())
    const result = await p.run(record())
    expect(result.kind).toBe('error')
  })
})
