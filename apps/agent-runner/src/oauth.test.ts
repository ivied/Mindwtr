import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthProxy, OAuthVault } from './oauth'

const SERVER = 'https://mcp.example.com/mcp'
const REDIRECT = 'https://ai.example.org/oauth/callback'

/** A fake service: resource metadata, OAuth metadata, registration and the token endpoint. */
function fakeService(opts: { registration?: boolean; expiresIn?: number } = {}) {
  const calls: Array<{ url: string; body: string }> = []
  let issued = 0
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
      return Response.json({ resource: SERVER, authorization_servers: ['https://auth.example.com'], scopes_supported: ['read', 'write'] })
    }
    if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
      return Response.json({
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        ...(opts.registration === false ? {} : { registration_endpoint: 'https://auth.example.com/register' }),
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url === 'https://auth.example.com/register') return Response.json({ client_id: 'client-1' }, { status: 201 })
    if (url === 'https://auth.example.com/token') {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
        return Response.json({ error: 'invalid_grant', error_description: 'code expired' }, { status: 400 })
      }
      issued++
      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: opts.expiresIn ?? 900, scope: 'read' })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchFn, calls }
}

describe('sign-ins the runner owns', () => {
  it('registers a client, builds the link, and redeems the code into a private file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-'))
    const { fetchFn, calls } = fakeService()
    const vault = new OAuthVault(dir, fetchFn)

    const { url, state } = await vault.begin('demo', SERVER, REDIRECT)
    const link = new URL(url)
    expect(link.origin + link.pathname).toBe('https://auth.example.com/authorize')
    expect(link.searchParams.get('client_id')).toBe('client-1')
    expect(link.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(link.searchParams.get('code_challenge_method')).toBe('S256')
    expect(link.searchParams.get('state')).toBe(state)
    expect(link.searchParams.get('resource')).toBe(SERVER)
    expect(link.searchParams.get('scope')).toBe('read write')
    expect(vault.ready()).toEqual([]) // nothing to hand to agents before the sign-in

    await expect(vault.complete('demo', 'stale-code')).rejects.toThrow('code expired')
    expect(await vault.complete('demo', 'good-code')).toEqual({ scope: 'read' })
    expect(vault.ready()).toEqual([{ name: 'demo', serverUrl: SERVER }])
    expect(await vault.accessToken('demo')).toBe('access-1')

    const file = join(dir, 'demo.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const exchange = new URLSearchParams(calls.filter((c) => c.url.endsWith('/token') && c.body.includes('grant_type=authorization_code')).pop()!.body)
    expect(exchange.get('code_verifier')!.length).toBeGreaterThanOrEqual(43)
    expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull() // the verifier is dropped once used
    expect(exchange.get('redirect_uri')).toBe(REDIRECT)

    // A second sign-in reuses the registered client.
    await vault.begin('demo', SERVER, REDIRECT)
    expect(calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(1)
    vault.remove('demo')
    expect(vault.ready()).toEqual([])
  })

  it('refreshes an expiring token once, even when asked many times at the same moment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-'))
    let clock = 1_000_000
    const { fetchFn, calls } = fakeService({ expiresIn: 900 })
    const vault = new OAuthVault(dir, fetchFn, () => clock)
    await vault.begin('demo', SERVER, REDIRECT)
    await vault.complete('demo', 'good-code')

    clock += 600_000 // ten minutes in: still good
    expect(await vault.accessToken('demo')).toBe('access-1')
    clock += 290_000 // under a minute left
    const tokens = await Promise.all([vault.accessToken('demo'), vault.accessToken('demo'), vault.accessToken('demo')])
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2'])
    const refreshes = calls.filter((c) => c.body.includes('grant_type=refresh_token'))
    expect(refreshes).toHaveLength(1)
    expect(new URLSearchParams(refreshes[0]!.body).get('refresh_token')).toBe('refresh-1')
  })

  it('falls back to a return address on this computer when the service refuses the public one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-'))
    const base = fakeService()
    const tried: string[] = []
    const picky = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/register')) {
        const uri = JSON.parse(String(init?.body)).redirect_uris[0] as string
        tried.push(uri)
        if (!uri.startsWith('http://127.0.0.1')) return Response.json({ error_description: 'disallowed host' }, { status: 400 })
      }
      return base.fetchFn(url, init)
    }
    const vault = new OAuthVault(dir, picky)
    const local = 'http://127.0.0.1:47823/callback'
    const started = await vault.begin('demo', SERVER, [REDIRECT, local])
    expect(tried).toEqual([REDIRECT, local])
    expect(started.redirectUri).toBe(local)
    expect(new URL(started.url).searchParams.get('redirect_uri')).toBe(local)
    await vault.complete('demo', 'good-code')
    const exchange = new URLSearchParams(base.calls.filter((c) => c.url.endsWith('/token')).pop()!.body)
    expect(exchange.get('redirect_uri')).toBe(local)
  })

  it('says plainly when the service cannot be connected this way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-'))
    const vault = new OAuthVault(dir, fakeService({ registration: false }).fetchFn)
    await expect(vault.begin('demo', SERVER, REDIRECT)).rejects.toThrow('регистрацию клиента')
    await expect(vault.begin('demo', 'http://plain.example.com/mcp', REDIRECT)).rejects.toThrow('https://')
    await expect(vault.begin('../x', SERVER, REDIRECT)).rejects.toThrow('недопустимое имя')
  })
})

describe('local proxy for signed-in services', () => {
  let proxy: OAuthProxy | null = null
  afterEach(() => proxy?.stop())

  it('adds the current token, retries once after a 401, and never exposes the token to the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-'))
    const { fetchFn } = fakeService()
    const vault = new OAuthVault(dir, fetchFn)
    await vault.begin('demo', SERVER, REDIRECT)
    await vault.complete('demo', 'good-code')

    const seen: Array<{ url: string; auth: string | null; body: string; session: string | null }> = []
    const upstream = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      const auth = headers.get('authorization')
      seen.push({ url, auth, body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : '', session: headers.get('mcp-session-id') })
      // The first token was revoked on the service side.
      if (auth === 'Bearer access-1') return new Response('expired', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
      return Response.json({ ok: true }, { headers: { 'Mcp-Session-Id': 'sess-9' } })
    }
    proxy = new OAuthProxy(vault, upstream)
    const servers = proxy.mcpServers()
    expect(Object.keys(servers)).toEqual(['demo'])
    expect(servers.demo!.url).toStartWith('http://127.0.0.1:')

    const res = await fetch(servers.demo!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer something-from-the-agent', 'Mcp-Session-Id': 'sess-1' },
      body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBe('sess-9')
    expect(await res.json()).toEqual({ ok: true })
    expect(seen.map((s) => s.auth)).toEqual(['Bearer access-1', 'Bearer access-2'])
    expect(seen[1]).toMatchObject({ url: SERVER, body: '{"jsonrpc":"2.0","method":"tools/list","id":1}', session: 'sess-1' })

    // Only the exact address works: no guessing other sign-ins or paths.
    const base = servers.demo!.url.replace(/\/[^/]+\/demo$/, '')
    expect((await fetch(`${base}/wrong-key/demo`)).status).toBe(404)
    expect((await fetch(servers.demo!.url.replace(/demo$/, 'other'))).status).toBe(404)
  })
})
