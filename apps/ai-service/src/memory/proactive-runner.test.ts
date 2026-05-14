import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'
import { ProposalStore } from '../proposal-store/store'
import { ProactiveRunner, parseProactiveOutput } from './proactive-runner'
import { PROACTIVE_SOURCE_AGENT } from './proactive-types'
import type { LLMClient } from '../ai/client'

const NOW = new Date('2026-05-14T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function mkLlm(content: string | ((promptUser: string) => string)): LLMClient {
  return {
    chatCompletion: async (req: { messages: Array<{ role: string; content: string }> }) => {
      const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? ''
      const out = typeof content === 'string' ? content : content(userMsg)
      return {
        choices: [{ message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
      }
    },
  } as unknown as LLMClient
}

let dbPath: string
let memoryStore: MemoryStore
let proposalStore: ProposalStore

beforeEach(() => {
  dbPath = join(tmpdir(), `proactive-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const { db, vecAvailable } = openDb(dbPath)
  memoryStore = new MemoryStore({ db, vecAvailable })
  proposalStore = new ProposalStore(db)
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

function seedFact(opts: {
  slug: string
  type: string
  statement: string
  hoursAgo: number
}): void {
  const validFrom = new Date(NOW.getTime() - opts.hoursAgo * HOUR).toISOString()
  memoryStore.insertFact({
    statement: opts.statement,
    entitySlug: opts.slug,
    factType: opts.type,
    validFrom,
  })
}

function seedEvent(opts: {
  id?: string
  slug: string
  hoursAgo: number
  body?: string
  app?: string
}): void {
  const id = opts.id ?? `evt-${Math.random().toString(36).slice(2)}`
  const ts = new Date(NOW.getTime() - opts.hoursAgo * HOUR).toISOString()
  memoryStore.insertEvent(
    {
      id,
      ts,
      source: 'screen',
      app: opts.app ?? 'X',
      title: 'X',
      body: opts.body ?? 'event body',
    },
    null
  )
  memoryStore.linkEntities(id, [opts.slug])
}

describe('parseProactiveOutput', () => {
  it('parses a well-formed JSON response', () => {
    const out = parseProactiveOutput(
      JSON.stringify({
        should_propose: true,
        action_title: 'Ping Joe about AI review',
        action_description: 'Joe pushed code 3 days ago — send a nudge.',
        action_kind: 'follow_up',
        reasoning: 'Joe pushed AI changes Tue. No follow-up since.',
        confidence: 0.82,
      })
    )
    expect(out.should_propose).toBe(true)
    expect(out.action_title).toContain('Joe')
    expect(out.action_kind).toBe('follow_up')
    expect(out.confidence).toBe(0.82)
  })

  it('strips code fences', () => {
    const r = parseProactiveOutput(
      '```json\n{"should_propose":false,"reasoning":"too soon","confidence":0.4,"action_title":"","action_description":"","action_kind":"other"}\n```'
    )
    expect(r.should_propose).toBe(false)
    expect(r.confidence).toBe(0.4)
  })

  it('clamps confidence to [0, 1]', () => {
    const high = parseProactiveOutput(
      '{"should_propose":true,"confidence":5,"action_title":"x","action_description":"y","action_kind":"follow_up","reasoning":"r"}'
    )
    expect(high.confidence).toBe(1)
    const low = parseProactiveOutput(
      '{"should_propose":true,"confidence":-3,"action_title":"x","action_description":"y","action_kind":"follow_up","reasoning":"r"}'
    )
    expect(low.confidence).toBe(0)
  })

  it('normalizes unknown action_kind to "other"', () => {
    const r = parseProactiveOutput(
      '{"should_propose":true,"confidence":0.9,"action_title":"x","action_description":"y","action_kind":"made-up-kind","reasoning":"r"}'
    )
    expect(r.action_kind).toBe('other')
  })

  it('returns safe empty for unparseable input', () => {
    const r = parseProactiveOutput('not json at all')
    expect(r.should_propose).toBe(false)
    expect(r.confidence).toBe(0)
  })
})

describe('ProactiveRunner.findStaleFactGroups', () => {
  it('groups active facts by entity_slug and filters by staleness', () => {
    // Fresh fact — under threshold, should be skipped.
    seedFact({ slug: 'fresh', type: 'waiting_on', statement: 'just now', hoursAgo: 1 })
    // Stale waiting_on — eligible.
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'waiting on Joe', hoursAgo: 50 })
    // Stale but unscanned type — skipped by config filter.
    seedFact({ slug: 'sergey', type: 'role', statement: 'role: dev', hoursAgo: 100 })

    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm: mkLlm(''),
      config: { staleAfterMs: 24 * HOUR },
      now: () => NOW,
    })

    const groups = runner.findStaleFactGroups()
    const slugs = groups.map((g) => g.entitySlug)
    expect(slugs).toContain('joe')
    expect(slugs).not.toContain('fresh')
    expect(slugs).not.toContain('sergey')
  })

  it('sorts groups by staleness desc (oldest first)', () => {
    seedFact({ slug: 'older', type: 'waiting_on', statement: 'a', hoursAgo: 100 })
    seedFact({ slug: 'newer', type: 'waiting_on', statement: 'b', hoursAgo: 30 })

    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm: mkLlm(''),
      now: () => NOW,
    })
    const groups = runner.findStaleFactGroups()
    expect(groups[0]!.entitySlug).toBe('older')
    expect(groups[1]!.entitySlug).toBe('newer')
  })
})

describe('ProactiveRunner.run', () => {
  it('writes proposals for stale groups when LLM says yes', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'waiting on Joe', hoursAgo: 50 })
    const llm = mkLlm(
      JSON.stringify({
        should_propose: true,
        action_title: 'Ping Joe',
        action_description: 'Joe pushed AI changes, nudge for review.',
        action_kind: 'follow_up',
        reasoning: 'Stale 50h, recent push.',
        confidence: 0.82,
      })
    )
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.run()
    expect(r.proposed).toBe(1)
    expect(r.scannedGroups).toBe(1)
    expect(r.decisions[0]!.action).toBe('proposed')
    expect(r.decisions[0]!.proposalId).toBeDefined()

    // Validate the proposal landed in the store with the right shape.
    const proposal = proposalStore.get(r.decisions[0]!.proposalId!)
    expect(proposal).toBeDefined()
    expect(proposal!.sourceAgent).toBe(PROACTIVE_SOURCE_AGENT)
    expect(proposal!.type).toBe('create')
    const payload = proposal!.currentPayload as {
      task: { title: string; tags: string[]; metadata: Record<string, unknown> }
    }
    expect(payload.task.title).toBe('Ping Joe')
    expect(payload.task.tags).toContain('ai-proactive')
    expect(payload.task.tags).toContain('ai-kind:follow_up')
    expect(payload.task.metadata.ai_entity_slug).toBe('joe')
  })

  it('skips when LLM says should_propose=false', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'a', hoursAgo: 50 })
    const llm = mkLlm(
      JSON.stringify({
        should_propose: false,
        action_title: '',
        action_description: '',
        action_kind: 'other',
        reasoning: 'Too soon',
        confidence: 0.3,
      })
    )
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.run()
    expect(r.proposed).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.decisions[0]!.action).toBe('skipped-llm-no')
  })

  it('skips when confidence below threshold', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'a', hoursAgo: 50 })
    const llm = mkLlm(
      JSON.stringify({
        should_propose: true,
        action_title: 'maybe ping',
        action_description: '',
        action_kind: 'follow_up',
        reasoning: '',
        confidence: 0.5,
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      now: () => NOW,
      config: { minConfidence: 0.75 },
    })
    const r = await runner.run()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-low-confidence')
  })

  it('respects maxProposalsPerPass budget', async () => {
    seedFact({ slug: 'a', type: 'waiting_on', statement: 'a', hoursAgo: 50 })
    seedFact({ slug: 'b', type: 'waiting_on', statement: 'b', hoursAgo: 40 })
    seedFact({ slug: 'c', type: 'waiting_on', statement: 'c', hoursAgo: 30 })
    const llm = mkLlm(
      JSON.stringify({
        should_propose: true,
        action_title: 'Ping',
        action_description: '',
        action_kind: 'follow_up',
        reasoning: '',
        confidence: 0.9,
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      now: () => NOW,
      config: { maxProposalsPerPass: 2 },
    })
    const r = await runner.run()
    expect(r.proposed).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.decisions.find((d) => d.action === 'skipped-budget')).toBeDefined()
  })

  it('dedups against recent proactive proposals on same entity', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'a', hoursAgo: 50 })
    // Seed a "recent" proactive proposal for joe in the store.
    proposalStore.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: PROACTIVE_SOURCE_AGENT,
      payload: {
        kind: 'create',
        task: {
          title: 'Earlier ping',
          status: 'inbox',
          tags: [],
          description: '',
          metadata: { ai_entity_slug: 'joe' },
        },
        traceback: { captureExcerpt: '', sourceChannel: 'memory:proactive-runner' },
      },
    })

    const llm = mkLlm('SHOULD NOT BE CALLED FOR JOE')
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      now: () => NOW,
      config: { dedupWindowMs: 48 * HOUR },
    })
    const r = await runner.run()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-recent-proposal')
  })

  it('returns no proposals when no facts are stale', async () => {
    seedFact({ slug: 'fresh', type: 'waiting_on', statement: 'a', hoursAgo: 1 })
    const llm = mkLlm('SHOULD NOT BE CALLED')
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.run()
    expect(r.scannedGroups).toBe(0)
    expect(r.proposed).toBe(0)
  })

  it('passes recent entity events to LLM prompt', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'waiting on Joe', hoursAgo: 50 })
    seedEvent({ slug: 'joe', hoursAgo: 24, body: 'Joe message about AI code review' })

    let capturedPrompt = ''
    const llm = mkLlm((promptUser) => {
      capturedPrompt = promptUser
      return JSON.stringify({
        should_propose: false,
        action_title: '',
        action_description: '',
        action_kind: 'other',
        reasoning: 'noop',
        confidence: 0.4,
      })
    })
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    await runner.run()
    expect(capturedPrompt).toContain('Joe message about AI code review')
    expect(capturedPrompt).toContain('joe')
    expect(capturedPrompt).toContain('Stale: 50h')
  })

  it('records error decision on LLM failure', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'a', hoursAgo: 50 })
    const llm = {
      chatCompletion: async () => {
        throw new Error('LLM boom')
      },
    } as unknown as LLMClient
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.run()
    expect(r.errors).toBe(1)
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('error')
  })
})
