import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpServer } from './server'
import { openDb } from '../context-store/db'
import { ProceduralStore } from '../memory/procedural'
import type { CaptureFn } from '../capture/sink'

const TOKEN = 'test-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

let dataDir: string
let dbHandle: ReturnType<typeof openDb>
let store: ProceduralStore
let handler: (req: Request) => Response | Promise<Response>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gtd-proc-http-'))
  dbHandle = openDb(join(dataDir, 'test.db'))
  store = new ProceduralStore({ db: dbHandle.db, vecAvailable: dbHandle.vecAvailable })
  const server = createHttpServer({
    port: 0,
    authToken: TOKEN,
    capture: (async () => {}) as unknown as CaptureFn,
    contextStore: null,
    proposals: null,
    persons: null,
    procedural: { store },
  })
  handler = server.handler
})

afterEach(() => {
  dbHandle.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seed(
  idx: number,
  sectionTitle: string,
  applies: 'universal' | 'openclaw-only' | 'needs-review',
  by: 'heuristic' | 'llm' | undefined
): string {
  return store.upsert({
    source: 'openclaw',
    path: 'MEMORY.md',
    sectionIndex: idx,
    sectionTitle,
    text: `body of section ${idx} long enough to clear the minimum threshold easily`,
    fileMtime: Date.now(),
    appliesTo: applies,
    classifiedBy: by,
  })
}

describe('GET /v1/procedural/chunks', () => {
  it('lists all chunks with excerpt + classification fields', async () => {
    seed(0, '## Slack', 'universal', 'heuristic')
    seed(1, '## Telethon', 'openclaw-only', 'llm')
    const res = await handler(new Request('http://x/v1/procedural/chunks', { headers: AUTH }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      items: Array<{ sectionTitle: string; appliesTo: string; excerpt: string }>
    }
    expect(body.total).toBe(2)
    expect(body.items.map((i) => i.appliesTo).sort()).toEqual(['openclaw-only', 'universal'])
    expect(body.items[0]!.excerpt.length).toBeGreaterThan(0)
  })

  it('filters by applies', async () => {
    seed(0, '## Slack', 'universal', 'heuristic')
    seed(1, '## Telethon', 'openclaw-only', 'llm')
    const res = await handler(
      new Request('http://x/v1/procedural/chunks?applies=openclaw-only', { headers: AUTH })
    )
    const body = (await res.json()) as { total: number; items: Array<{ sectionTitle: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.sectionTitle).toBe('## Telethon')
  })

  it('paginates with limit + offset', async () => {
    for (let i = 0; i < 5; i++) seed(i, `## S${i}`, 'universal', 'heuristic')
    const res = await handler(
      new Request('http://x/v1/procedural/chunks?limit=2&offset=2', { headers: AUTH })
    )
    const body = (await res.json()) as { total: number; items: unknown[] }
    expect(body.total).toBe(5)
    expect(body.items.length).toBe(2)
  })

  it('401 without auth', async () => {
    const res = await handler(new Request('http://x/v1/procedural/chunks'))
    expect(res.status).toBe(401)
  })
})

describe('POST /v1/procedural/chunks/:id/classify', () => {
  it('applies a user override and marks classified_by=user', async () => {
    const id = seed(0, '## Как работать с Notion', 'openclaw-only', 'llm')
    const res = await handler(
      new Request(`http://x/v1/procedural/chunks/${id}/classify`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ appliesTo: 'universal' }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; chunk: { appliesTo: string; classifiedBy: string } }
    expect(body.ok).toBe(true)
    expect(body.chunk.appliesTo).toBe('universal')
    expect(body.chunk.classifiedBy).toBe('user')
    // Persisted.
    expect(store.getById(id)!.appliesTo).toBe('universal')
    expect(store.getById(id)!.classifiedBy).toBe('user')
  })

  it('rejects an invalid appliesTo', async () => {
    const id = seed(0, '## X', 'needs-review', undefined)
    const res = await handler(
      new Request(`http://x/v1/procedural/chunks/${id}/classify`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ appliesTo: 'banana' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('rejects appliesTo=needs-review (not user-settable)', async () => {
    const id = seed(0, '## X', 'universal', 'heuristic')
    const res = await handler(
      new Request(`http://x/v1/procedural/chunks/${id}/classify`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ appliesTo: 'needs-review' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('404 for unknown chunk id', async () => {
    const res = await handler(
      new Request('http://x/v1/procedural/chunks/does-not-exist/classify', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ appliesTo: 'universal' }),
      })
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /v1/procedural/stats', () => {
  it('returns distribution by applies + classifier', async () => {
    seed(0, '## A', 'universal', 'heuristic')
    seed(1, '## B', 'universal', 'llm')
    seed(2, '## C', 'openclaw-only', 'heuristic')
    const res = await handler(new Request('http://x/v1/procedural/stats', { headers: AUTH }))
    const body = (await res.json()) as {
      total: number
      byApplies: Record<string, number>
      byClassifier: Record<string, number>
    }
    expect(body.total).toBe(3)
    expect(body.byApplies.universal).toBe(2)
    expect(body.byApplies['openclaw-only']).toBe(1)
    expect(body.byClassifier.heuristic).toBe(2)
    expect(body.byClassifier.llm).toBe(1)
  })
})
