import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'
import { ProposalStore } from '../proposal-store/store'
import { ProactiveRunner, parseProactiveOutput, parseCompletionOutput } from './proactive-runner'
import { PROACTIVE_SOURCE_AGENT } from './proactive-types'
import { HybridRetriever } from './retrieve'
import type { LLMClient } from '../ai/client'
import type { MindwtrClient, Task } from '../api/mindwtr-client'

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
    const r = await runner.runStaleFactsPass()
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
    const r = await runner.runStaleFactsPass()
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
    const r = await runner.runStaleFactsPass()
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
    const r = await runner.runStaleFactsPass()
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
    const r = await runner.runStaleFactsPass()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-recent-proposal')
  })

  it('returns no proposals when no facts are stale', async () => {
    seedFact({ slug: 'fresh', type: 'waiting_on', statement: 'a', hoursAgo: 1 })
    const llm = mkLlm('SHOULD NOT BE CALLED')
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.runStaleFactsPass()
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
    await runner.runStaleFactsPass()
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
    const r = await runner.runStaleFactsPass()
    expect(r.errors).toBe(1)
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('error')
  })
})

// ============================================================================
// Reverse pass (open tasks → completion verdict)
// ============================================================================

function fakeMindwtrClient(tasks: Task[]): MindwtrClient {
  return {
    listTasks: async (params: { status?: string } = {}) => {
      if (!params.status) return tasks
      return tasks.filter((t) => t.status === params.status)
    },
  } as unknown as MindwtrClient
}

function mkTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? 'Some task',
    status: overrides.status ?? 'inbox',
    contexts: overrides.contexts ?? [],
    tags: overrides.tags ?? [],
    description: overrides.description,
    assignedTo: overrides.assignedTo,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 72 * HOUR).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(NOW.getTime() - 72 * HOUR).toISOString(),
  }
}

describe('parseCompletionOutput', () => {
  it('parses a well-formed verdict', () => {
    const r = parseCompletionOutput(
      JSON.stringify({
        verdict: 'completed',
        evidence_quote: 'Sergey uploaded TestFlight build',
        reasoning: 'Build was uploaded yesterday.',
        confidence: 0.9,
      })
    )
    expect(r.verdict).toBe('completed')
    expect(r.evidence_quote).toContain('TestFlight')
    expect(r.confidence).toBe(0.9)
  })

  it('defaults to unclear on bad input', () => {
    expect(parseCompletionOutput('not json').verdict).toBe('unclear')
    expect(parseCompletionOutput('').confidence).toBe(0)
  })

  it('normalizes unknown verdict to unclear', () => {
    const r = parseCompletionOutput(
      JSON.stringify({
        verdict: 'totally-done',
        evidence_quote: '',
        reasoning: 'r',
        confidence: 0.9,
      })
    )
    expect(r.verdict).toBe('unclear')
  })
})

describe('ProactiveRunner.runOpenTasksPass', () => {
  it('proposes modify→done when LLM verdict=completed with high confidence', async () => {
    const task = mkTask({ id: 't1', title: 'Upload TestFlight build', status: 'next' })
    const mindwtrClient = fakeMindwtrClient([task])
    const retriever = new HybridRetriever(memoryStore, null)
    const llm = mkLlm(
      JSON.stringify({
        verdict: 'completed',
        evidence_quote: 'Sergey uploaded build yesterday',
        reasoning: 'Build was uploaded.',
        confidence: 0.9,
      })
    )
    // Seed at least one event so the runner has context (and skips the no-entities branch).
    seedEvent({ slug: 'testflight', hoursAgo: 24, body: 'Sergey uploaded TestFlight build for Valentin' })

    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient,
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(1)
    expect(r.decisions[0]!.action).toBe('proposed-done')
    const proposal = proposalStore.get(r.decisions[0]!.proposalId!)
    expect(proposal).toBeDefined()
    expect(proposal!.type).toBe('modify')
    expect(proposal!.sourceAgent).toBe(PROACTIVE_SOURCE_AGENT)
    expect(proposal!.targetTaskIds).toEqual(['t1'])
    const payload = proposal!.currentPayload as { kind: string; taskId: string; diff: Array<{ field: string; from: string; to: string }> }
    expect(payload.kind).toBe('modify')
    expect(payload.diff[0]!.field).toBe('status')
    expect(payload.diff[0]!.from).toBe('next')
    expect(payload.diff[0]!.to).toBe('done')
  })

  it('proposes modify→someday when verdict=stale', async () => {
    const task = mkTask({ id: 't2', title: 'Stale thing', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    const llm = mkLlm(
      JSON.stringify({
        verdict: 'stale',
        evidence_quote: '',
        reasoning: 'No activity for 3 weeks.',
        confidence: 0.88,
      })
    )
    seedEvent({ slug: 'stale-thing', hoursAgo: 100, body: 'Old discussion about stale thing' })

    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(1)
    expect(r.decisions[0]!.action).toBe('proposed-someday')
    const proposal = proposalStore.get(r.decisions[0]!.proposalId!)!
    const payload = proposal.currentPayload as { diff: Array<{ from: string; to: string }> }
    expect(payload.diff[0]!.to).toBe('someday')
  })

  it('skips when verdict=still_active (do NOT propose)', async () => {
    const task = mkTask({ id: 't3', title: 'Hot ticket', status: 'next' })
    const retriever = new HybridRetriever(memoryStore, null)
    seedEvent({ slug: 'hot-ticket', hoursAgo: 1, body: 'active recent work on hot ticket' })
    const llm = mkLlm(
      JSON.stringify({
        verdict: 'still_active',
        evidence_quote: 'active recent work',
        reasoning: 'Active right now.',
        confidence: 0.9,
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-llm-still-active')
  })

  it('skips on unclear verdict (default safe path)', async () => {
    const task = mkTask({ id: 't4', title: 'Ambiguous situation', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    seedEvent({ slug: 'ambiguous', hoursAgo: 24, body: 'ambiguous situation came up in chat' })
    const llm = mkLlm(
      JSON.stringify({
        verdict: 'unclear',
        evidence_quote: '',
        reasoning: 'Cannot tell.',
        confidence: 0.5,
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-llm-unclear')
  })

  it('skips when confidence below reverseMinConfidence even if verdict=completed', async () => {
    const task = mkTask({ id: 't5', title: 'Maybe done thing', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    seedEvent({ slug: 'maybe-done', hoursAgo: 24, body: 'maybe done thing discussion' })
    const llm = mkLlm(
      JSON.stringify({
        verdict: 'completed',
        evidence_quote: 'maybe',
        reasoning: 'Could be done.',
        confidence: 0.75, // below 0.85 default
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(0)
    expect(r.decisions[0]!.action).toBe('skipped-low-confidence')
  })

  it('skips fresh tasks (age < taskMinAgeMs)', async () => {
    const task = mkTask({
      id: 't6',
      title: 'Fresh task',
      status: 'inbox',
      createdAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
    })
    const retriever = new HybridRetriever(memoryStore, null)
    const llm = mkLlm('SHOULD NOT BE CALLED')
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.decisions[0]!.action).toBe('skipped-too-fresh')
  })

  it('respects reverseMaxProposalsPerPass budget', async () => {
    const tasks = ['alpha', 'beta', 'gamma', 'delta'].map((id) =>
      mkTask({ id, title: `Task ${id} project`, status: 'inbox' })
    )
    const retriever = new HybridRetriever(memoryStore, null)
    for (const t of tasks)
      seedEvent({ slug: t.id, hoursAgo: 24, body: `Closed ${t.id} project finally` })

    const llm = mkLlm(
      JSON.stringify({
        verdict: 'completed',
        evidence_quote: 'closed',
        reasoning: 'done',
        confidence: 0.9,
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient(tasks),
      retriever,
      now: () => NOW,
      config: { reverseMaxProposalsPerPass: 2 },
    })
    const r = await runner.runOpenTasksPass()
    expect(r.proposed).toBe(2)
    expect(r.decisions.filter((d) => d.action === 'skipped-budget').length).toBe(2)
  })

  it('dedups against pending proactive proposal on same task', async () => {
    const task = mkTask({ id: 't7', title: 'Dedup task', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    seedEvent({ slug: 'dedup-task', hoursAgo: 24, body: 'done' })

    // Pre-seed pending proactive proposal on this task.
    proposalStore.create({
      type: 'modify',
      targetTaskIds: ['t7'],
      sourceAgent: PROACTIVE_SOURCE_AGENT,
      payload: { kind: 'modify', taskId: 't7', diff: [{ field: 'status', from: 'inbox', to: 'done' }] },
    })

    const llm = mkLlm('SHOULD NOT BE CALLED')
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.decisions[0]!.action).toBe('skipped-already-pending')
  })

  it('skips tasks with no related events/facts', async () => {
    const task = mkTask({ id: 't8', title: 'Lonely task', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    const llm = mkLlm('SHOULD NOT BE CALLED')
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.runOpenTasksPass()
    expect(r.decisions[0]!.action).toBe('skipped-no-entities')
  })

  it('combined run() returns both forward and reverse results', async () => {
    seedFact({ slug: 'joe', type: 'waiting_on', statement: 'waiting on Joe', hoursAgo: 50 })
    const task = mkTask({ id: 't9', title: 'Joe related task', status: 'inbox' })
    const retriever = new HybridRetriever(memoryStore, null)
    const llm = mkLlm(
      JSON.stringify({
        // Same response for both prompts — neither produces a proposal.
        should_propose: false,
        action_title: '',
        action_description: '',
        action_kind: 'other',
        reasoning: 'too soon',
        confidence: 0.3,
        verdict: 'unclear',
        evidence_quote: '',
      })
    )
    const runner = new ProactiveRunner({
      memoryStore,
      proposalStore,
      llm,
      mindwtrClient: fakeMindwtrClient([task]),
      retriever,
      now: () => NOW,
    })
    const r = await runner.run()
    expect(r.forward).toBeDefined()
    expect(r.reverse).toBeDefined()
    expect(r.forward.scannedGroups).toBe(1)
    expect(r.reverse!.scannedTasks).toBe(1)
  })

  it('reverse pass is null when mindwtrClient/retriever missing', async () => {
    const llm = mkLlm('never called')
    const runner = new ProactiveRunner({ memoryStore, proposalStore, llm, now: () => NOW })
    const r = await runner.run()
    expect(r.reverse).toBeNull()
  })
})
