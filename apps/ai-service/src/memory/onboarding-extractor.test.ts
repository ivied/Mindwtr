import { describe, it, expect, mock } from 'bun:test'
import { OnboardingExtractor, parseCandidates } from './onboarding-extractor'
import type { LLMClient } from '../ai/client'

function mockLLM(content: string): LLMClient {
  return {
    chatCompletion: mock(async () => ({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    })),
  } as unknown as LLMClient
}

describe('parseCandidates', () => {
  it('parses well-formed candidates and slugifies terms', () => {
    const raw = JSON.stringify({
      candidates: [
        { term: 'Phoenix', kind: 'project', expansion: 'DB migration', grade: 'high', confidence: 0.9, evidence: 'task 3' },
        { term: 'СБП', kind: 'term', expansion: '', grade: 'needs_input', confidence: 0.4, evidence: 'task 7' },
      ],
    })
    const out = parseCandidates(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ slug: 'phoenix', term: 'Phoenix', kind: 'project', grade: 'high', expansion: 'DB migration' })
    expect(out[1]!.slug).toBe('сбп')
    expect(out[1]!.term).toBe('СБП')
    expect(out[1]!.grade).toBe('needs_input')
  })

  it('strips inferred expansion for needs_input candidates', () => {
    const raw = JSON.stringify({
      candidates: [{ term: 'Bluebird', kind: 'project', expansion: 'a guess', grade: 'needs_input', confidence: 0.5 }],
    })
    const out = parseCandidates(raw)
    expect(out[0]!.expansion).toBe('')
  })

  it('defaults invalid kind to term and dedupes by slug', () => {
    const raw = JSON.stringify({
      candidates: [
        { term: 'QBR', kind: 'nonsense', grade: 'high' },
        { term: 'qbr', kind: 'term', grade: 'high' },
      ],
    })
    const out = parseCandidates(raw)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('term')
  })

  it('handles fenced JSON and junk gracefully', () => {
    expect(parseCandidates('```json\n{"candidates":[]}\n```')).toEqual([])
    expect(parseCandidates('not json')).toEqual([])
    expect(parseCandidates('')).toEqual([])
  })
})

describe('OnboardingExtractor.collect', () => {
  it('returns [] without calling LLM when no usable tasks', async () => {
    const llm = mockLLM('{"candidates":[]}')
    const ext = new OnboardingExtractor(llm)
    const out = await ext.collect([{ title: '' }, { title: '   ' }])
    expect(out).toEqual([])
    expect((llm.chatCompletion as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('passes task titles to the LLM and parses candidates', async () => {
    const llm = mockLLM(JSON.stringify({ candidates: [{ term: 'Phoenix', kind: 'project', grade: 'high', expansion: 'X', confidence: 0.9 }] }))
    const ext = new OnboardingExtractor(llm)
    const out = await ext.collect([{ title: 'Finish Phoenix migration', description: 'move DB' }])
    expect(out.map((c) => c.slug)).toEqual(['phoenix'])
    const call = (llm.chatCompletion as unknown as { mock: { calls: Array<Array<{ messages: Array<{ role: string; content: string }> }>> } }).mock.calls[0][0]
    const userMsg = call.messages.find((m) => m.role === 'user')!.content
    expect(userMsg).toContain('Finish Phoenix migration')
  })

  it('drops well-known public acronyms and generic domain terms', async () => {
    const llm = mockLLM(
      JSON.stringify({
        candidates: [
          { term: 'Idyoma', kind: 'project', grade: 'high', expansion: 'internal app', confidence: 0.9 },
          { term: 'API', kind: 'technology', grade: 'high', expansion: 'application programming interface', confidence: 0.99 },
          { term: 'CustDev', kind: 'term', grade: 'high', expansion: 'customer development', confidence: 0.95 },
          { term: 'GTD', kind: 'term', grade: 'high', expansion: 'getting things done', confidence: 0.98 },
        ],
      })
    )
    const ext = new OnboardingExtractor(llm)
    const out = await ext.collect([{ title: 'Ship Idyoma; review API; do CustDev; org GTD' }])
    expect(out.map((c) => c.slug)).toEqual(['idyoma'])
  })

  it('drops low-confidence candidates below the gate', async () => {
    const llm = mockLLM(
      JSON.stringify({
        candidates: [
          { term: 'Mercury', kind: 'project', grade: 'high', expansion: 'a project', confidence: 0.9 },
          { term: 'Maybe', kind: 'project', grade: 'high', expansion: 'unsure', confidence: 0.4 },
        ],
      })
    )
    const ext = new OnboardingExtractor(llm)
    const out = await ext.collect([{ title: 'Mercury and Maybe' }])
    expect(out.map((c) => c.slug)).toEqual(['mercury'])
  })

  it('batches a large inbox and merges candidates across batches', async () => {
    // 250 tasks → 3 batches (120/120/10). Different response per call.
    const responses = [
      JSON.stringify({ candidates: [{ term: 'Alpha', kind: 'project', grade: 'high', expansion: 'a', confidence: 0.8 }] }),
      JSON.stringify({ candidates: [{ term: 'Beta', kind: 'project', grade: 'high', expansion: 'b', confidence: 0.8 }] }),
      JSON.stringify({ candidates: [{ term: 'Gamma', kind: 'project', grade: 'high', expansion: 'g', confidence: 0.8 }] }),
    ]
    let i = 0
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [{ message: { role: 'assistant', content: responses[i++] ?? '{"candidates":[]}' }, finish_reason: 'stop' }],
      })),
    } as unknown as LLMClient
    const ext = new OnboardingExtractor(llm)
    const tasks = Array.from({ length: 250 }, (_, n) => ({ title: `task ${n}` }))
    const out = await ext.collect(tasks)
    expect((llm.chatCompletion as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3)
    expect(out.map((c) => c.slug).sort()).toEqual(['alpha', 'beta', 'gamma'])
  })
})
