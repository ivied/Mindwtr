import { describe, it, expect, mock } from 'bun:test'
import { createHttpServer } from './server'
import type { CaptureFn } from '../capture/sink'
import type { PersonsProvider, KnownPerson } from '../wiki/persons-reader'

const TOKEN = 'test-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }

function setupHandler(persons: KnownPerson[] | (() => Promise<KnownPerson[]>)) {
  const provider: PersonsProvider = {
    recentPersons: mock(async () => (typeof persons === 'function' ? persons() : persons)),
  }
  const server = createHttpServer({
    port: 0,
    authToken: TOKEN,
    capture: (async () => {}) as unknown as CaptureFn,
    contextStore: null,
    proposals: null,
    persons: provider,
  })
  return server.handler
}

function p(slug: string, name: string, aliases: string[] = [], mc = 1): KnownPerson {
  return { slug, name, aliases, mentionCount: mc }
}

describe('GET /v1/persons', () => {
  it('returns full list when no q', async () => {
    const handler = setupHandler([p('amir', 'Amir', ['Амир']), p('polina', 'Polina', ['Полина'], 5)])
    const res = await handler(new Request('http://x/v1/persons', { headers: AUTH }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items.map((i) => i.slug)).toEqual(['amir', 'polina'])
  })

  it('filters case-insensitively against name', async () => {
    const handler = setupHandler([p('amir', 'Amir'), p('polina', 'Polina')])
    const res = await handler(new Request('http://x/v1/persons?q=AMI', { headers: AUTH }))
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items.map((i) => i.slug)).toEqual(['amir'])
  })

  it('filters against aliases (Cyrillic match)', async () => {
    const handler = setupHandler([
      p('amir', 'Amir', ['Амир']),
      p('polina', 'Polina', ['Полина']),
    ])
    const res = await handler(
      new Request(`http://x/v1/persons?q=${encodeURIComponent('Амир')}`, { headers: AUTH })
    )
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items.map((i) => i.slug)).toEqual(['amir'])
  })

  it('filters against slug', async () => {
    const handler = setupHandler([p('allison-walker', 'Allison Walker')])
    const res = await handler(new Request('http://x/v1/persons?q=walker', { headers: AUTH }))
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items).toHaveLength(1)
  })

  it('respects limit param', async () => {
    const persons = Array.from({ length: 20 }, (_, i) => p(`p${i}`, `P${i}`, [], 20 - i))
    const handler = setupHandler(persons)
    const res = await handler(new Request('http://x/v1/persons?limit=3', { headers: AUTH }))
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items).toHaveLength(3)
  })

  it('clamps limit to max 200', async () => {
    const persons = Array.from({ length: 250 }, (_, i) => p(`p${i}`, `P${i}`))
    const handler = setupHandler(persons)
    const res = await handler(new Request('http://x/v1/persons?limit=999', { headers: AUTH }))
    const body = (await res.json()) as { items: KnownPerson[] }
    expect(body.items).toHaveLength(200)
  })

  it('returns 500 with error when provider throws', async () => {
    const handler = setupHandler(async () => {
      throw new Error('wiki gone')
    })
    const res = await handler(new Request('http://x/v1/persons', { headers: AUTH }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('wiki gone')
  })

  it('returns 401 without auth', async () => {
    const handler = setupHandler([p('amir', 'Amir')])
    const res = await handler(new Request('http://x/v1/persons'))
    expect(res.status).toBe(401)
  })
})
