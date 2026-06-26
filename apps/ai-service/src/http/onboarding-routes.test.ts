import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpServer } from './server'
import type { CaptureFn } from '../capture/sink'
import { openDb } from '../context-store/db'
import { GlossaryStore } from '../wiki/glossary-store'
import type { OnboardingExtractor, GlossaryCandidate } from '../memory/onboarding-extractor'
import type { MindwtrClient, Task } from '../api/mindwtr-client'

const TOKEN = 'test-token'
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

let dbPath: string
let glossary: GlossaryStore

function fakeTask(title: string): Task {
  return {
    id: title,
    title,
    status: 'inbox',
    contexts: [],
    tags: [],
    createdAt: '2026-06-24T00:00:00Z',
    updatedAt: '2026-06-24T00:00:00Z',
  }
}

function setup(opts: {
  tasks?: Task[]
  candidates?: GlossaryCandidate[]
  taskError?: boolean
}) {
  const mindwtr = {
    listTasks: mock(async () => {
      if (opts.taskError) throw new Error('cloud down')
      return opts.tasks ?? []
    }),
  } as unknown as MindwtrClient
  const extractor = {
    collect: mock(async () => opts.candidates ?? []),
  } as unknown as OnboardingExtractor
  const server = createHttpServer({
    port: 0,
    authToken: TOKEN,
    capture: (async () => {}) as unknown as CaptureFn,
    contextStore: null,
    proposals: null,
    persons: null,
    onboarding: { mindwtr, extractor, glossary },
  })
  return server.handler
}

function cand(slug: string, term: string, grade: 'high' | 'needs_input' = 'high'): GlossaryCandidate {
  return {
    slug,
    term,
    kind: 'project',
    expansion: grade === 'high' ? `${term} decoded` : '',
    grade,
    confidence: grade === 'high' ? 0.9 : 0.4,
    evidence: `task about ${term}`,
  }
}

beforeEach(() => {
  dbPath = join(tmpdir(), `gloss-http-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const { db } = openDb(dbPath)
  glossary = new GlossaryStore(db)
})

afterEach(() => {
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

describe('POST /v1/onboarding/scan', () => {
  it('persists candidates and returns them with counts', async () => {
    const handler = setup({
      tasks: [fakeTask('Finish Phoenix migration')],
      candidates: [cand('phoenix', 'Phoenix'), cand('sbp', 'СБП', 'needs_input')],
    })
    const res = await handler(new Request('http://x/v1/onboarding/scan', { method: 'POST', headers: AUTH, body: '{}' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scannedTasks: number; candidates: { slug: string }[]; counts: Record<string, number> }
    // scan fans out across inbox/next/waiting; the stub returns the task for each.
    expect(body.scannedTasks).toBe(3)
    expect(body.candidates.map((c) => c.slug).sort()).toEqual(['phoenix', 'sbp'])
    expect(body.counts.candidate).toBe(2)
    // persisted
    expect(glossary.countByStatus('candidate')).toBe(2)
  })

  it('does not re-surface already-confirmed slugs', async () => {
    glossary.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project' })
    glossary.confirm({ slug: 'phoenix', expansion: 'DB migration' })
    const handler = setup({
      tasks: [fakeTask('Phoenix')],
      candidates: [cand('phoenix', 'Phoenix')],
    })
    const res = await handler(new Request('http://x/v1/onboarding/scan', { method: 'POST', headers: AUTH, body: '{}' }))
    const body = (await res.json()) as { candidates: { slug: string }[] }
    expect(body.candidates).toHaveLength(0)
    expect(glossary.countByStatus('confirmed')).toBe(1)
  })

  it('returns 502 when task fetch fails', async () => {
    const handler = setup({ taskError: true })
    const res = await handler(new Request('http://x/v1/onboarding/scan', { method: 'POST', headers: AUTH, body: '{}' }))
    expect(res.status).toBe(502)
  })
})

describe('POST /v1/glossary/confirm + reject', () => {
  it('confirm updates a candidate to confirmed', async () => {
    glossary.upsertCandidate({ slug: 'phoenix', term: 'Phoenix', kind: 'project' })
    const handler = setup({})
    const res = await handler(
      new Request('http://x/v1/glossary/confirm', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ slug: 'phoenix', expansion: 'миграция БД' }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { record: { status: string; expansion: string } }
    expect(body.record.status).toBe('confirmed')
    expect(body.record.expansion).toBe('миграция БД')
  })

  it('confirm on unknown slug returns 404', async () => {
    const handler = setup({})
    const res = await handler(
      new Request('http://x/v1/glossary/confirm', { method: 'POST', headers: AUTH, body: JSON.stringify({ slug: 'nope' }) })
    )
    expect(res.status).toBe(404)
  })

  it('confirm without slug returns 400', async () => {
    const handler = setup({})
    const res = await handler(
      new Request('http://x/v1/glossary/confirm', { method: 'POST', headers: AUTH, body: '{}' })
    )
    expect(res.status).toBe(400)
  })

  it('reject marks rejected and is remembered on rescan', async () => {
    glossary.upsertCandidate({ slug: 'sbp', term: 'СБП', kind: 'term' })
    const handler = setup({ tasks: [fakeTask('СБП integration')], candidates: [cand('sbp', 'СБП')] })
    const rej = await handler(
      new Request('http://x/v1/glossary/reject', { method: 'POST', headers: AUTH, body: JSON.stringify({ slug: 'sbp' }) })
    )
    expect(rej.status).toBe(200)
    // rescan must NOT re-propose it
    const scan = await handler(new Request('http://x/v1/onboarding/scan', { method: 'POST', headers: AUTH, body: '{}' }))
    const body = (await scan.json()) as { candidates: { slug: string }[] }
    expect(body.candidates.find((c) => c.slug === 'sbp')).toBeUndefined()
    expect(glossary.countByStatus('rejected')).toBe(1)
  })
})

describe('GET /v1/glossary', () => {
  it('lists by status', async () => {
    glossary.upsertCandidate({ slug: 'a', term: 'A', kind: 'term' })
    glossary.upsertCandidate({ slug: 'b', term: 'B', kind: 'term' })
    glossary.confirm({ slug: 'a', expansion: 'Alpha' })
    const handler = setup({})
    const res = await handler(new Request('http://x/v1/glossary?status=confirmed', { headers: AUTH }))
    const body = (await res.json()) as { items: { slug: string }[] }
    expect(body.items.map((i) => i.slug)).toEqual(['a'])
  })

  it('rejects invalid status with 400', async () => {
    const handler = setup({})
    const res = await handler(new Request('http://x/v1/glossary?status=bogus', { headers: AUTH }))
    expect(res.status).toBe(400)
  })

  it('returns 401 without auth', async () => {
    const handler = setup({})
    const res = await handler(new Request('http://x/v1/glossary?status=candidate'))
    expect(res.status).toBe(401)
  })
})
