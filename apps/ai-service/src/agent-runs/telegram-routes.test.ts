import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { TelegramChatNotFoundError, type TelegramChatInfo, type TelegramMessageInfo } from '../channels/telegram-user'
import type { Task } from '../api/mindwtr-client'
import { mountAgentRunsRoutes, type AgentRunsMindwtr } from './routes'
import { AgentRunStore } from './store'
import { TELEGRAM_ACCESS, sendRefusal, targetNamesChat, type TelegramAgentApi } from './telegram-routes'
import type { AccessRecord, AgentRunRecord, ClaimedRun } from './types'

const task = (id: string): Task => ({
  id,
  title: 'Ответить Анне про встречу',
  status: 'inbox',
  contexts: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
})

const ANNA: TelegramChatInfo = { id: 123456789, type: 'user', title: 'Anna Example', username: 'anna_example' }
const TEAM: TelegramChatInfo = { id: -1001234567890, type: 'supergroup', title: 'Team Chat', username: null }
const CHATS = [ANNA, TEAM]

const message = (over: Partial<TelegramMessageInfo> = {}): TelegramMessageInfo => ({
  id: 77,
  date: '2026-11-10T08:00:00.000Z',
  chatId: ANNA.id,
  chatTitle: ANNA.title,
  from: ANNA.title,
  fromId: ANNA.id,
  outgoing: false,
  text: 'Во сколько созвон?',
  replyTo: null,
  media: null,
  ...over,
})

let store: AgentRunStore
let app: Hono
let sent: Array<{ chat: number | string; text: string; replyTo?: number }>
let telegram: TelegramAgentApi & { ready: boolean; failSend: boolean }

const RUNNER = { 'x-runner-token': 'runner-secret' }
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = (path: string) => app.request(path)
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T
const claim = async () => (await json<{ items: ClaimedRun[]; accesses: AccessRecord[] }>(post('/v1/agent-runs/claim', { runner: 'mac', capacity: 4 }, RUNNER))).items
const finish = (id: string, body: unknown) => post(`/v1/agent-runs/${id}/finish`, body, RUNNER)
const send = (body: Record<string, unknown>) => post('/v1/telegram/send', body)

const find = (chat: number | string): TelegramChatInfo => {
  const hit = CHATS.find((c) => c.id === chat || c.username === chat)
  if (!hit) throw new TelegramChatNotFoundError(chat)
  return hit
}

beforeEach(() => {
  store = new AgentRunStore(new Database(':memory:'), () => new Date('2026-11-10T09:00:00Z'))
  sent = []
  telegram = {
    ready: true,
    failSend: false,
    listChats: mock(async ({ query }: { query?: string }) =>
      CHATS.filter((c) => !query || c.title.toLowerCase().includes(query.toLowerCase())).map((c) => ({
        ...c,
        unread: 1,
        muted: false,
        archived: false,
        lastMessage: null,
      }))
    ),
    chatInfo: mock(async (chat: number | string) => find(chat)),
    history: mock(async (chat: number | string) => [message({ chatId: find(chat).id })]),
    search: mock(async () => [message()]),
    send: mock(async (chat: number | string, text: string, replyTo?: number) => {
      if (telegram.failSend) throw new Error('FLOOD_WAIT_30')
      sent.push({ chat, text, ...(replyTo ? { replyTo } : {}) })
      return message({ id: 501, outgoing: true, text, chatId: find(chat).id })
    }),
  }
  const mindwtr: AgentRunsMindwtr = {
    getTask: mock(async (id: string) => task(id)),
    listTasks: mock(async () => []),
    updateTask: mock(async (id: string) => task(id)),
    completeTask: mock(async (id: string) => task(id)),
    search: mock(async () => ({ tasks: [], projects: [] })),
  }
  app = new Hono()
  mountAgentRunsRoutes(app, { store, mindwtr, dailyBudgetUsd: 0, runnerToken: 'runner-secret', telegram, log: () => {} })
  store.seedAccess(TELEGRAM_ACCESS)
})

const DRAFT = 'Привет! Созвон в 15:00, ссылку пришлю за десять минут.'

/** A task run parked on a confirmation to message Anna; returns its id. */
async function runAwaitingConfirmation(target = 'Anna Example (id 123456789)', draft = DRAFT): Promise<string> {
  await post('/v1/agent-runs', { taskId: `t-${Math.random()}` })
  const id = (await claim()).at(-1)!.run.id
  await finish(id, { state: 'confirm', pending: { kind: 'confirm', action: 'Отправить сообщение в Telegram', target, draft }, sessionId: 's1' })
  return id
}

/** …and the user approved it, and the runner picked the run up again. */
async function approvedRun(target?: string, draft?: string): Promise<string> {
  const id = await runAwaitingConfirmation(target, draft)
  await post(`/v1/agent-runs/${id}/reply`, { kind: 'approve' })
  await claim()
  return id
}

describe('reading', () => {
  it('lists chats, reads one and searches', async () => {
    const chats = await json<{ items: Array<{ id: number; title: string }> }>(get('/v1/telegram/chats?q=team'))
    expect(chats.items.map((c) => c.id)).toEqual([TEAM.id])

    const history = await json<{ chat: TelegramChatInfo; items: TelegramMessageInfo[] }>(
      get(`/v1/telegram/chats/${TEAM.id}/messages?limit=500&before=90`)
    )
    expect(history.chat.title).toBe('Team Chat')
    expect(telegram.history).toHaveBeenCalledWith(TEAM.id, { limit: 100, beforeId: 90 })

    expect((await get('/v1/telegram/search')).status).toBe(400)
    await get(`/v1/telegram/search?q=${encodeURIComponent('созвон')}&chat=@anna_example`)
    expect(telegram.search).toHaveBeenCalledWith({ query: 'созвон', chat: 'anna_example', limit: 20 })
  })

  it('explains an unknown or malformed chat', async () => {
    expect((await get('/v1/telegram/chats/999/messages')).status).toBe(404)
    expect((await get('/v1/telegram/chats/+79990000000/messages')).status).toBe(400)
  })

  it('answers 503 while the account is not signed in', async () => {
    telegram.ready = false
    expect((await get('/v1/telegram/chats')).status).toBe(503)
  })
})

describe('sending needs the confirmation the user approved', () => {
  it('refuses without an approval and while the confirmation is still waiting', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const running = (await claim())[0]!.run.id
    expect((await send({ runId: running, chat: ANNA.id, text: DRAFT })).status).toBe(403)

    const waiting = await runAwaitingConfirmation()
    expect((await send({ runId: waiting, chat: ANNA.id, text: DRAFT })).status).toBe(403)
    expect((await send({ chat: ANNA.id, text: DRAFT })).status).toBe(400)
    expect((await send({ runId: 'no-such-run', chat: ANNA.id, text: DRAFT })).status).toBe(403)
    expect(sent).toEqual([])
  })

  it('sends the approved text to the approved chat, once', async () => {
    const id = await approvedRun()
    const res = await send({ runId: id, chat: ANNA.id, text: `${DRAFT}\r\n`, replyTo: 77 })
    expect(res.status).toBe(200)
    expect(await json<{ ok: boolean; message: { id: number } }>(res)).toMatchObject({ ok: true, message: { id: 501 } })
    expect(sent).toEqual([{ chat: ANNA.id, text: `${DRAFT}\r\n`, replyTo: 77 }])

    // The approval is spent: the same request again is refused.
    expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(403)
    expect(sent).toHaveLength(1)
  })

  it('refuses another text or another chat than the user saw', async () => {
    const id = await approvedRun()
    expect((await send({ runId: id, chat: ANNA.id, text: `${DRAFT} И захвати договор.` })).status).toBe(403)
    const wrongChat = await send({ runId: id, chat: TEAM.id, text: DRAFT })
    expect(wrongChat.status).toBe(403)
    expect((await json<{ error: string }>(wrongChat)).error).toContain('Team Chat')
    expect(sent).toEqual([])
    // Neither attempt used the approval up.
    expect((await send({ runId: id, chat: '@anna_example', text: DRAFT })).status).toBe(200)
  })

  it('an answer, a rejection or a plain message approves nothing', async () => {
    for (const kind of ['reject', 'message', 'answer']) {
      const id = await runAwaitingConfirmation()
      await post(`/v1/agent-runs/${id}/reply`, { kind, text: 'не сейчас' })
      await claim()
      expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(403)
    }
    expect(sent).toEqual([])
  })

  it('the approval lasts one turn', async () => {
    const id = await approvedRun()
    await finish(id, { state: 'question', pending: { kind: 'question', question: 'Точно?', options: [] } })
    await post(`/v1/agent-runs/${id}/reply`, { kind: 'answer', text: 'да' })
    await claim()
    expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(403)
  })

  it('keeps the approval when Telegram itself failed', async () => {
    const id = await approvedRun()
    telegram.failSend = true
    expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(502)
    telegram.failSend = false
    expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(200)
  })
})

describe('the registry row is the switch', () => {
  it('read scope reads but never sends', async () => {
    store.upsertAccess({ ...TELEGRAM_ACCESS, scope: 'read' }, null)
    const id = await approvedRun()
    expect((await get('/v1/telegram/chats')).status).toBe(200)
    expect((await send({ runId: id, chat: ANNA.id, text: DRAFT })).status).toBe(403)
    expect(sent).toEqual([])
  })

  it('a revoked access closes every route and survives a restart', async () => {
    await post('/v1/agent-accesses/telegram/revoke')
    expect((await get('/v1/telegram/chats')).status).toBe(403)
    await post('/v1/agent-accesses/telegram/revoked', {}, RUNNER)
    expect(store.seedAccess(TELEGRAM_ACCESS).status).toBe('revoked')
    expect((await get(`/v1/telegram/chats/${ANNA.id}/messages`)).status).toBe(403)
  })

  it('asking for it again switches it on without a provisioning run', async () => {
    await post('/v1/agent-accesses/telegram/revoke')
    const direct = await json<{ enqueued: number; access: AccessRecord }>(post('/v1/agent-runs', { provision: { service: 'Telegram', scope: 'read' } }))
    expect(direct).toMatchObject({ enqueued: 0, access: { name: 'telegram', status: 'active', scope: 'read' } })

    // A task agent asks, the user grants: the run goes straight back to work.
    await post('/v1/agent-runs', { taskId: 't9' })
    const id = (await claim())[0]!.run.id
    await finish(id, { state: 'confirm', pending: { kind: 'access', service: 'Telegram', purpose: 'ответить Анне', scope: 'write' } })
    const granted = await json<{ run: AgentRunRecord; provision?: AgentRunRecord }>(post(`/v1/agent-runs/${id}/access`, { decision: 'grant' }))
    expect(granted.provision).toBeUndefined()
    expect(granted.run.state).toBe('queued')
    expect(store.getAccess('telegram')).toMatchObject({ status: 'active', scope: 'write' })
    // Some other Telegram-flavoured service is still a job for a provisioning run.
    const other = await json<{ enqueued: number }>(post('/v1/agent-runs', { provision: { service: 'Telegram Bot API для рассылки' } }))
    expect(other.enqueued).toBe(1)
  })
})

describe('matching what the user saw', () => {
  it('finds the chat in the target by id, username or title', () => {
    expect(targetNamesChat('Anna Example (id 123456789)', ANNA)).toBe(true)
    expect(targetNamesChat('@Anna_Example', ANNA)).toBe(true)
    expect(targetNamesChat('личка: anna example', ANNA)).toBe(true)
    expect(targetNamesChat('Team Chat (id -1001234567890)', TEAM)).toBe(true)
    expect(targetNamesChat('id 1234567890', ANNA)).toBe(false)
    expect(targetNamesChat('@anna_example_fake', ANNA)).toBe(false)
    expect(targetNamesChat('Борис', ANNA)).toBe(false)
  })

  it('names the reason for a refusal', () => {
    const confirm = { kind: 'confirm' as const, action: 'a', target: 'Anna Example', draft: 'текст' }
    expect(sendRefusal(null, ANNA, 'текст')).toContain('request_confirmation')
    expect(sendRefusal(confirm, ANNA, 'другой текст')).toContain('отличается')
    expect(sendRefusal(confirm, TEAM, 'текст')).toContain('Team Chat')
    expect(sendRefusal(confirm, ANNA, '  текст\n')).toBeNull()
  })
})
