import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../context-store/db'
import { ProceduralStore } from './store'

let dataDir: string
let store: ProceduralStore
let dbHandle: ReturnType<typeof openDb>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gtd-proc-store-'))
  dbHandle = openDb(join(dataDir, 'test.db'))
  store = new ProceduralStore({ db: dbHandle.db, vecAvailable: dbHandle.vecAvailable })
})

afterEach(() => {
  dbHandle.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seed(
  sectionIndex: number,
  appliesTo: 'needs-review' | 'universal' | 'openclaw-only',
  classifiedBy: 'heuristic' | 'llm' | 'user' | undefined
): string {
  return store.upsert({
    source: 'openclaw',
    path: 'MEMORY.md',
    sectionIndex,
    sectionTitle: `## Section ${sectionIndex}`,
    text: `body for section ${sectionIndex} that clears the minimum length easily`,
    fileMtime: Date.now(),
    appliesTo,
    classifiedBy,
  })
}

describe('ProceduralStore.listPendingLlmClassification', () => {
  it('returns needs-review chunks that are untouched or heuristic-only', () => {
    seed(0, 'needs-review', undefined) // classified_by NULL → eligible
    seed(1, 'needs-review', 'heuristic') // heuristic found no signal → eligible
    const pending = store.listPendingLlmClassification(100)
    expect(pending.map((p) => p.sectionIndex).sort()).toEqual([0, 1])
  })

  it('excludes chunks the LLM already adjudicated (terminal even if needs-review)', () => {
    seed(0, 'needs-review', 'llm') // LLM said needs-review → terminal
    seed(1, 'needs-review', 'user') // user said needs-review → terminal
    seed(2, 'needs-review', undefined) // still eligible
    const pending = store.listPendingLlmClassification(100)
    expect(pending.map((p) => p.sectionIndex)).toEqual([2])
  })

  it('excludes chunks that are already classified to a visible class', () => {
    seed(0, 'universal', 'heuristic')
    seed(1, 'openclaw-only', 'llm')
    const pending = store.listPendingLlmClassification(100)
    expect(pending.length).toBe(0)
  })

  it('honours the limit', () => {
    seed(0, 'needs-review', undefined)
    seed(1, 'needs-review', undefined)
    seed(2, 'needs-review', undefined)
    expect(store.listPendingLlmClassification(2).length).toBe(2)
  })

  it('a content change re-opens a chunk for LLM (new id, fresh classification)', () => {
    seed(0, 'needs-review', 'llm') // terminal
    expect(store.listPendingLlmClassification(100).length).toBe(0)

    // Same (source, path, section_index) but new text → upsert replaces
    // the row with a fresh one. Caller passes the new heuristic verdict.
    store.upsert({
      source: 'openclaw',
      path: 'MEMORY.md',
      sectionIndex: 0,
      sectionTitle: '## Section 0',
      text: 'completely different body content long enough to be a real chunk now',
      fileMtime: Date.now() + 1000,
      appliesTo: 'needs-review',
      classifiedBy: 'heuristic',
    })
    const pending = store.listPendingLlmClassification(100)
    expect(pending.length).toBe(1)
    expect(pending[0]!.sectionIndex).toBe(0)
  })
})

describe('ProceduralStore.classify', () => {
  it('updates applies_to + classified_by + classified_at', () => {
    const id = seed(0, 'needs-review', undefined)
    store.classify(id, 'universal', 'user')
    const [row] = store.loadByIds([id])
    expect(row!.appliesTo).toBe('universal')
    expect(row!.classifiedBy).toBe('user')
    expect(row!.classifiedAt).not.toBeNull()
  })
})

describe('ProceduralStore reliability feedback (FR89)', () => {
  it('recordProposalRefs is idempotent; applyResolutionFeedback EMAs the score', () => {
    const id = seed(0, 'universal', 'heuristic')
    store.recordProposalRefs('prop-1', [id])
    store.recordProposalRefs('prop-1', [id]) // duplicate — INSERT OR IGNORE

    expect(store.applyResolutionFeedback('prop-1', 'positive')).toBe(1)
    expect(store.getById(id)!.reliabilityScore).toBeCloseTo(0.6, 5) // seed

    store.applyResolutionFeedback('prop-1', 'positive') // 0.6+0.2*(1-0.6)=0.68
    expect(store.getById(id)!.reliabilityScore).toBeCloseTo(0.68, 5)

    store.applyResolutionFeedback('prop-1', 'negative') // 0.68+0.2*(0-0.68)=0.544
    expect(store.getById(id)!.reliabilityScore).toBeCloseTo(0.544, 5)
  })

  it('first negative signal seeds at 0.4', () => {
    const id = seed(0, 'universal', 'heuristic')
    store.recordProposalRefs('prop-x', [id])
    store.applyResolutionFeedback('prop-x', 'negative')
    expect(store.getById(id)!.reliabilityScore).toBeCloseTo(0.4, 5)
  })

  it('updates every cited chunk and returns the count', () => {
    const a = seed(0, 'universal', 'heuristic')
    const b = seed(1, 'universal', 'llm')
    store.recordProposalRefs('multi', [a, b])
    expect(store.applyResolutionFeedback('multi', 'positive')).toBe(2)
    expect(store.getById(a)!.reliabilityScore).toBeCloseTo(0.6, 5)
    expect(store.getById(b)!.reliabilityScore).toBeCloseTo(0.6, 5)
  })

  it('skips a cited chunk that was re-chunked away', () => {
    store.recordProposalRefs('ghost', ['nonexistent-chunk-id'])
    expect(store.applyResolutionFeedback('ghost', 'positive')).toBe(0)
  })

  it('reliabilitySummary aggregates scored chunks', () => {
    const a = seed(0, 'universal', 'heuristic')
    const b = seed(1, 'universal', 'llm')
    seed(2, 'universal', 'heuristic') // unscored
    store.recordProposalRefs('p', [a])
    store.recordProposalRefs('q', [b])
    store.applyResolutionFeedback('p', 'positive') // a → 0.6
    store.applyResolutionFeedback('q', 'negative') // b → 0.4
    const s = store.reliabilitySummary()
    expect(s.scored).toBe(2)
    expect(s.avg).toBeCloseTo(0.5, 5)
    expect(s.min).toBeCloseTo(0.4, 5)
    expect(s.belowHalf).toBe(1)
  })
})
