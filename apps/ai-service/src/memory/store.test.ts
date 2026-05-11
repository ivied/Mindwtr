import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'

let dbPath: string
let store: MemoryStore

function makeStore(): MemoryStore {
  const { db, vecAvailable } = openDb(dbPath)
  return new MemoryStore({ db, vecAvailable })
}

beforeEach(() => {
  dbPath = join(tmpdir(), `mem-store-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  store = makeStore()
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

describe('MemoryStore.insertEvent', () => {
  it('inserts a fresh event and counts it', () => {
    const ok = store.insertEvent(
      {
        id: 'evt-1',
        ts: '2026-05-11T12:00:00.000Z',
        source: 'screen',
        app: 'Chrome',
        title: 'Some page',
        body: 'Hello world from a capture body.',
      },
      null
    )
    expect(ok).toBe(true)
    expect(store.countEvents()).toBe(1)
  })

  it('returns false on duplicate content (same body hash)', () => {
    store.insertEvent({ id: 'a', ts: '2026-05-11T12:00:00.000Z', source: 'screen', body: 'same body' }, null)
    const dup = store.insertEvent({ id: 'b', ts: '2026-05-11T12:01:00.000Z', source: 'screen', body: 'same body' }, null)
    expect(dup).toBe(false)
    expect(store.countEvents()).toBe(1)
  })

  it('throws on id collision with different body', () => {
    store.insertEvent({ id: 'x', ts: '2026-05-11T12:00:00.000Z', source: 'screen', body: 'first' }, null)
    expect(() =>
      store.insertEvent({ id: 'x', ts: '2026-05-11T12:01:00.000Z', source: 'screen', body: 'second' }, null)
    ).toThrow()
  })

  it('round-trips body, app, title, meta', () => {
    store.insertEvent(
      {
        id: 'r1',
        ts: '2026-05-11T12:00:00.000Z',
        source: 'audio',
        app: 'Zoom',
        title: 'Call',
        body: 'transcript here',
        meta: { display_index: 0, sent_to_inbox: true },
      },
      null
    )
    const ev = store.getEvent('r1')!
    expect(ev.source).toBe('audio')
    expect(ev.app).toBe('Zoom')
    expect(ev.title).toBe('Call')
    expect(ev.body).toBe('transcript here')
    expect(ev.meta).toEqual({ display_index: 0, sent_to_inbox: true })
  })

  it('eventsBetween returns only events in the half-open range', () => {
    store.insertEvent({ id: '1', ts: '2026-05-10T12:00:00.000Z', source: 'screen', body: 'before' }, null)
    store.insertEvent({ id: '2', ts: '2026-05-11T12:00:00.000Z', source: 'screen', body: 'in' }, null)
    store.insertEvent({ id: '3', ts: '2026-05-12T12:00:00.000Z', source: 'screen', body: 'after' }, null)
    const range = store.eventsBetween('2026-05-11T00:00:00.000Z', '2026-05-12T00:00:00.000Z')
    expect(range.map((e) => e.id)).toEqual(['2'])
  })
})

describe('MemoryStore.linkEntities', () => {
  it('attaches entity slugs and de-duplicates', () => {
    store.insertEvent({ id: 'e1', ts: '2026-05-11T12:00:00.000Z', source: 'screen', body: 'body 1' }, null)
    store.linkEntities('e1', ['polina', 'eazdrop', 'polina'])
    const rows = store.db.query<{ entity_slug: string }, [string]>(
      'SELECT entity_slug FROM event_entities WHERE event_id = ? ORDER BY entity_slug'
    ).all('e1')
    expect(rows.map((r) => r.entity_slug)).toEqual(['eazdrop', 'polina'])
  })
})

describe('MemoryStore.facts', () => {
  it('inserts a fact and returns it via activeFactsFor', () => {
    const f = store.insertFact({
      statement: 'Sergey works on GTD',
      entitySlug: 'sergey',
      factType: 'working_on',
      validFrom: '2026-05-11T12:00:00.000Z',
    })
    expect(f.id).toBeGreaterThan(0)
    expect(store.countFacts()).toBe(1)
    const active = store.activeFactsFor('sergey')
    expect(active).toHaveLength(1)
    expect(active[0]!.statement).toBe('Sergey works on GTD')
    expect(active[0]!.validTo).toBeNull()
  })

  it('supersedePrevious closes the previous active fact', () => {
    store.insertFact({
      statement: 'Sergey works on Phase A',
      entitySlug: 'sergey',
      factType: 'working_on',
      validFrom: '2026-05-10T12:00:00.000Z',
    })
    store.insertFact(
      {
        statement: 'Sergey works on Phase B',
        entitySlug: 'sergey',
        factType: 'working_on',
        validFrom: '2026-05-11T12:00:00.000Z',
      },
      true
    )
    const active = store.activeFactsFor('sergey')
    expect(active).toHaveLength(1)
    expect(active[0]!.statement).toBe('Sergey works on Phase B')
    expect(store.countFacts()).toBe(2)
  })

  it('does not supersede when factType differs', () => {
    store.insertFact({
      statement: 'A',
      entitySlug: 'x',
      factType: 'working_on',
      validFrom: '2026-05-10T12:00:00.000Z',
    })
    store.insertFact(
      {
        statement: 'B',
        entitySlug: 'x',
        factType: 'waiting_on',
        validFrom: '2026-05-11T12:00:00.000Z',
      },
      true
    )
    expect(store.activeFactsFor('x')).toHaveLength(2)
  })
})

describe('MemoryStore.dailySummary', () => {
  it('upserts and rereads', () => {
    store.upsertDailySummary(
      {
        date: '2026-05-11',
        summary: 'Did some work.',
        eventCount: 42,
        factsAdded: 3,
        createdAt: '2026-05-12T00:00:00.000Z',
      },
      null
    )
    const s = store.getDailySummary('2026-05-11')!
    expect(s.summary).toBe('Did some work.')
    expect(s.eventCount).toBe(42)
    expect(s.factsAdded).toBe(3)
  })

  it('upsert replaces existing row', () => {
    store.upsertDailySummary(
      { date: '2026-05-11', summary: 'first', eventCount: 1, factsAdded: 0, createdAt: '2026-05-11T00:00:00.000Z' },
      null
    )
    store.upsertDailySummary(
      { date: '2026-05-11', summary: 'second', eventCount: 2, factsAdded: 1, createdAt: '2026-05-12T00:00:00.000Z' },
      null
    )
    expect(store.getDailySummary('2026-05-11')!.summary).toBe('second')
  })

  it('recentDailySummaries returns newest-first', () => {
    for (const d of ['2026-05-09', '2026-05-10', '2026-05-11']) {
      store.upsertDailySummary(
        { date: d, summary: d, eventCount: 1, factsAdded: 0, createdAt: '2026-05-12T00:00:00.000Z' },
        null
      )
    }
    const last = store.recentDailySummaries(2)
    expect(last.map((s) => s.date)).toEqual(['2026-05-11', '2026-05-10'])
  })
})
