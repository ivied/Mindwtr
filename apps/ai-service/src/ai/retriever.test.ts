import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextRetriever, extractKeywords } from './retriever'
import { ContextStore } from '../context-store/store'

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

  it('handles cyrillic', () => {
    const out = extractKeywords('позвонить няне на субботу про детей')
    expect(out).toContain('позвонить')
    expect(out).toContain('няне')
  })
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-r-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ContextRetriever', () => {
  it('returns empty string when text is shorter than minQueryLength', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })
    const r = new ContextRetriever(store)
    expect(await r.retrieve('hi')).toBe('')
    store.close()
  })

  it('queries store and formats hits', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })
    await store.insert({
      text: 'позвонить няне в субботу',
      sourceChannel: 'telegram_dm',
      type: 'text',
      timestamp: '2026-04-24T09:00:00Z',
      sourceMeta: { from: 'sergey' },
    })
    const r = new ContextRetriever(store)
    const result = await r.retrieve('позвонить няне завтра')
    expect(result).toContain('Past relevant context:')
    expect(result).toContain('позвонить няне в субботу')
    expect(result).toContain('telegram_dm')
    store.close()
  })

  it('returns empty when store has no relevant captures', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })
    await store.insert({
      text: 'купить хлеб в магазине',
      sourceChannel: 'telegram_dm',
      type: 'text',
      timestamp: '2026-04-24T09:00:00Z',
    })
    const r = new ContextRetriever(store)
    const result = await r.retrieve('xyzunrelated quantum mechanics')
    expect(result).toBe('')
    store.close()
  })

  it('survives store retrieval errors', async () => {
    const broken = {
      retrieve: async () => {
        throw new Error('boom')
      },
      hasVectorSearch: false,
    } as unknown as ContextStore
    const r = new ContextRetriever(broken)
    expect(await r.retrieve('test query that is long enough')).toBe('')
  })
})
