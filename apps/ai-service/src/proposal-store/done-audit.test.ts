import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../context-store/db'
import type { ContextStore } from '../context-store/store'
import type { LLMClient } from '../ai/client'
import { ProposalStore } from './store'
import { DONE_FLAG_PREFIX } from './types'
import { DoneSweeper, judgeProposalDone } from './done-audit'

let dir: string
let db: DB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-done-audit-'))
  db = openDb(join(dir, 'test.db')).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function createCard(store: ProposalStore, title: string) {
  return store.create({
    type: 'create',
    targetTaskIds: [],
    sourceAgent: 'commitment-detector',
    payload: { kind: 'create', task: { title, metadata: {} } },
  })
}

/** ContextStore stub: every retrieve() returns one capture stamped `capturedAt`. */
function fakeContextStore(capturedAt: string): ContextStore {
  return {
    retrieve: async () => [
      {
        capture: {
          capturedAt,
          sourceChannel: 'slack_dm',
          text: 'отправил, готово',
        },
      },
    ],
  } as unknown as ContextStore
}

function fakeLlm(verdict: string, confidence: number): LLMClient {
  return {
    chatCompletion: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                function: {
                  name: 'judge_completion',
                  arguments: JSON.stringify({
                    verdict,
                    confidence,
                    evidence_quote: 'отправил, готово',
                    reasoning: 'past-tense completion about this action',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  } as unknown as LLMClient
}

async function awaitSweep(sweeper: DoneSweeper): Promise<void> {
  for (let i = 0; i < 200 && sweeper.status().running; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(sweeper.status().running).toBe(false)
}

const FUTURE = '2999-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

describe('judgeProposalDone', () => {
  it('returns no-evidence when all matching captures predate the card', async () => {
    const store = new ProposalStore(db)
    const card = createCard(store, 'Reply to Katja')
    const verdict = await judgeProposalDone(
      { contextStore: fakeContextStore(PAST), llm: fakeLlm('done', 0.9) },
      card
    )
    expect(verdict?.verdict).toBe('no-evidence')
  })

  it('maps an unknown verdict string to unclear', async () => {
    const store = new ProposalStore(db)
    const card = createCard(store, 'Reply to Katja')
    const verdict = await judgeProposalDone(
      { contextStore: fakeContextStore(FUTURE), llm: fakeLlm('nonsense', 0.9) },
      card
    )
    expect(verdict?.verdict).toBe('unclear')
    expect(verdict?.confidence).toBe(0.9)
  })
})

describe('DoneSweeper', () => {
  it('flags done-verdict cards with the 🟡 nudge and counts them', async () => {
    const store = new ProposalStore(db)
    const card = createCard(store, 'Pay overdue invoice')
    const sweeper = new DoneSweeper({
      store,
      contextStore: fakeContextStore(FUTURE),
      llm: fakeLlm('done', 0.9),
    })

    const kick = sweeper.start()
    expect(kick.started).toBe(true)
    expect(kick.total).toBe(1)
    await awaitSweep(sweeper)

    const status = sweeper.status()
    expect(status.done).toBe(1)
    expect(status.flagged).toBe(1)
    const detail = store.getDetail(card.id)!
    const lastAgent = [...detail.messages].reverse().find((m) => m.role === 'agent')
    expect(lastAgent?.text.startsWith(DONE_FLAG_PREFIX)).toBe(true)
    expect(detail.audit.some((a) => a.eventMeta?.kind === 'done-sweep')).toBe(true)

    // Second sweep: same verdict, but the card is already flagged — no new
    // message, so repeat runs don't spam the thread / reset the expiry clock.
    sweeper.start()
    await awaitSweep(sweeper)
    expect(sweeper.status().flagged).toBe(0)
    expect(
      store.getDetail(card.id)!.messages.filter((m) => m.text.startsWith(DONE_FLAG_PREFIX))
    ).toHaveLength(1)
  })

  it('does not flag below the confidence floor or on unclear verdicts', async () => {
    const store = new ProposalStore(db)
    const lowConf = createCard(store, 'Low-confidence card')
    const sweeper = new DoneSweeper(
      { store, contextStore: fakeContextStore(FUTURE), llm: fakeLlm('done', 0.3) },
      { minConfidence: 0.5 }
    )
    sweeper.start()
    await awaitSweep(sweeper)
    expect(sweeper.status().done).toBe(1)
    expect(sweeper.status().flagged).toBe(0)
    expect(store.getDetail(lowConf.id)!.messages).toHaveLength(0)

    const unclearSweeper = new DoneSweeper({
      store,
      contextStore: fakeContextStore(FUTURE),
      llm: fakeLlm('unclear', 0.9),
    })
    unclearSweeper.start()
    await awaitSweep(unclearSweeper)
    expect(unclearSweeper.status().unclear).toBe(1)
    expect(unclearSweeper.status().flagged).toBe(0)
  })

  it('refuses to start a second sweep while one is running', async () => {
    const store = new ProposalStore(db)
    createCard(store, 'Slow card')
    const slowLlm = {
      chatCompletion: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return fakeLlm('done', 0.9).chatCompletion({ messages: [] })
      },
    } as unknown as LLMClient
    const sweeper = new DoneSweeper({ store, contextStore: fakeContextStore(FUTURE), llm: slowLlm })
    expect(sweeper.start().started).toBe(true)
    expect(sweeper.start().started).toBe(false)
    await awaitSweep(sweeper)
  })

  it('keeps sweeping past a card whose judge call throws', async () => {
    const store = new ProposalStore(db)
    createCard(store, 'Card A')
    createCard(store, 'Card B')
    let calls = 0
    const flakyLlm = {
      chatCompletion: async () => {
        calls++
        if (calls === 1) throw new Error('LLM request failed: 429')
        return fakeLlm('done', 0.9).chatCompletion({ messages: [] })
      },
    } as unknown as LLMClient
    const sweeper = new DoneSweeper({ store, contextStore: fakeContextStore(FUTURE), llm: flakyLlm })
    sweeper.start()
    await awaitSweep(sweeper)
    const status = sweeper.status()
    expect(status.processed).toBe(2)
    expect(status.done).toBe(1)
    expect(status.error).toContain('429')
  })
})
