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
    const llm = mockLLM(JSON.stringify({ candidates: [{ term: 'Phoenix', kind: 'project', grade: 'high', expansion: 'X' }] }))
    const ext = new OnboardingExtractor(llm)
    const out = await ext.collect([{ title: 'Finish Phoenix migration', description: 'move DB' }])
    expect(out.map((c) => c.slug)).toEqual(['phoenix'])
    const call = (llm.chatCompletion as unknown as { mock: { calls: Array<Array<{ messages: Array<{ role: string; content: string }> }>> } }).mock.calls[0][0]
    const userMsg = call.messages.find((m) => m.role === 'user')!.content
    expect(userMsg).toContain('Finish Phoenix migration')
  })
})
