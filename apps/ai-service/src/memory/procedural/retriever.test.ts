import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../context-store/db'
import { ProceduralStore } from './store'
import { ProceduralRetriever } from './retriever'

let dataDir: string
let store: ProceduralStore
let dbHandle: ReturnType<typeof openDb>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gtd-proc-ret-'))
  dbHandle = openDb(join(dataDir, 'test.db'))
  store = new ProceduralStore({ db: dbHandle.db, vecAvailable: dbHandle.vecAvailable })
})

afterEach(() => {
  dbHandle.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seed(rows: Array<{ path: string; index: number; section: string; text: string }>) {
  for (const r of rows) {
    store.upsert({
      source: 'openclaw',
      path: r.path,
      sectionIndex: r.index,
      sectionTitle: r.section,
      text: r.text,
      fileMtime: Date.now(),
      // Test seeds default to 'universal' so the retriever's visibility
      // filter (DEFAULT_APPLIES_FILTER) lets them through; the actual
      // applies_to-aware retrieval is exercised in classifier.test.ts.
      appliesTo: 'universal',
      classifiedBy: 'heuristic',
    })
  }
}

describe('ProceduralRetriever (FTS-only fallback)', () => {
  it('returns chunks ranked by FTS BM25 when a term matches', async () => {
    seed([
      { path: 'MEMORY.md', index: 0, section: '## Slack', text: 'reply_to_current для тред answer' },
      { path: 'MEMORY.md', index: 1, section: '## Notion', text: 'каждую задачу — сразу в Notion' },
      { path: 'MEMORY.md', index: 2, section: '## Telegram', text: 'cron утренний апдейт через telegram' },
    ])
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'telegram cron' })
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]!.sectionTitle).toBe('## Telegram')
  })

  it('respects the source filter', async () => {
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 0,
      sectionTitle: '## Slack',
      text: 'reply_to_current для тред answer',
      fileMtime: Date.now(),
      appliesTo: 'universal',
      classifiedBy: 'heuristic',
    })
    store.upsert({
      source: 'notion',
      path: 'task-1.md',
      sectionIndex: 0,
      sectionTitle: '## Done Criteria',
      text: 'reply_to_current для тред answer',
      fileMtime: Date.now(),
      appliesTo: 'universal',
      classifiedBy: 'heuristic',
    })
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'reply_to_current', source: 'notion' })
    expect(out.length).toBe(1)
    expect(out[0]!.source).toBe('notion')
  })

  it('returns [] for empty query', async () => {
    seed([{ path: 'MEMORY.md', index: 0, section: '## A', text: 'something with enough length' }])
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: '   ' })
    expect(out).toEqual([])
  })

  it('hides chunks classified openclaw-only by default', async () => {
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 0,
      sectionTitle: '## Slack',
      text: 'reply_to_current secret token rule',
      fileMtime: Date.now(),
      appliesTo: 'openclaw-only',
      classifiedBy: 'heuristic',
    })
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 1,
      sectionTitle: '## Notion',
      text: 'каждую задачу — сразу в Notion правило',
      fileMtime: Date.now(),
      appliesTo: 'universal',
      classifiedBy: 'heuristic',
    })
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'правило' })
    expect(out.length).toBe(1)
    expect(out[0]!.appliesTo).toBe('universal')
  })

  it('hides chunks marked needs-review by default', async () => {
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 0,
      sectionTitle: '## Notion',
      text: 'каждую задачу — сразу в Notion правило',
      fileMtime: Date.now(),
      // No appliesTo specified → defaults to 'needs-review'.
    })
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'правило' })
    expect(out.length).toBe(0)
  })

  it('explicit applies override surfaces hidden chunks', async () => {
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 0,
      sectionTitle: '## Slack',
      text: 'openclaw-runtime rule about reply_to_current',
      fileMtime: Date.now(),
      appliesTo: 'openclaw-only',
      classifiedBy: 'heuristic',
    })
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'openclaw runtime', applies: ['openclaw-only'] })
    expect(out.length).toBe(1)
  })

  it('respects the limit option', async () => {
    seed([
      { path: 'MEMORY.md', index: 0, section: '## A', text: 'reply word target answer' },
      { path: 'MEMORY.md', index: 1, section: '## B', text: 'reply also matches here' },
      { path: 'MEMORY.md', index: 2, section: '## C', text: 'reply third time present' },
    ])
    const retriever = new ProceduralRetriever(store, null)
    const out = await retriever.retrieve({ query: 'reply', limit: 2 })
    expect(out.length).toBe(2)
  })
})
