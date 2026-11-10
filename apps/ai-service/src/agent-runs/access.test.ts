import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { AgentRunStore } from './store'
import { mountAgentRunsRoutes, sanitizeAccess, sanitizePending, type AgentRunsMindwtr } from './routes'
import type { AccessRecord, AgentRunRecord, ClaimedRun } from './types'
import type { Task } from '../api/mindwtr-client'

const task = (id: string): Task => ({
  id,
  title: 'Проверить отпуск в Remote',
  status: 'inbox',
  contexts: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
})

let clock: Date
let store: AgentRunStore
let app: Hono
let mindwtr: AgentRunsMindwtr

const RUNNER = { 'x-runner-token': 'runner-secret' }
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T
const claim = async () =>
  (await json<{ items: ClaimedRun[]; accesses: AccessRecord[] }>(post('/v1/agent-runs/claim', { runner: 'mac', capacity: 4 }, RUNNER)))
const finish = (id: string, body: unknown) => post(`/v1/agent-runs/${id}/finish`, body, RUNNER)
const list = () => json<{ items: AgentRunRecord[]; accesses: AccessRecord[] }>(app.request('/v1/agent-runs'))

const ACCESS = {
  name: 'remote',
  kind: 'http',
  scope: 'read',
  hosts: ['gateway.remote.com'],
  envVars: ['REMOTE_API_TOKEN'],
  skill: 'remote',
  notes: 'GET https://gateway.remote.com/v1/… с заголовком Bearer $REMOTE_API_TOKEN',
}

beforeEach(() => {
  clock = new Date('2026-11-10T09:00:00Z')
  store = new AgentRunStore(new Database(':memory:'), () => clock)
  mindwtr = {
    getTask: mock(async (id: string) => task(id)),
    listTasks: mock(async () => []),
    updateTask: mock(async (id: string) => task(id)),
    completeTask: mock(async (id: string) => task(id)),
    search: mock(async () => ({ tasks: [], projects: [] })),
  }
  app = new Hono()
  mountAgentRunsRoutes(app, {
    store,
    mindwtr,
    dailyBudgetUsd: 0,
    runnerToken: 'runner-secret',
    now: () => clock,
    log: () => {},
  })
})

/** Task run that has just asked for access to Remote. */
async function taskAskingForAccess(): Promise<string> {
  await post('/v1/agent-runs', { taskId: 't1' })
  const { items } = await claim()
  const id = items[0]!.run.id
  await finish(id, {
    state: 'confirm',
    pending: { kind: 'access', service: 'Remote', purpose: 'посмотреть остаток отпуска', scope: 'write' },
    sessionId: 'sess-task',
  })
  return id
}

describe('sanitizing what an agent reports', () => {
  it('keeps only well-formed names, hosts and variable names', () => {
    const a = sanitizeAccess({
      name: 'Remote Prod!',
      kind: 'teleport',
      scope: 'write',
      hosts: ['Gateway.Remote.com', 'https://evil.test/path', 'a b'],
      envVars: ['REMOTE_API_TOKEN', 'lower', 'PATH', 'AI_SERVICE_TOKEN'],
      mcpServer: '../x',
      skill: 'remote',
      notes: 'n',
    })!
    expect(a.name).toBe('remote-prod')
    expect(a.kind).toBe('other')
    expect(a.hosts).toEqual(['gateway.remote.com'])
    expect(a.envVars).toEqual(['REMOTE_API_TOKEN'])
    expect(a.mcpServer).toBe('')
    expect(sanitizeAccess({ name: '///' })).toBeNull()
  })

  it('refuses a secret request that would overwrite the agents own plumbing', () => {
    expect(sanitizePending({ kind: 'secret', name: 'REMOTE_API_TOKEN', label: 'Токен' })).toMatchObject({ kind: 'secret' })
    expect(sanitizePending({ kind: 'secret', name: 'AI_SERVICE_TOKEN', label: 'x' })).toBeNull()
    expect(sanitizePending({ kind: 'secret', name: 'PATH', label: 'x' })).toBeNull()
    expect(sanitizePending({ kind: 'secret', name: 'x y', label: 'x' })).toBeNull()
  })
})

describe('access request → provisioning → back to the task', () => {
  it('grants with a narrower scope, connects, registers and resumes the task run', async () => {
    const taskRun = await taskAskingForAccess()
    expect(store.get(taskRun)!.state).toBe('confirm')

    // The user narrows write → read.
    const granted = await json<{ run: AgentRunRecord; provision: AgentRunRecord }>(
      post(`/v1/agent-runs/${taskRun}/access`, { decision: 'grant', scope: 'read' })
    )
    expect(granted.provision.kind).toBe('provision')
    expect(granted.provision.taskDescription).toContain('только чтение')
    expect(granted.run.pending).toMatchObject({ kind: 'access', scope: 'read', provisionRunId: granted.provision.id })
    // Granting twice does not start a second provisioning run.
    await post(`/v1/agent-runs/${taskRun}/access`, { decision: 'grant' })
    expect((await list()).items).toHaveLength(2)

    // The provisioning agent asks for the key.
    const prov = granted.provision.id
    expect((await claim()).items.map((c) => c.run.id)).toEqual([prov])
    await finish(prov, {
      state: 'question',
      pending: { kind: 'secret', name: 'REMOTE_API_TOKEN', label: 'API-токен Remote', hint: 'Settings → API', url: 'https://remote.com/keys' },
      sessionId: 'sess-prov',
    })
    expect(store.get(prov)!.pending).toMatchObject({ kind: 'secret', name: 'REMOTE_API_TOKEN' })

    // The user types it: it reaches the runner once and never the event log.
    expect((await post(`/v1/agent-runs/${prov}/secret`, { value: 'ra_live_SECRET' })).status).toBe(200)
    const events = JSON.stringify(store.listEvents(prov))
    expect(events).not.toContain('ra_live_SECRET')
    expect(events).toContain('REMOTE_API_TOKEN')
    const resumed = await claim()
    expect(resumed.items[0]!.secrets).toEqual([{ name: 'REMOTE_API_TOKEN', value: 'ra_live_SECRET' }])
    expect(resumed.items[0]!.reply!.text).not.toContain('ra_live_SECRET')

    // Connected: registered, and the task run is re-queued with the news.
    await finish(prov, { state: 'done', result: { summary: 'Подключено', evidence: ['GET /v1/employments → 200'], access: ACCESS } })
    const after = await list()
    expect(after.accesses).toHaveLength(1)
    expect(after.accesses[0]).toMatchObject({ name: 'remote', scope: 'read', status: 'active', envVars: ['REMOTE_API_TOKEN'] })
    expect(store.get(taskRun)!.state).toBe('queued')
    const back = await claim()
    expect(back.items[0]!.run.id).toBe(taskRun)
    expect(back.items[0]!.reply).toMatchObject({ kind: 'answer' })
    expect(back.items[0]!.reply!.text).toContain('remote')
    expect(back.items[0]!.secrets).toEqual([])
    expect(back.accesses.map((a) => a.name)).toEqual(['remote'])

    // Closing the provisioning card touches no task.
    const accepted = await json<{ applied: boolean }>(post(`/v1/agent-runs/${prov}/accept`, {}))
    expect(accepted.applied).toBe(false)
    expect(mindwtr.updateTask).not.toHaveBeenCalled()
  })

  it('denying sends the task run on without the access', async () => {
    const taskRun = await taskAskingForAccess()
    await post(`/v1/agent-runs/${taskRun}/access`, { decision: 'deny' })
    const { items } = await claim()
    expect(items[0]!.run.id).toBe(taskRun)
    expect(items[0]!.reply).toMatchObject({ kind: 'reject' })
    expect((await list()).items.filter((r) => r.kind === 'provision')).toHaveLength(0)
  })

  it('a provisioning run that fails or is closed releases the waiting task run', async () => {
    const taskRun = await taskAskingForAccess()
    const { provision } = await json<{ provision: AgentRunRecord }>(
      post(`/v1/agent-runs/${taskRun}/access`, { decision: 'grant' })
    )
    await claim()
    await finish(provision.id, { state: 'done', result: { summary: 'У сервиса нет API' } })
    expect((await list()).accesses).toHaveLength(0)
    const parent = store.get(taskRun)!
    expect(parent.state).toBe('queued')
    const back = await claim()
    expect(back.items[0]!.reply).toMatchObject({ kind: 'reject' })
    expect(back.items[0]!.reply!.text).toContain('нет API')
  })

  it('starts a provisioning run directly from the access list', async () => {
    const res = await json<{ enqueued: number; items: AgentRunRecord[] }>(
      post('/v1/agent-runs', { provision: { service: 'Hetzner prod', scope: 'read' } })
    )
    expect(res.enqueued).toBe(1)
    expect(res.items[0]).toMatchObject({ kind: 'provision', taskId: 'access:hetzner-prod', parentRunId: null })
  })
})

describe('who may do what', () => {
  it('only a provisioning run can ask for a secret or register an access', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const id = (await claim()).items[0]!.run.id
    const asked = await finish(id, { state: 'question', pending: { kind: 'secret', name: 'REMOTE_API_TOKEN', label: 'x' } })
    expect(asked.status).toBe(400)
    await finish(id, { state: 'done', result: { summary: 'готово', access: ACCESS } })
    expect(store.get(id)!.result!.access).toBeUndefined()
    expect(store.listAccesses()).toHaveLength(0)
  })

  it('runner endpoints need the runner token; a secret is refused unless asked for', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    expect((await post('/v1/agent-runs/claim', { runner: 'x', capacity: 1 })).status).toBe(403)
    const id = (await claim()).items[0]!.run.id
    expect((await post(`/v1/agent-runs/${id}/events`, { events: [] })).status).toBe(403)
    expect((await post(`/v1/agent-runs/${id}/finish`, { state: 'done' })).status).toBe(403)
    expect((await post(`/v1/agent-runs/${id}/secret`, { value: 'abc' })).status).toBe(409)
  })
})

describe('revoking', () => {
  it('goes active → revoking (runner cleans the host) → revoked', async () => {
    store.upsertAccess({ ...ACCESS, kind: 'http', scope: 'read', mcpServer: '' }, null)
    await post('/v1/agent-accesses/remote/revoke')
    expect((await claim()).accesses[0]).toMatchObject({ name: 'remote', status: 'revoking' })
    expect((await post('/v1/agent-accesses/remote/revoked')).status).toBe(403)
    await post('/v1/agent-accesses/remote/revoked', {}, RUNNER)
    expect((await list()).accesses).toHaveLength(0)
    expect(store.getAccess('remote')!.status).toBe('revoked')
  })
})

describe('browser sign-in owned by the runner', () => {
  const OAUTH = {
    kind: 'oauth',
    name: 'remote',
    label: 'Remote.com',
    url: 'https://api.example.com/oauth/authorize?client_id=abc&state=st4te-st4te-st4te-st4te',
    state: 'st4te-st4te-st4te-st4te',
    hint: 'Войдите под аккаунтом контрактора',
    local: true,
  }
  const provision = async () => {
    await post('/v1/agent-runs', { provision: { service: 'Remote', scope: 'read' } })
    return (await claim()).items[0]!.run.id
  }

  it('only a provisioning run may ask for a sign-in, and the request is validated', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const taskRun = (await claim()).items[0]!.run.id
    expect((await finish(taskRun, { state: 'question', pending: OAUTH })).status).toBe(400)
    expect(sanitizePending({ ...OAUTH, url: 'http://insecure.example/authorize' })).toBeNull()
    expect(sanitizePending({ ...OAUTH, name: '../etc' })).toBeNull()
    expect(sanitizePending({ ...OAUTH, state: 'short' })).toBeNull()
  })

  it('takes the code from the browser, hands it to the runner once, and resumes the run', async () => {
    const id = await provision()
    expect((await finish(id, { state: 'question', pending: OAUTH, sessionId: 's1' })).status).toBe(200)

    // No token is needed on the callback, but the state must match a waiting run.
    expect((await app.request('/oauth/callback?code=c0de&state=wrong-wrong-wrong-wrong')).status).toBe(404)
    const ok = await app.request(`/oauth/callback?code=c0de-123&state=${OAUTH.state}`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Вход выполнен')
    // The same link cannot be replayed.
    expect((await app.request(`/oauth/callback?code=other&state=${OAUTH.state}`)).status).toBe(404)

    const resumed = (await claim()).items[0]!
    expect(resumed.run.id).toBe(id)
    expect(resumed.secrets).toEqual([{ name: 'oauth-code:remote', value: 'c0de-123' }])
    // The code is not in anything the UI can read.
    expect(JSON.stringify(await list())).not.toContain('c0de-123')
    expect(JSON.stringify(await json(app.request(`/v1/agent-runs/${id}`)))).not.toContain('c0de-123')
  })

  it('accepts the address pasted from another device, for this run only', async () => {
    const id = await provision()
    await finish(id, { state: 'question', pending: OAUTH, sessionId: 's1' })
    const pasted = `http://127.0.0.1:47823/callback?code=pasted-c0de&expires_in=59&state=${OAUTH.state}`
    expect((await post(`/v1/agent-runs/${id}/sign-in`, { url: 'не адрес' })).status).toBe(400)
    expect((await post('/v1/agent-runs/other-run/sign-in', { url: pasted })).status).toBe(400)
    expect((await post(`/v1/agent-runs/${id}/sign-in`, { url: pasted })).status).toBe(200)
    expect((await claim()).items[0]!.secrets).toEqual([{ name: 'oauth-code:remote', value: 'pasted-c0de' }])
  })

  it('tells the agent when the service refused the sign-in', async () => {
    const id = await provision()
    await finish(id, { state: 'question', pending: OAUTH, sessionId: 's1' })
    const res = await app.request(`/oauth/callback?error=access_denied&state=${OAUTH.state}`)
    expect(res.status).toBe(400)
    const resumed = (await claim()).items[0]!
    expect(resumed.secrets).toEqual([])
    expect(resumed.reply?.text).toContain('access_denied')
  })
})
