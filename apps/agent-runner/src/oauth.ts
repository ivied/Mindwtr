/**
 * Sign-ins the runner owns.
 *
 * Services that only offer a browser sign-in (OAuth, as remote MCP servers do)
 * are connected here, not through Claude Code's own credential store: that one
 * is shared with every interactive session on the host and tied to the Claude
 * account. The runner registers itself as an OAuth client, keeps the tokens in
 * its own folder, refreshes them, and hands the service to the agents through
 * a local proxy that adds the current token to every request. Losing or
 * switching the Claude account leaves all of this intact.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_OAUTH_DIR = join(homedir(), '.config', 'gtd-agents', 'oauth')
export const OAUTH_NAME = /^[a-z][a-z0-9-]{1,30}$/
/** Secret name the server uses to hand over the authorization code for a sign-in. */
export const OAUTH_CODE_PREFIX = 'oauth-code:'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

interface Tokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms; 0 = unknown. */
  expiresAt: number
  scope: string
}

interface Entry {
  name: string
  serverUrl: string
  resource: string
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** A sign-in in progress: what is needed to redeem the code. */
  pending: { state: string; codeVerifier: string } | null
  tokens: Tokens | null
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function getJson(fetchFn: Fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Where a server's sign-in lives: RFC 9728 resource metadata, then RFC 8414 server metadata. */
export async function discover(
  serverUrl: string,
  fetchFn: Fetch = fetch
): Promise<{ resource: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string; scopes: string[] }> {
  const url = new URL(serverUrl)
  const path = url.pathname.replace(/\/$/, '')
  const prm =
    (await getJson(fetchFn, `${url.origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await getJson(fetchFn, `${url.origin}/.well-known/oauth-protected-resource`))
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]).filter((s) => typeof s === 'string') : []
  const issuer = new URL((servers[0] as string | undefined) ?? url.origin)
  const issuerPath = issuer.pathname.replace(/\/$/, '')
  const meta =
    (await getJson(fetchFn, `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`)) ??
    (await getJson(fetchFn, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`)) ??
    (issuerPath ? await getJson(fetchFn, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`) : null)
  if (!meta) throw new Error(`сервер входа ${issuer.origin} не публикует метаданные OAuth`)
  const authorizationEndpoint = str(meta.authorization_endpoint)
  const tokenEndpoint = str(meta.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error('в метаданных OAuth нет адресов авторизации и выдачи токенов')
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : ['S256']
  if (!methods.includes('S256')) throw new Error('сервер входа не поддерживает PKCE S256')
  const scopes = Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string') : []
  return {
    resource: str(prm?.resource) || serverUrl,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(meta.registration_endpoint),
    scopes,
  }
}

export class OAuthVault {
  private refreshing = new Map<string, Promise<string>>()

  constructor(
    private dir: string = DEFAULT_OAUTH_DIR,
    private fetchFn: Fetch = fetch,
    private now: () => number = Date.now
  ) {}

  private file(name: string): string {
    if (!OAUTH_NAME.test(name)) throw new Error(`недопустимое имя входа: ${name}`)
    return join(this.dir, `${name}.json`)
  }

  private read(name: string): Entry | null {
    try {
      return JSON.parse(readFileSync(this.file(name), 'utf8')) as Entry
    } catch {
      return null
    }
  }

  private write(entry: Entry): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = this.file(entry.name)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, target)
  }

  /** Names of sign-ins that have tokens, with the server each one talks to. */
  ready(): Array<{ name: string; serverUrl: string }> {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(f.slice(0, -5)))
      .filter((e): e is Entry => !!e && !!e.tokens)
      .map((e) => ({ name: e.name, serverUrl: e.serverUrl }))
  }

  has(name: string): boolean {
    return !!this.read(name)?.tokens
  }

  remove(name: string): void {
    rmSync(this.file(name), { force: true })
  }

  /**
   * Start a sign-in: find the server's OAuth endpoints, register this runner
   * as a client, and return the link the user has to open.
   */
  async begin(
    name: string,
    serverUrl: string,
    redirectUris: string | string[]
  ): Promise<{ url: string; state: string; redirectUri: string }> {
    const candidates = (Array.isArray(redirectUris) ? redirectUris : [redirectUris]).filter(Boolean)
    if (!candidates.length) throw new Error('не задан адрес возврата после входа')
    this.file(name) // rejects a bad name before anything goes over the network
    if (!/^https:\/\//.test(serverUrl)) throw new Error('адрес сервера должен начинаться с https://')
    const info = await discover(serverUrl, this.fetchFn)
    const prev = this.read(name)
    const reusable = prev && prev.serverUrl === serverUrl && candidates.includes(prev.redirectUri)
    let clientId = reusable ? prev.clientId : ''
    let clientSecret = reusable ? prev.clientSecret : ''
    let redirectUri = reusable ? prev.redirectUri : ''
    if (!clientId) {
      if (!info.registrationEndpoint) throw new Error('сервер входа не поддерживает регистрацию клиента (dynamic client registration)')
      // Some services only allow a return address on this computer: try the
      // public one first, then the local ones.
      let refusal = ''
      for (const candidate of candidates) {
        const res = await this.fetchFn(info.registrationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_name: 'GTD agents',
            redirect_uris: [candidate],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        if (res.ok && str(body.client_id)) {
          clientId = str(body.client_id)
          clientSecret = str(body.client_secret)
          redirectUri = candidate
          break
        }
        refusal = `${res.status}: ${str(body.error_description) || str(body.error)}`
      }
      if (!clientId) throw new Error(`регистрация клиента не удалась (${refusal})`)
    }
    const state = b64url(randomBytes(24))
    const codeVerifier = b64url(randomBytes(48))
    const url = new URL(info.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(codeVerifier).digest()))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('resource', info.resource)
    if (info.scopes.length) url.searchParams.set('scope', info.scopes.join(' '))
    this.write({
      name,
      serverUrl,
      resource: info.resource,
      tokenEndpoint: info.tokenEndpoint,
      clientId,
      clientSecret,
      redirectUri,
      pending: { state, codeVerifier },
      // A repeated sign-in keeps the old tokens until the new ones arrive.
      tokens: prev && prev.serverUrl === serverUrl ? prev.tokens : null,
    })
    return { url: url.toString(), state, redirectUri }
  }

  private async token(entry: Entry, params: Record<string, string>): Promise<Tokens> {
    const form = new URLSearchParams({ ...params, client_id: entry.clientId, resource: entry.resource })
    if (entry.clientSecret) form.set('client_secret', entry.clientSecret)
    const res = await this.fetchFn(entry.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const accessToken = str(body.access_token)
    if (!res.ok || !accessToken) {
      throw new Error(`сервер входа ответил ${res.status}: ${str(body.error_description) || str(body.error) || 'нет токена'}`)
    }
    const ttl = Number(body.expires_in)
    return {
      accessToken,
      // Servers that do not rotate refresh tokens omit it: keep the one we have.
      refreshToken: str(body.refresh_token) || params.refresh_token || '',
      expiresAt: Number.isFinite(ttl) && ttl > 0 ? this.now() + ttl * 1000 : 0,
      scope: str(body.scope),
    }
  }

  /** Redeem the code the browser brought back. */
  async complete(name: string, code: string): Promise<{ scope: string }> {
    const entry = this.read(name)
    if (!entry?.pending) throw new Error(`для «${name}» нет начатого входа`)
    const tokens = await this.token(entry, {
      grant_type: 'authorization_code',
      code,
      code_verifier: entry.pending.codeVerifier,
      redirect_uri: entry.redirectUri,
    })
    this.write({ ...entry, pending: null, tokens })
    return { scope: tokens.scope }
  }

  /** A token that is good for at least a minute; refreshed when it is not (or when `force`). */
  async accessToken(name: string, force = false): Promise<string> {
    const entry = this.read(name)
    if (!entry?.tokens) throw new Error(`вход «${name}» не выполнен`)
    const fresh = entry.tokens.expiresAt === 0 || entry.tokens.expiresAt - this.now() > 60_000
    if (fresh && !force) return entry.tokens.accessToken
    if (!entry.tokens.refreshToken) {
      if (!force) return entry.tokens.accessToken
      throw new Error(`вход «${name}» истёк, нужен повторный вход`)
    }
    // Refresh tokens are often single-use: never run two refreshes at once.
    const running = this.refreshing.get(name)
    if (running) return running
    const job = (async () => {
      const latest = this.read(name)
      if (!latest?.tokens) throw new Error(`вход «${name}» не выполнен`)
      const tokens = await this.token(latest, { grant_type: 'refresh_token', refresh_token: latest.tokens.refreshToken })
      this.write({ ...latest, tokens })
      return tokens.accessToken
    })().finally(() => this.refreshing.delete(name))
    this.refreshing.set(name, job)
    return job
  }
}

/** Return address on this computer, for services that refuse a public one. */
export const LOOPBACK_PORT = 47823
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`

/**
 * Catches a sign-in that comes back to this computer and passes it on to the
 * server, which knows the run that is waiting for it. Used when the browser
 * runs on the same machine as the runner; from another device the user pastes
 * the address into the card instead.
 */
export function startLoopbackCallback(serverUrl: string, log: (msg: string) => void = () => {}): { stop(): void } | null {
  try {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: LOOPBACK_PORT,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== '/callback') return new Response('not found', { status: 404 })
        try {
          const res = await fetch(`${serverUrl.replace(/\/$/, '')}/oauth/callback${url.search}`, { signal: AbortSignal.timeout(20_000) })
          return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        } catch (err) {
          return new Response(`Не удалось передать вход серверу: ${(err as Error).message}`, { status: 502 })
        }
      },
    })
    return { stop: () => server.stop(true) }
  } catch (err) {
    log(`sign-in callback listener not started: ${(err as Error).message}`)
    return null
  }
}

const HOP_HEADERS = new Set(['host', 'authorization', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding'])

/**
 * Local door to the signed-in services: `http://127.0.0.1:<port>/<key>/<name>`
 * forwards to the service with the current token. The agents get this address
 * as a plain MCP server; they never see a token.
 */
export class OAuthProxy {
  private server: ReturnType<typeof Bun.serve> | null = null
  private key = b64url(randomBytes(18))

  constructor(
    private vault: OAuthVault,
    private fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch
  ) {}

  private start(): void {
    if (this.server) return
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0, // event streams stay open
      fetch: (req) => this.handle(req),
    })
  }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }

  /** MCP server entries for the agent, one per signed-in service. */
  mcpServers(): Record<string, { type: 'http'; url: string }> {
    const ready = this.vault.ready()
    if (!ready.length) return {}
    this.start()
    const base = `http://127.0.0.1:${this.server!.port}/${this.key}`
    return Object.fromEntries(ready.map((e) => [e.name, { type: 'http' as const, url: `${base}/${e.name}` }]))
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const [, key, name, ...rest] = url.pathname.split('/')
    const target = key === this.key && name ? this.vault.ready().find((e) => e.name === name) : undefined
    if (!target) return new Response('not found', { status: 404 })
    const upstream = target.serverUrl.replace(/\/$/, '') + (rest.length ? `/${rest.join('/')}` : '') + url.search
    const headers = new Headers()
    req.headers.forEach((value, header) => {
      if (!HOP_HEADERS.has(header.toLowerCase())) headers.set(header, value)
    })
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    try {
      let res: Response | null = null
      for (const force of [false, true]) {
        headers.set('Authorization', `Bearer ${await this.vault.accessToken(name!, force)}`)
        res = await this.fetchFn(upstream, { method: req.method, headers, body, signal: req.signal })
        if (res.status !== 401) break
      }
      const out = new Headers(res!.headers)
      // fetch already decoded the body; a 401 must not start Claude Code's own sign-in.
      out.delete('content-encoding')
      out.delete('content-length')
      out.delete('www-authenticate')
      const status = res!.status === 401 ? 502 : res!.status
      return new Response(res!.body, { status, headers: out })
    } catch (err) {
      return new Response(JSON.stringify({ error: `вход «${name}»: ${(err as Error).message}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
}
