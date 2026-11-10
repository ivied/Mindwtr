/**
 * Telegram for the inbox agents — the user's personal account, through the
 * client ai-service already keeps connected (../channels/telegram-user.ts).
 *
 *   GET  /v1/telegram/chats?q=&limit=                    dialogs, newest first
 *   GET  /v1/telegram/chats/:chat/messages?limit=&before= history of one chat
 *   GET  /v1/telegram/search?q=&chat=&limit=             full-text search
 *   POST /v1/telegram/send { runId, chat, text, replyTo } send a message
 *
 * All of it is switched by the `telegram` row of the access registry: revoked
 * means every route answers 403, read scope means no sending at all.
 *
 * Sending is the one thing here that reaches other people, so it does not rely
 * on the agent behaving. The request has to name a run whose current turn was
 * started by the user approving a confirmation, the text has to be the draft
 * they approved, and the chat has to be the one named in that confirmation.
 * One approval sends one message.
 */

import type { Context, Hono } from 'hono'
import {
  TelegramChatNotFoundError,
  parseChatRef,
  type TelegramChatInfo,
  type TelegramChatRef,
  type TelegramDialogInfo,
  type TelegramMessageInfo,
} from '../channels/telegram-user'
import type { AgentRunStore } from './store'
import type { AccessSpec, PendingConfirm } from './types'

/** The slice of TelegramUserChannel the routes need (kept narrow for tests). */
export interface TelegramAgentApi {
  readonly ready: boolean
  listChats(opts: { query?: string; limit?: number }): Promise<TelegramDialogInfo[]>
  chatInfo(chat: TelegramChatRef): Promise<TelegramChatInfo>
  history(chat: TelegramChatRef, opts: { limit?: number; beforeId?: number }): Promise<TelegramMessageInfo[]>
  search(opts: { query: string; chat?: TelegramChatRef; limit?: number }): Promise<TelegramMessageInfo[]>
  send(chat: TelegramChatRef, text: string, replyTo?: number): Promise<TelegramMessageInfo>
}

export interface TelegramRoutesDeps {
  store: AgentRunStore
  telegram: TelegramAgentApi
  log?: (msg: string) => void
}

export const TELEGRAM_ACCESS_NAME = 'telegram'

/**
 * The registry row. `hosts` stays empty on purpose: write scope must not make
 * the runner's guard wave any host through — the send route checks consent
 * itself.
 */
export const TELEGRAM_ACCESS: AccessSpec = {
  name: TELEGRAM_ACCESS_NAME,
  kind: 'http',
  scope: 'write',
  hosts: [],
  envVars: [],
  mcpServer: '',
  skill: 'telegram',
  notes:
    'Личный Telegram пользователя через ai-service: чаты, история и поиск — GET $AI_SERVICE_URL/v1/telegram/… ' +
    'Отправка сообщения — только после mcp__gtd__request_confirmation, одно подтверждение на одно сообщение. Как именно — в скилле telegram.',
}

/** Telegram's own cap on a text message. */
const MAX_TEXT = 4096

const intParam = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && raw !== undefined && raw !== '' ? Math.max(min, Math.min(max, Math.floor(n))) : fallback
}

/** Same text as far as a reader is concerned: line endings and outer whitespace aside. */
const normalizeText = (t: string): string => t.replace(/\r\n?/g, '\n').trim()

/**
 * Whether the confirmation the user saw names this chat: its id, its
 * @username or its title. Pure — tested directly.
 */
export function targetNamesChat(target: string, chat: TelegramChatInfo): boolean {
  const t = target.toLowerCase()
  if (new RegExp(`(^|[^0-9])${Math.abs(chat.id)}([^0-9]|$)`).test(t)) return true
  if (chat.username && new RegExp(`@${chat.username.toLowerCase()}(?![a-z0-9_])`).test(t)) return true
  const title = chat.title.trim().toLowerCase()
  return title.length >= 2 && t.includes(title)
}

/** Why this message may not be sent under this approval, or null when it may. Pure. */
export function sendRefusal(approved: PendingConfirm | null, chat: TelegramChatInfo, text: string): string | null {
  if (!approved) {
    return (
      'Отправка в Telegram возможна только в ходе, который начался с подтверждения пользователя. ' +
      'Вызови mcp__gtd__request_confirmation: в target — название чата и его id, в draft — точный текст сообщения, и заверши ход.'
    )
  }
  if (normalizeText(approved.draft) !== normalizeText(text)) {
    return (
      'Текст отличается от того, что подтвердил пользователь. Отправь ровно подтверждённый текст ' +
      'или запроси новое подтверждение с новым текстом через mcp__gtd__request_confirmation.'
    )
  }
  if (!targetNamesChat(approved.target, chat)) {
    return (
      `Пользователь подтвердил отправку в «${approved.target}», а запрос идёт в чат «${chat.title}» (id ${chat.id}). ` +
      'Запроси новое подтверждение и укажи в target название этого чата и его id.'
    )
  }
  return null
}

export function mountTelegramRoutes(app: Hono, deps: TelegramRoutesDeps): void {
  const { store, telegram } = deps
  const log = deps.log ?? ((m: string) => console.log(`[agent-telegram] ${m}`))

  /** The registry row is the switch; the client must also be signed in. */
  const closed = (c: Context, needWrite = false) => {
    const access = store.getAccess(TELEGRAM_ACCESS_NAME)
    if (!access || access.status !== 'active') {
      return c.json({ error: 'Доступ «telegram» не подключён. Если он нужен для задачи, вызови mcp__gtd__request_access.' }, 403)
    }
    if (needWrite && access.scope !== 'write') {
      return c.json({ error: 'Доступ «telegram» выдан только на чтение: отправлять сообщения нельзя. Сохрани черновик в итоге задачи.' }, 403)
    }
    if (!telegram.ready) return c.json({ error: 'Клиент Telegram не подключён (нет действующей сессии личного аккаунта).' }, 503)
    return null
  }

  const failed = (c: Context, err: unknown) => {
    if (err instanceof TelegramChatNotFoundError) {
      return c.json({ error: `${err.message}. Возьми id из GET /v1/telegram/chats?q=<часть названия>.` }, 404)
    }
    const message = (err as Error).message || String(err)
    log(`request failed: ${message}`)
    return c.json({ error: `Telegram: ${message.slice(0, 300)}` }, 502)
  }

  const chatRef = (raw: string | undefined): TelegramChatRef | null => parseChatRef(raw ?? '')
  const BAD_CHAT = 'chat: числовой id из /v1/telegram/chats, @username или me'

  app.get('/v1/telegram/chats', async (c) => {
    const no = closed(c)
    if (no) return no
    try {
      const items = await telegram.listChats({
        query: (c.req.query('q') ?? '').slice(0, 100),
        limit: intParam(c.req.query('limit'), 30, 1, 100),
      })
      return c.json({ items })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.get('/v1/telegram/chats/:chat/messages', async (c) => {
    const no = closed(c)
    if (no) return no
    const chat = chatRef(c.req.param('chat'))
    if (chat === null) return c.json({ error: BAD_CHAT }, 400)
    const before = intParam(c.req.query('before'), 0, 0, Number.MAX_SAFE_INTEGER)
    try {
      const [info, items] = await Promise.all([
        telegram.chatInfo(chat),
        telegram.history(chat, { limit: intParam(c.req.query('limit'), 30, 1, 100), ...(before ? { beforeId: before } : {}) }),
      ])
      return c.json({ chat: info, items })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.get('/v1/telegram/search', async (c) => {
    const no = closed(c)
    if (no) return no
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    if (!query) return c.json({ error: 'q required' }, 400)
    const rawChat = c.req.query('chat')
    const chat = rawChat ? chatRef(rawChat) : undefined
    if (chat === null) return c.json({ error: BAD_CHAT }, 400)
    try {
      const items = await telegram.search({
        query,
        ...(chat !== undefined ? { chat } : {}),
        limit: intParam(c.req.query('limit'), 20, 1, 50),
      })
      return c.json({ items })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.post('/v1/telegram/send', async (c) => {
    const no = closed(c, true)
    if (no) return no
    const body = (await c.req.json().catch(() => ({}))) as { runId?: unknown; chat?: unknown; text?: unknown; replyTo?: unknown }
    const runId = typeof body.runId === 'string' ? body.runId : ''
    const text = typeof body.text === 'string' ? body.text : ''
    const chat = chatRef(typeof body.chat === 'number' ? String(body.chat) : typeof body.chat === 'string' ? body.chat : '')
    if (chat === null) return c.json({ error: BAD_CHAT }, 400)
    if (!normalizeText(text)) return c.json({ error: 'text required' }, 400)
    if (text.length > MAX_TEXT) return c.json({ error: `text длиннее ${MAX_TEXT} символов — раздели на несколько сообщений, каждое со своим подтверждением` }, 400)
    const replyTo = Number.isInteger(body.replyTo) && (body.replyTo as number) > 0 ? (body.replyTo as number) : undefined
    if (!runId) return c.json({ error: 'runId required: передай "$AGENT_RUN_ID"' }, 400)

    const approved = store.approvedConfirm(runId)
    let info: TelegramChatInfo
    try {
      // Resolve first: the refusal has to name the real chat, not what the agent called it.
      info = await telegram.chatInfo(chat)
    } catch (err) {
      return failed(c, err)
    }
    const refusal = sendRefusal(approved, info, text)
    if (refusal || !approved) {
      log(`send refused for run ${runId.slice(0, 8)} → ${info.title} (${info.id})`)
      return c.json({ error: refusal }, 403)
    }
    // Taken before sending, so two requests racing on one approval cannot both go out.
    if (!store.takeApproval(runId)) {
      return c.json({ error: 'Это подтверждение уже использовано: одно подтверждение — одно сообщение.' }, 409)
    }
    try {
      const message = await telegram.send(chat, text, replyTo)
      log(`sent for run ${runId.slice(0, 8)} → ${info.title} (${info.id}), message ${message.id}`)
      return c.json({ ok: true, chat: info, message })
    } catch (err) {
      store.restoreApproval(runId, approved)
      return failed(c, err)
    }
  })
}
