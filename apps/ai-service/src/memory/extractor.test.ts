import { describe, it, expect } from 'bun:test'
import { parseExtractorOutput, UnifiedExtractor } from './extractor'
import type { LLMClient } from '../ai/client'

function makeFakeLlm(responseContent: string): LLMClient {
  return {
    chatCompletion: async () => ({
      choices: [{ message: { role: 'assistant', content: responseContent }, finish_reason: 'stop' }],
    }),
  } as unknown as LLMClient
}

describe('parseExtractorOutput', () => {
  it('parses a valid response', () => {
    const r = parseExtractorOutput(
      JSON.stringify({
        entities: [
          { slug: 'gtd-automation', name: 'GTD Automation', type: 'project', excerpt: 'opening the repo' },
        ],
        facts: [
          {
            statement: 'Sergey is working on the memory module',
            entity_slug: 'gtd-automation',
            fact_type: 'working_on',
            confidence: 0.9,
            supersedes_previous: true,
          },
        ],
      })
    )
    expect(r.entities).toHaveLength(1)
    expect(r.entities[0]!.slug).toBe('gtd-automation')
    expect(r.facts).toHaveLength(1)
    expect(r.facts[0]!.supersedes_previous).toBe(true)
  })

  it('strips ```json fences', () => {
    const r = parseExtractorOutput('```json\n{"entities":[],"facts":[]}\n```')
    expect(r.entities).toHaveLength(0)
    expect(r.facts).toHaveLength(0)
  })

  it('returns empty on invalid JSON', () => {
    expect(parseExtractorOutput('not json')).toEqual({ entities: [], facts: [] })
  })

  it('drops entities missing slug or name', () => {
    const r = parseExtractorOutput(
      JSON.stringify({ entities: [{ slug: '', name: 'X' }, { slug: 'y', name: '' }, { slug: 'z', name: 'Z', type: 'topic' }], facts: [] })
    )
    expect(r.entities.map((e) => e.slug)).toEqual(['z'])
  })

  it('drops facts that reference a slug not in entities[] (extractor sanity)', () => {
    // parseExtractorOutput itself doesn't enforce this — IngestService does.
    // But the function should still pass through what came in.
    const r = parseExtractorOutput(
      JSON.stringify({
        entities: [{ slug: 'a', name: 'A', type: 'topic' }],
        facts: [
          { statement: 'a fact', entity_slug: 'a', fact_type: 'other' },
          { statement: 'orphan', entity_slug: 'nope', fact_type: 'other' },
        ],
      })
    )
    // both should parse — filtering is the caller's job.
    expect(r.facts).toHaveLength(2)
  })

  it('normalizes slugs (lowercase, kebab)', () => {
    const r = parseExtractorOutput(
      JSON.stringify({ entities: [{ slug: 'GTD Automation', name: 'GTD', type: 'project' }], facts: [] })
    )
    expect(r.entities[0]!.slug).toBe('gtd-automation')
  })

  it('clamps confidence to [0, 1]', () => {
    const r = parseExtractorOutput(
      JSON.stringify({
        entities: [{ slug: 'a', name: 'A', type: 'topic' }],
        facts: [
          { statement: 's1', entity_slug: 'a', fact_type: 'other', confidence: 5 },
          { statement: 's2', entity_slug: 'a', fact_type: 'other', confidence: -3 },
        ],
      })
    )
    expect(r.facts[0]!.confidence).toBe(1)
    expect(r.facts[1]!.confidence).toBe(0)
  })
})

describe('UnifiedExtractor.extract', () => {
  it('returns parsed output from LLM', async () => {
    const llm = makeFakeLlm(
      JSON.stringify({
        entities: [{ slug: 'polina', name: 'Polina', type: 'person', excerpt: 'mentions polina' }],
        facts: [
          { statement: 'Polina works at Eazdrop', entity_slug: 'polina', fact_type: 'role', confidence: 0.8 },
        ],
      })
    )
    const x = new UnifiedExtractor(llm)
    const out = await x.extract({
      app: 'Slack',
      title: 'DM with Polina',
      source: 'screen',
      body: 'Hello Polina, about Eazdrop dashboard...',
    })
    expect(out.entities[0]!.slug).toBe('polina')
    expect(out.facts[0]!.statement).toContain('Eazdrop')
  })
})
