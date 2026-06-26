import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../context-store/db'
import { GlossaryStore, GlossaryStoreSource } from './glossary-store'

let dbPath: string
let store: GlossaryStore

beforeEach(() => {
  dbPath = join(tmpdir(), `gloss-store-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const { db } = openDb(dbPath)
  store = new GlossaryStore(db)
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

describe('GlossaryStore.upsertCandidate', () => {
  it('inserts a fresh candidate with mention_count=1', () => {
    const rec = store.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project', confidence: 0.8 })
    expect(rec.status).toBe('candidate')
    expect(rec.term).toBe('Phoenix')
    expect(rec.mentionCount).toBe(1)
    expect(rec.source).toBe('onboarding')
  })

  it('bumps mention_count and merges fields on repeated candidate', () => {
    store.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project', aliases: ['PHX'] })
    const rec = store.upsertCandidate({
      slug: 'phoenix',
      term: 'Phoenix',
      kind: 'project',
      expansion: 'DB migration',
      aliases: ['Phoenix Project'],
      confidence: 0.9,
    })
    expect(rec.mentionCount).toBe(2)
    expect(rec.expansion).toBe('DB migration')
    expect(rec.aliases.sort()).toEqual(['PHX', 'Phoenix Project'])
  })

  it('does NOT resurrect a confirmed/rejected row to candidate', () => {
    store.upsertCandidate({ slug: 'sbp', term: 'СБП', kind: 'term' })
    store.reject('sbp')
    const rec = store.upsertCandidate({ slug: 'sbp', term: 'СБП', kind: 'term' })
    expect(rec.status).toBe('rejected')
    expect(rec.mentionCount).toBe(2) // sighting still counted
  })
})

describe('GlossaryStore.confirm / reject', () => {
  it('confirm sets status, expansion, confirmed_at, source=user', () => {
    store.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project' })
    const rec = store.confirm({ slug: 'phoenix', expansion: 'миграция БД на PostgreSQL' })
    expect(rec).not.toBeNull()
    expect(rec!.status).toBe('confirmed')
    expect(rec!.expansion).toBe('миграция БД на PostgreSQL')
    expect(rec!.confirmedAt).not.toBeNull()
    expect(rec!.source).toBe('user')
  })

  it('confirm can correct term/kind', () => {
    store.upsertCandidate({ slug: 'mr', term: 'MR', kind: 'term' })
    const rec = store.confirm({ slug: 'mr', term: 'MR', kind: 'term', expansion: 'Merge Request' })
    expect(rec!.expansion).toBe('Merge Request')
  })

  it('reject marks status rejected', () => {
    store.upsertCandidate({ slug: 'foo', term: 'Foo', kind: 'term' })
    const rec = store.reject('foo')
    expect(rec!.status).toBe('rejected')
  })

  it('confirm/reject on unknown slug returns null', () => {
    expect(store.confirm({ slug: 'nope' })).toBeNull()
    expect(store.reject('nope')).toBeNull()
  })
})

describe('GlossaryStore queries', () => {
  it('listByStatus + countByStatus segregate rows', () => {
    store.upsertCandidate({ slug: 'a', term: 'A', kind: 'term' })
    store.upsertCandidate({ slug: 'b', term: 'B', kind: 'project' })
    store.upsertCandidate({ slug: 'c', term: 'C', kind: 'term' })
    store.confirm({ slug: 'a', expansion: 'Alpha' })
    store.reject('b')
    expect(store.countByStatus('candidate')).toBe(1)
    expect(store.countByStatus('confirmed')).toBe(1)
    expect(store.countByStatus('rejected')).toBe(1)
    expect(store.listByStatus('candidate').map((r) => r.slug)).toEqual(['c'])
  })

  it('isKnown true for any status', () => {
    store.upsertCandidate({ slug: 'x', term: 'X', kind: 'term' })
    expect(store.isKnown('x')).toBe(true)
    expect(store.isKnown('y')).toBe(false)
    store.reject('x')
    expect(store.isKnown('x')).toBe(true)
  })
})

describe('GlossaryStoreSource', () => {
  it('exposes confirmed entries and rejected slugs', () => {
    store.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project' })
    store.upsertCandidate({ slug: 'sbp', term: 'СБП', kind: 'term' })
    store.confirm({ slug: 'phoenix', expansion: 'DB migration' })
    store.reject('sbp')
    const src = new GlossaryStoreSource(store)
    const confirmed = src.confirmedEntries()
    expect(confirmed.map((e) => e.slug)).toEqual(['phoenix'])
    expect(confirmed[0]!.expansion).toBe('DB migration')
    expect([...src.rejectedSlugs()]).toEqual(['sbp'])
  })
})
