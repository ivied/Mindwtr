import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import type { Task } from '../api/mindwtr-client'
import type { TelegramChatInfo, TelegramMessageInfo } from '../channels/telegram-user'
import { assistantAccess, assistantChat, formatQuestion, type AssistantRoutesDeps } from './assistant-routes'
import { mountAgentRunsRoutes, type AgentRunsMindwtr } from './routes'
import { AgentRunStore } from './store'
import type { ClaimedRun } from './types'

const task = (id: string): Task => ({
  id,
  title: 'Сверить  счёт за октябрь',
  status: 'inbox',
  contexts: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
})

const GROUP: TelegramChatInfo = { id: -5001, type: 'group', title: 'Агенты и ассистент', username: null }

let store: AgentRunStore
let app: Hono
let posted: Array<{ chatId: number; text: string }>
let created: Array<{ title: string; users: Array<number | string> }>
let account: AssistantRoutesDeps['account'] & { ready: boolean }

const RUNNER = { 'x-runner-token': 'runner-secret' }
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T
const claim = async () => (await json<{ items: ClaimedRun[] }>(post('/v1/agent-runs/claim', { runner: 'mac', capacity: 4 }, RUNNER))).items
const setup = (body: Record<string, unknown> = { title: GROUP.title, about: 'бухгалтерия и банк' }) => post('/v1/assistant/setup', body, RUNNER)

async function runningRun(): Promise<string> {
  await post('/v1/agent-runs', { taskId: `t-${Math.random()}` })
  return (await claim()).at(-1)!.run.id
}

beforeEach(() => {
  store = new AgentRunStore(new Database(':memory:'), () => new Date('2026-11-10T09:00:00Z'))
  posted = []
  created = []
  account = {
    ready: true,
    createGroup: mock(async (title: string, users: Array<number | string>) => {
      created.push({ title, users })
      return { ...GROUP, title }
    }),
    inviteLink: mock(async () => 'https://t.me/+invite'),
    chatInfo: mock(async (chat: number | string) => (chat === GROUP.id ? GROUP : { id: 42, type: 'user' as const, title: 'Someone', username: null })),
    history: mock(async (): Promise<TelegramMessageInfo[]> => []),
  }
  const mindwtr: AgentRunsMindwtr = {
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
    log: () => {},
    assistant: {
      account,
      bot: {
        username: async () => 'gtd_capture_bot',
        send: async (chatId, text) => {
          posted.push({ chatId, text })
          return { messageId: 900 + posted.length }
        },
      },
    },
  })
})

describe('setting the group up', () => {
  it('is for the operator only', async () => {
    expect((await post('/v1/assistant/setup', { title: 'x' })).status).toBe(403)
    expect(created).toEqual([])
  })

  it('creates the group with the bot, remembers it and registers the access', async () => {
    const res = await json<{ chat: { chatId: number }; inviteLink: string }>(setup())
    expect(created).toEqual([{ title: GROUP.title, users: ['gtd_capture_bot'] }])
    expect(res).toMatchObject({ chat: { chatId: GROUP.id, about: 'бухгалтерия и банк' }, inviteLink: 'https://t.me/+invite' })
    expect(assistantChat(store)).toEqual({ chatId: GROUP.id, title: GROUP.title, about: 'бухгалтерия и банк' })
    expect(store.getAccess('assistant')).toMatchObject({ status: 'active', scope: 'write', skill: 'assistant', hosts: [] })
    expect(store.getAccess('assistant')!.notes).toContain('бухгалтерия и банк')
  })

  it('binds an existing group, and only a group', async () => {
    expect((await setup({ chatId: 42 })).status).toBe(400)
    expect((await setup({ chatId: GROUP.id })).status).toBe(200)
    expect(created).toEqual([])
    expect(assistantChat(store)!.chatId).toBe(GROUP.id)
  })
})

describe('asking the assistant', () => {
  it('is closed until the group exists', async () => {
    const id = await runningRun()
    expect((await post('/v1/assistant/ask', { runId: id, text: 'Пришлите выписку' })).status).toBe(403)
    expect((await app.request('/v1/assistant/messages')).status).toBe(403)
  })

  it('posts as the bot to the fixed group, without a confirmation, naming the task', async () => {
    await setup()
    const id = await runningRun()
    const res = await post('/v1/assistant/ask', { runId: id, text: ' Пришлите, пожалуйста, выписку за октябрь. ', chat: 12345 })
    expect(await json<{ ok: boolean; left: number }>(res)).toMatchObject({ ok: true, messageId: 901, left: 4 })
    expect(posted).toHaveLength(1)
    // The chat comes from the server, whatever the request says.
    expect(posted[0]!.chatId).toBe(GROUP.id)
    expect(posted[0]!.text).toStartWith('Пришлите, пожалуйста, выписку за октябрь.\n\n— агент, по задаче «Сверить счёт за октябрь»')
  })

  it('takes only a task run that is running right now', async () => {
    await setup()
    expect((await post('/v1/assistant/ask', { text: 'x' })).status).toBe(403)
    expect((await post('/v1/assistant/ask', { runId: 'nope', text: 'x' })).status).toBe(403)
    const id = await runningRun()
    await post(`/v1/agent-runs/${id}/finish`, { state: 'done', result: { summary: 'готово' } }, RUNNER)
    expect((await post('/v1/assistant/ask', { runId: id, text: 'x' })).status).toBe(403)
    expect((await post('/v1/assistant/ask', { runId: await runningRun(), text: '' })).status).toBe(400)
    expect(posted).toEqual([])
  })

  it('caps the messages of one run', async () => {
    await setup()
    const id = await runningRun()
    for (let i = 0; i < 5; i++) expect((await post('/v1/assistant/ask', { runId: id, text: `вопрос ${i}` })).status).toBe(200)
    expect((await post('/v1/assistant/ask', { runId: id, text: 'ещё' })).status).toBe(429)
    expect(posted).toHaveLength(5)
  })

  it('reads the group and stops when the access is revoked', async () => {
    await setup()
    expect((await app.request('/v1/assistant/messages?limit=500')).status).toBe(200)
    expect(account.history).toHaveBeenCalledWith(GROUP.id, { limit: 100 })
    await post('/v1/agent-accesses/assistant/revoke')
    expect((await post('/v1/assistant/ask', { runId: await runningRun(), text: 'x' })).status).toBe(403)
    // A restart does not bring a revoked access back.
    expect(store.seedAccess(assistantAccess(assistantChat(store)!)).status).not.toBe('active')
  })
})

describe('the message the assistant sees', () => {
  it('ends with the task it is about', () => {
    expect(formatQuestion('Вопрос', 'Задача\nв две строки')).toBe(
      'Вопрос\n\n— агент, по задаче «Задача в две строки». Ответьте, пожалуйста, ответом на это сообщение.'
    )
  })
})
