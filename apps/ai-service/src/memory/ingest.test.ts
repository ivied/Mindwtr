import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'
import { IngestService, parseCaptureMd } from './ingest'
import { UnifiedExtractor } from './extractor'
import type { LLMClient } from '../ai/client'

function fakeLlm(content: string): LLMClient {
  return {
    chatCompletion: async () => ({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
  } as unknown as LLMClient
}

let dbPath: string
let workDir: string
let store: MemoryStore

beforeEach(() => {
  workDir = join(tmpdir(), `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(workDir, { recursive: true })
  dbPath = join(workDir, 'mem.db')
  const { db, vecAvailable } = openDb(dbPath)
  store = new MemoryStore({ db, vecAvailable })
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
  if (existsSync(workDir)) {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {}
  }
})

describe('parseCaptureMd', () => {
  it('parses a typical capture .md', () => {
    const md = [
      '---',
      'id: dd9f51a8-8e23-42f7-becb-5ba9d5d731b8',
      'ts: 2026-05-11T12:52:58.770Z',
      'source: screen',
      'app: "Google Chrome"',
      'title: "Some Page"',
      'url: "https://example.com"',
      'image: "x.png"',
      'display_index: 0',
      'sent_to_inbox: true',
      '---',
      '',
      'Body text here.',
    ].join('\n')
    const p = parseCaptureMd(md)!
    expect(p.id).toBe('dd9f51a8-8e23-42f7-becb-5ba9d5d731b8')
    expect(p.ts).toBe('2026-05-11T12:52:58.770Z')
    expect(p.source).toBe('screen')
    expect(p.app).toBe('Google Chrome')
    expect(p.title).toBe('Some Page')
    expect(p.url).toBe('https://example.com')
    expect(p.body).toBe('Body text here.')
    expect(p.meta.display_index).toBe(0)
    expect(p.meta.sent_to_inbox).toBe(true)
  })

  it('returns null on missing frontmatter', () => {
    expect(parseCaptureMd('# just markdown\n\nno frontmatter')).toBeNull()
  })

  it('returns null on missing required fields', () => {
    expect(parseCaptureMd('---\nfoo: bar\n---\nbody')).toBeNull()
  })
})

describe('IngestService.live', () => {
  it('inserts the event and runs extractor', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        entities: [{ slug: 'eazdrop', name: 'Eazdrop', type: 'project', excerpt: 'ok' }],
        facts: [{ statement: 'works on Eazdrop', entity_slug: 'eazdrop', fact_type: 'working_on' }],
      })
    )
    const ingest = new IngestService({
      store,
      embeddings: null,
      extractor: new UnifiedExtractor(llm),
    })
    const r = await ingest.live({
      id: 'evt-1',
      ts: '2026-05-11T12:00:00.000Z',
      source: 'screen',
      app: 'Slack',
      title: 'DM',
      body: 'Eazdrop dashboard call',
    })
    expect(r.inserted).toBe(true)
    expect(r.extraction!.entities[0]!.slug).toBe('eazdrop')
    expect(r.factIdsInserted).toHaveLength(1)
    expect(store.activeFactsFor('eazdrop')).toHaveLength(1)
  })

  it('skips facts referencing a slug not in entities[]', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        entities: [{ slug: 'a', name: 'A', type: 'topic' }],
        facts: [
          { statement: 'about a', entity_slug: 'a', fact_type: 'other' },
          { statement: 'about ghost', entity_slug: 'ghost', fact_type: 'other' },
        ],
      })
    )
    const ingest = new IngestService({
      store,
      embeddings: null,
      extractor: new UnifiedExtractor(llm),
    })
    await ingest.live({
      id: 'e1',
      ts: '2026-05-11T12:00:00.000Z',
      source: 'screen',
      app: 'X',
      title: 'X',
      body: 'body',
    })
    expect(store.activeFactsFor('a')).toHaveLength(1)
    expect(store.activeFactsFor('ghost')).toHaveLength(0)
  })

  it('returns duplicate=true on same body hash', async () => {
    const llm = fakeLlm('{"entities":[],"facts":[]}')
    const ingest = new IngestService({
      store,
      embeddings: null,
      extractor: new UnifiedExtractor(llm),
    })
    await ingest.live({ id: 'a', ts: '2026-05-11T12:00:00.000Z', source: 'screen', app: 'X', title: 'X', body: 'same' })
    const r = await ingest.live({
      id: 'b',
      ts: '2026-05-11T12:01:00.000Z',
      source: 'screen',
      app: 'X',
      title: 'X',
      body: 'same',
    })
    expect(r.duplicate).toBe(true)
    expect(r.inserted).toBe(false)
  })

  it('survives LLM extractor failure (event still persisted)', async () => {
    const llm = {
      chatCompletion: async () => {
        throw new Error('boom')
      },
    } as unknown as LLMClient
    const ingest = new IngestService({
      store,
      embeddings: null,
      extractor: new UnifiedExtractor(llm),
    })
    const r = await ingest.live({
      id: 'e1',
      ts: '2026-05-11T12:00:00.000Z',
      source: 'screen',
      app: 'X',
      title: 'X',
      body: 'body',
    })
    expect(r.inserted).toBe(true)
    expect(r.extraction).toBeNull()
    expect(store.countEvents()).toBe(1)
  })
})

describe('IngestService.backfill', () => {
  it('walks a captures dir and inserts .md files', async () => {
    const capDir = join(workDir, 'captures', '2026', '05', '11')
    mkdirSync(capDir, { recursive: true })
    const mkMd = (id: string, body: string) =>
      [
        '---',
        `id: ${id}`,
        'ts: 2026-05-11T12:00:00.000Z',
        'source: screen',
        'app: "X"',
        'title: "Y"',
        '---',
        '',
        body,
      ].join('\n')
    writeFileSync(join(capDir, 'a.md'), mkMd('id-a', 'body a'))
    writeFileSync(join(capDir, 'b.md'), mkMd('id-b', 'body b'))
    writeFileSync(join(capDir, 'c.md'), 'no frontmatter')

    const ingest = new IngestService({ store, embeddings: null, extractor: null })
    const r = await ingest.backfill(join(workDir, 'captures'))
    expect(r.scanned).toBe(3)
    expect(r.inserted).toBe(2)
    expect(r.skipped).toBe(1)
    expect(store.countEvents()).toBe(2)
  })
})
