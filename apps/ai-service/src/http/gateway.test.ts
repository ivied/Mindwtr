import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { AgentRunStore } from '../agent-runs/store'
import { createHttpServer, forward } from './server'

const TOKEN = 'ui-token'
let upstream: ReturnType<typeof Bun.serve>
const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = []

// Other test files replace global.fetch with mocks and leave them in place.
const fetchBefore = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = Bun.fetch as typeof fetch
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get('authorization'), body: await req.text() })
      if (url.pathname === '/v1/missing') return new Response('nope', { status: 404 })
      return Response.json({ from: 'worker', path: url.pathname }, { headers: { 'access-control-allow-origin': '*', 'x-kept': 'yes' } })
    },
  })
})
afterAll(() => {
  globalThis.fetch = fetchBefore
  upstream.stop(true)
})

function gateway(target = `http://127.0.0.1:${upstream.port}`) {
  const store = new AgentRunStore(new Database(':memory:'))
  const server = createHttpServer({
    port: 0,
    authToken: TOKEN,
    capture: async () => {
      throw new Error('not here')
    },
    contextStore: null,
    proposals: null,
    persons: null,
    proxyTo: target,
    agentRuns: {
      store,
      dailyBudgetUsd: 0,
      mindwtr: {
        getTask: async () => { throw new Error('unused') },
        listTasks: async () => [],
        updateTask: async () => { throw new Error('unused') },
        completeTask: async () => { throw new Error('unused') },
        search: async () => ({ tasks: [], projects: [] }),
      },
    },
  })
  const call = (path: string, init: RequestInit = {}) =>
    server.handler(new Request(`http://gateway${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } }))
  return { call, store }
}

describe('gateway mode', () => {
  it('answers agent-runs itself', async () => {
    const { call, store } = gateway()
    store.enqueue({ taskId: 't1', taskTitle: 'Task', taskDescription: '' })
    const before = seen.length
    const res = await call('/v1/agent-runs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items.length).toBe(1)
    expect(seen.length).toBe(before)
  })

  it('passes everything else to the full service with method, query, auth and body', async () => {
    const { call } = gateway()
    const res = await call('/v1/capture?x=1', { method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: 'worker', path: '/v1/capture' })
    const last = seen.at(-1)!
    expect(last).toEqual({ method: 'POST', path: '/v1/capture?x=1', auth: `Bearer ${TOKEN}`, body: '{"text":"hello"}' })
    expect(res.headers.get('x-kept')).toBe('yes')
    // The worker's own CORS answer is dropped; the gateway's is the only one.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('keeps the status of the full service', async () => {
    const { call } = gateway()
    expect((await call('/v1/missing')).status).toBe(404)
  })

  it('still asks for the token before forwarding', async () => {
    const { call } = gateway()
    const before = seen.length
    const res = await call('/v1/proposals', { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    expect(seen.length).toBe(before)
  })

  it('reports an unreachable service as 502 and stays alive itself', async () => {
    const { call } = gateway('http://127.0.0.1:9')
    expect((await call('/v1/proposals')).status).toBe(502)
    expect((await call('/healthz')).status).toBe(200)
    expect((await call('/v1/agent-runs')).status).toBe(200)
  })
})

describe('forward', () => {
  it('does not send a body with GET', async () => {
    const res = await forward(new Request('http://gateway/v1/threads'), `http://127.0.0.1:${upstream.port}/`)
    expect(res.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/v1/threads', body: '' })
  })
})
