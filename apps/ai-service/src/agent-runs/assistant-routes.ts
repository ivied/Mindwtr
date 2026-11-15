/**
 * The assistant chat — a Telegram group of the user, their human assistant and
 * the bot, where inbox agents ask the assistant for data or for something to be
 * done in a service the agents themselves cannot reach.
 *
 *   POST /v1/assistant/setup  { title?, chatId?, about? }  create or bind the group (runner token)
 *   GET  /v1/assistant/messages?limit=                     recent messages of the group
 *   POST /v1/assistant/ask    { runId, text }              post a question as the bot
 *
 * Unlike /v1/telegram/send this needs no confirmation: the user decided that
 * agents may write to this one group on their own. What keeps it narrow is
 * that the chat is fixed on the server (an agent cannot name another one), the
 * message goes out as the bot and not as the user, only a task run that is
 * running right now may post, and a run gets a handful of messages.
 *
 * The agent does not wait for the answer: it asks and ends its run. The answer
 * is read later through GET, and it also reaches captured context because the
 * user's own account sits in the group.
 */

import type { Context, Hono } from 'hono'
import type { TelegramChatInfo, TelegramChatRef, TelegramMessageInfo } from '../channels/telegram-user'
import type { AgentRunStore } from './store'
import type { AccessSpec } from './types'

export interface AssistantChat {
  chatId: number
  title: string
  /** What the assistant can be asked for, in the user's words. */
  about: string
}

export interface AssistantRoutesDeps {
  store: AgentRunStore
  /** The bot: the voice of the agents in the group. */
  bot: {
    username(): Promise<string>
    send(chatId: number, text: string): Promise<{ messageId: number }>
  }
  /** The user's account: creates the group and reads it. */
  account: {
    readonly ready: boolean
    createGroup(title: string, users: TelegramChatRef[]): Promise<TelegramChatInfo>
    inviteLink(chat: TelegramChatRef): Promise<string>
    chatInfo(chat: TelegramChatRef): Promise<TelegramChatInfo>
    history(chat: TelegramChatRef, opts: { limit?: number }): Promise<TelegramMessageInfo[]>
  }
  /** Setting the group up is for the operator, not for agents or the web UI. */
  runnerToken?: string
  /** Messages one run may post. Default 5. */
  maxPerRun?: number
  log?: (msg: string) => void
}

export const ASSISTANT_ACCESS_NAME = 'assistant'
const META_KEY = 'assistant_chat'
const MAX_TEXT = 3500

export function assistantChat(store: AgentRunStore): AssistantChat | null {
  try {
    const raw = JSON.parse(store.getMeta(META_KEY) ?? 'null') as Partial<AssistantChat> | null
    return raw && Number.isInteger(raw.chatId) ? { chatId: raw.chatId!, title: raw.title ?? '', about: raw.about ?? '' } : null
  } catch {
    return null
  }
}

/** The registry row; `hosts` empty on purpose, as for Telegram. */
export function assistantAccess(chat: AssistantChat): AccessSpec {
  return {
    name: ASSISTANT_ACCESS_NAME,
    kind: 'http',
    scope: 'write',
    hosts: [],
    envVars: [],
    mcpServer: '',
    skill: 'assistant',
    notes:
      `Живой ассистент пользователя в Telegram-группе «${chat.title}». Когда данные или действие находятся в сервисе, к которому у агентов нет доступа, ` +
      `спроси ассистента: POST $AI_SERVICE_URL/v1/assistant/ask (без подтверждения), затем заверши прогон со статусом waiting. ` +
      (chat.about ? `С чем к нему идти: ${chat.about} ` : '') +
      'Подробности в скилле assistant.',
  }
}

/** The message as the assistant sees it: the question, then which task it is for. Pure. */
export function formatQuestion(text: string, taskTitle: string): string {
  const title = taskTitle.trim().replace(/\s+/g, ' ').slice(0, 200)
  return `${text.trim()}\n\n— агент, по задаче «${title}». Ответьте, пожалуйста, ответом на это сообщение.`
}

export function mountAssistantRoutes(app: Hono, deps: AssistantRoutesDeps): void {
  const { store, bot, account } = deps
  const log = deps.log ?? ((m: string) => console.log(`[agent-assistant] ${m}`))
  const maxPerRun = deps.maxPerRun ?? 5
  const asked = new Map<string, number>()

  const closed = (c: Context) => {
    const access = store.getAccess(ASSISTANT_ACCESS_NAME)
    const chat = assistantChat(store)
    if (!chat || !access || access.status !== 'active') {
      return { no: c.json({ error: 'Чат с ассистентом не подключён. Продолжай без него или спроси пользователя.' }, 403), chat: null }
    }
    return { no: null, chat }
  }

  app.post('/v1/assistant/setup', async (c) => {
    if (deps.runnerToken && c.req.header('x-runner-token') !== deps.runnerToken) return c.json({ error: 'runner token required' }, 403)
    if (!account.ready) return c.json({ error: 'Клиент Telegram не подключён.' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; chatId?: unknown; about?: unknown }
    const about = typeof body.about === 'string' ? body.about.trim().slice(0, 600) : (assistantChat(store)?.about ?? '')
    try {
      let info: TelegramChatInfo
      if (Number.isInteger(body.chatId)) {
        info = await account.chatInfo(body.chatId as number)
        if (info.type !== 'group' && info.type !== 'supergroup') return c.json({ error: 'chatId должен быть группой' }, 400)
      } else {
        const title = (typeof body.title === 'string' ? body.title.trim() : '').slice(0, 100)
        if (!title) return c.json({ error: 'title or chatId required' }, 400)
        info = await account.createGroup(title, [await bot.username()])
      }
      const chat: AssistantChat = { chatId: info.id, title: info.title, about }
      store.setMeta(META_KEY, JSON.stringify(chat))
      const access = store.upsertAccess(assistantAccess(chat), null)
      const inviteLink = await account.inviteLink(info.id).catch(() => '')
      log(`assistant chat set to "${info.title}" (${info.id})`)
      return c.json({ chat, access, inviteLink })
    } catch (err) {
      return c.json({ error: `Telegram: ${((err as Error).message || String(err)).slice(0, 300)}` }, 502)
    }
  })

  app.get('/v1/assistant/messages', async (c) => {
    const { no, chat } = closed(c)
    if (no || !chat) return no!
    if (!account.ready) return c.json({ error: 'Клиент Telegram не подключён.' }, 503)
    const raw = Number(c.req.query('limit'))
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.floor(raw)) : 30
    try {
      return c.json({ chat, items: await account.history(chat.chatId, { limit }) })
    } catch (err) {
      return c.json({ error: `Telegram: ${((err as Error).message || String(err)).slice(0, 300)}` }, 502)
    }
  })

  app.post('/v1/assistant/ask', async (c) => {
    const { no, chat } = closed(c)
    if (no || !chat) return no!
    const body = (await c.req.json().catch(() => ({}))) as { runId?: unknown; text?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'text required' }, 400)
    if (text.length > MAX_TEXT) return c.json({ error: `text длиннее ${MAX_TEXT} символов — сократи вопрос` }, 400)
    const run = typeof body.runId === 'string' ? store.get(body.runId) : null
    if (!run || run.state !== 'running' || run.kind !== 'task') {
      return c.json({ error: 'runId required: передай "$AGENT_RUN_ID" идущего прогона задачи' }, 403)
    }
    const used = asked.get(run.id) ?? 0
    if (used >= maxPerRun) {
      return c.json({ error: `В этом прогоне ассистенту уже отправлено ${used} сообщений — это предел. Собери оставшееся в итог задачи.` }, 429)
    }
    // Counted before sending, so parallel requests cannot overshoot the cap.
    asked.set(run.id, used + 1)
    try {
      const { messageId } = await bot.send(chat.chatId, formatQuestion(text, run.taskTitle))
      log(`run ${run.id.slice(0, 8)} asked the assistant (message ${messageId})`)
      return c.json({ ok: true, messageId, chat: { chatId: chat.chatId, title: chat.title }, left: maxPerRun - used - 1 })
    } catch (err) {
      asked.set(run.id, used)
      return c.json({ error: `Telegram: ${((err as Error).message || String(err)).slice(0, 300)}` }, 502)
    }
  })
}
