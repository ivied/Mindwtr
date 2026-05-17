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
