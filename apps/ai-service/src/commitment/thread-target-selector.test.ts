import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { LLMClient } from '../ai/client'
import type { RegistryThread } from '../threads/registry-scan'

// Mock the registry module so the selector sees a controlled thread list and
// a deterministic fallback. Must be registered before importing the selector.
const threadsRef: { current: RegistryThread[] } = { current: [] }
let fallbackTag = 'ai-target:openclaw'

mock.module('../threads/registry', () => ({
  getThreadRegistry: () => threadsRef.current,
  pickRoutingTargetTag: () => fallbackTag,
}))

const { ThreadTargetSelector } = await import('./thread-target-selector')

function thread(over: Partial<RegistryThread> = {}): RegistryThread {
  return {
    sessionId: 'sess-1',
    alias: 'Fix auto-apply phantom proposals',
    repo: 'UpworkApI',
    repoLabel: 'Upwork API',
    lastTouched: '2026-06-12',
    summary: 'work on the upwork auto-apply detector',
    ...over,
  }
}

function llmReturning(args: Record<string, unknown>): LLMClient {
  return {
    chatCompletion: mock(async () => ({
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'select_run_target', arguments: JSON.stringify(args) } }],
          },
        },
      ],
    })),
  } as unknown as LLMClient
}

describe('ThreadTargetSelector', () => {
  beforeEach(() => {
    threadsRef.current = [thread()]
    fallbackTag = 'ai-target:openclaw'
  })

  it('returns the chosen existing thread when it is in the candidate list', async () => {
    const llm = llmReturning({
      choice: 'existing_thread',
      session_id: 'sess-1',
      repo: '',
      confidence: 0.9,
      reasoning: 'matches upwork repo',
    })
    const sel = new ThreadTargetSelector(llm)
    const tag = await sel.selectTargetTag({ title: 'Откликнуться на инвайт', targetHint: 'Upwork Monitor' })
    expect(tag).toBe('ai-target:mac:sess-1')
  })

  it('returns mac-new for a valid repo choice', async () => {
    const llm = llmReturning({
      choice: 'new_thread_in_repo',
      session_id: '',
      repo: 'UpworkApI',
      confidence: 0.8,
      reasoning: 'right repo, no fitting thread',
    })
    const sel = new ThreadTargetSelector(llm)
    const tag = await sel.selectTargetTag({ title: 'New upwork task' })
    expect(tag).toBe('ai-target:mac-new:UpworkApI')
  })

  it('returns openclaw when the model chooses it', async () => {
    const llm = llmReturning({
      choice: 'openclaw', session_id: '', repo: '', confidence: 0.9, reasoning: 'generic',
    })
    const sel = new ThreadTargetSelector(llm)
    expect(await sel.selectTargetTag({ title: 'Research best CRM' })).toBe('ai-target:openclaw')
  })

  it('falls back to the deterministic matcher on low confidence', async () => {
    fallbackTag = 'ai-target:mac:sess-1'
    const llm = llmReturning({
      choice: 'existing_thread', session_id: 'sess-1', repo: '', confidence: 0.3, reasoning: 'unsure',
    })
    const sel = new ThreadTargetSelector(llm)
    expect(await sel.selectTargetTag({ title: 'Maybe upwork' })).toBe('ai-target:mac:sess-1')
  })

  it('ignores a hallucinated session_id not in the candidate list', async () => {
    fallbackTag = 'ai-target:openclaw'
    const llm = llmReturning({
      choice: 'existing_thread', session_id: 'ghost-999', repo: '', confidence: 0.95, reasoning: 'made up',
    })
    const sel = new ThreadTargetSelector(llm)
    expect(await sel.selectTargetTag({ title: 'X' })).toBe('ai-target:openclaw')
  })

  it('falls back when the LLM call throws', async () => {
    fallbackTag = 'ai-target:openclaw'
    const llm = {
      chatCompletion: mock(async () => {
        throw new Error('LLM down')
      }),
    } as unknown as LLMClient
    const sel = new ThreadTargetSelector(llm)
    expect(await sel.selectTargetTag({ title: 'X' })).toBe('ai-target:openclaw')
  })

  it('uses the fallback (openclaw) when there are no candidate threads', async () => {
    threadsRef.current = []
    fallbackTag = 'ai-target:openclaw'
    const llm = llmReturning({ choice: 'openclaw', session_id: '', repo: '', confidence: 1, reasoning: '' })
    const sel = new ThreadTargetSelector(llm)
    expect(await sel.selectTargetTag({ title: 'X' })).toBe('ai-target:openclaw')
    // No threads → no LLM call needed.
    expect((llm.chatCompletion as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })
})
