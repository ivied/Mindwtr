import { describe, it, expect, mock } from 'bun:test'
import { ContextRetriever, extractKeywords, DEFAULT_RETRIEVER_CONFIG } from './retriever'
import type { MindwtrClient } from '../api/mindwtr-client'

describe('extractKeywords', () => {
  it('lowercases and dedupes tokens', () => {
    expect(extractKeywords('Buy MILK and Bread, buy more bread')).toEqual([
      'milk',
      'bread',
      'more',
    ])
  })

  it('drops short tokens and stopwords', () => {
    expect(extractKeywords('the quick brown fox over a lazy dog')).toEqual([
      'quick',
      'brown',
      'over',
      'lazy',
    ])
  })

  it('strips punctuation and URLs but keeps hostname pieces above min length', () => {
    expect(extractKeywords('Email alice@example.com about Q4 plan')).toEqual([
      'email',
      'alice',
      'example',
      'plan',
    ])
  })

  it('handles cyrillic', () => {
    const out = extractKeywords('позвонить няне на субботу про детей')
    expect(out).toContain('позвонить')
    expect(out).toContain('няне')
    expect(out).toContain('субботу')
    expect(out).toContain('детей')
  })

  it('respects custom minKeywordLength', () => {
    const out = extractKeywords('a bb ccc dddd', { ...DEFAULT_RETRIEVER_CONFIG, minKeywordLength: 3 })
    expect(out).toEqual(['ccc', 'dddd'])
  })
})

describe('ContextRetriever', () => {
  it('returns empty string when not enough keywords', async () => {
    const mindwtr = { search: mock() } as unknown as MindwtrClient
    const r = new ContextRetriever(mindwtr, {
      topK: 5,
      minKeywordLength: 4,
      minKeywords: 5,
    })
    const result = await r.retrieve('hi')
    expect(result).toBe('')
    expect(mindwtr.search).not.toHaveBeenCalled()
  })

  it('queries mindwtr with extracted keywords and formats top-K', async () => {
    const search = mock(async () => ({
      tasks: [
        { id: '1', title: 'Buy milk', status: 'next', contexts: ['@errands'], tags: ['shopping'] },
        { id: '2', title: 'Buy bread', status: 'inbox', contexts: [], tags: [] },
      ],
      projects: [],
    }))
    const mindwtr = { search } as unknown as MindwtrClient
    const r = new ContextRetriever(mindwtr, { topK: 5, minKeywordLength: 4, minKeywords: 1 })
    const result = await r.retrieve('Buy milk and bread today')

    expect(search).toHaveBeenCalledTimes(1)
    const calls = (search as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls[0][0]).toContain('milk')
    expect(calls[0][0]).toContain('bread')
    expect(result).toContain('Past similar items:')
    expect(result).toContain('(next) @errands [shopping] Buy milk')
    expect(result).toContain('(inbox) Buy bread')
  })

  it('limits results to topK', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      title: `Task ${i}`,
      status: 'next',
      contexts: [],
      tags: [],
    }))
    const mindwtr = {
      search: mock(async () => ({ tasks, projects: [] })),
    } as unknown as MindwtrClient
    const r = new ContextRetriever(mindwtr, { topK: 3, minKeywordLength: 4, minKeywords: 1 })
    const result = await r.retrieve('something interesting longer than four chars')
    const lines = result.split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBe(3)
  })

  it('returns empty string on search error', async () => {
    const mindwtr = {
      search: mock(async () => {
        throw new Error('boom')
      }),
    } as unknown as MindwtrClient
    const r = new ContextRetriever(mindwtr)
    expect(await r.retrieve('something interesting')).toBe('')
  })

  it('returns empty string on empty result', async () => {
    const mindwtr = {
      search: mock(async () => ({ tasks: [], projects: [] })),
    } as unknown as MindwtrClient
    const r = new ContextRetriever(mindwtr)
    expect(await r.retrieve('something interesting')).toBe('')
  })
})
