import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'
import { HybridRetriever } from './retrieve'

let dbPath: string
let store: MemoryStore

beforeEach(() => {
  dbPath = join(tmpdir(), `mem-ret-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const { db, vecAvailable } = openDb(dbPath)
  store = new MemoryStore({ db, vecAvailable })
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

function seedEvents(events: Array<{ id: string; ts: string; app: string; title: string; body: string; slugs?: string[] }>) {
  for (const e of events) {
    store.insertEvent(
      { id: e.id, ts: e.ts, source: 'screen', app: e.app, title: e.title, body: e.body },
      null
    )
    if (e.slugs) store.linkEntities(e.id, e.slugs)
  }
}

describe('HybridRetriever (FTS-only path, sqlite-vec disabled in CI)', () => {
  it('returns events matching the FTS query', async () => {
    seedEvents([
      { id: 'a', ts: '2026-05-11T10:00:00.000Z', app: 'Slack', title: 'DM Polina', body: 'Polina about Eazdrop dashboard' },
      { id: 'b', ts: '2026-05-11T11:00:00.000Z', app: 'Chrome', title: 'GitHub', body: 'just a github repo page' },
      { id: 'c', ts: '2026-05-11T12:00:00.000Z', app: 'Zoom', title: 'Call', body: 'Eazdrop technical sync' },
    ])
    const retriever = new HybridRetriever(store, null)
    const hits = await retriever.retrieve({ query: 'eazdrop polina' })
    const ids = hits.map((h) => h.id)
    expect(ids).toContain('a')
    expect(ids).toContain('c')
    expect(ids).not.toContain('b')
  })

  it('respects entitySlugs filter', async () => {
    seedEvents([
      { id: 'a', ts: '2026-05-11T10:00:00.000Z', app: 'Slack', title: 't', body: 'eazdrop body 1', slugs: ['eazdrop'] },
      { id: 'b', ts: '2026-05-11T11:00:00.000Z', app: 'Zoom', title: 't', body: 'eazdrop body 2', slugs: ['other'] },
    ])
    const retriever = new HybridRetriever(store, null)
    const hits = await retriever.retrieve({ query: 'eazdrop', entitySlugs: ['eazdrop'] })
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('respects withinDays filter', async () => {
    const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString()
    seedEvents([
      { id: 'old', ts: longAgo, app: 'X', title: 't', body: 'eazdrop ancient' },
      { id: 'new', ts: new Date().toISOString(), app: 'X', title: 't', body: 'eazdrop recent' },
    ])
    const retriever = new HybridRetriever(store, null)
    const hits = await retriever.retrieve({ query: 'eazdrop', withinDays: 7 })
    expect(hits.map((h) => h.id)).toEqual(['new'])
  })

  it('returns empty for a query with no FTS-tokenizable content', async () => {
    seedEvents([{ id: 'a', ts: '2026-05-11T10:00:00.000Z', app: 'X', title: 't', body: 'something' }])
    const retriever = new HybridRetriever(store, null)
    const hits = await retriever.retrieve({ query: '?' })
    expect(hits).toEqual([])
  })

  it('returns events sorted by RRF score (descending)', async () => {
    seedEvents([
      { id: 'unique', ts: '2026-05-11T10:00:00.000Z', app: 'X', title: 't', body: 'rare-word-xyz only here' },
      { id: 'common', ts: '2026-05-11T11:00:00.000Z', app: 'X', title: 't', body: 'rare-word-xyz appears alongside many other tokens that dilute the match' },
    ])
    const retriever = new HybridRetriever(store, null)
    const hits = await retriever.retrieve({ query: 'rare-word-xyz' })
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[hits.length - 1]!.score)
  })
})
