/**
 * Telegram user-account adapter (MTProto via mtcute) — "see what I see".
 * Receives ALL messages for the logged-in personal account: DMs and groups,
 * incoming AND outgoing. Outgoing messages (fromSelf=true) are completion
 * evidence — "отправил", "готово" about an open item — and first-person
 * commitments. Channels/broadcasts are skipped (noise). Bot senders and
 * outgoing messages TO bots are skipped (the grammY capture bot is a bot —
 * this prevents self-capture loops).
 *
 * Auth is a one-time interactive login (scripts/telegram-login.ts) that
 * persists an MTProto session in DATA_DIR; this adapter only ever reuses it
 * and never prompts.
 *
 * The same client also serves the inbox agents (see
 * ../agent-runs/telegram-routes.ts): listing chats, reading history, searching
 * and — behind a user confirmation checked there — sending a message. Reading
 * through it never marks anything as read.
 */

import { TelegramClient } from '@mtcute/bun'
import type { Dialog, Message, Peer } from '@mtcute/bun'
import type { Channel, CaptureSink } from './types'
import type { CapturedItem } from '../capture/normalizer'

export interface TelegramUserConfig {
  apiId: number
  apiHash: string
  /** Path to the mtcute SQLite session (must live in DATA_DIR to survive restarts). */
  sessionPath: string
  /** Capture the user's own outgoing messages (fromSelf=true). Default true. */
  captureOutgoing?: boolean
}

export type TelegramChatType = 'user' | 'bot' | 'group' | 'supergroup' | 'channel'

export interface TelegramChatInfo {
  /** Telegram's marked id: positive for people, negative for groups and channels. */
  id: number
  type: TelegramChatType
  title: string
  username: string | null
}

export interface TelegramMessageInfo {
  id: number
  date: string
  chatId: number
  chatTitle: string
  from: string
  fromId: number
  /** Written by the account owner. */
  outgoing: boolean
  text: string
  replyTo: number | null
  /** Kind of attachment (photo, document, voice…), when there is one. */
  media: string | null
}

export interface TelegramDialogInfo extends TelegramChatInfo {
  unread: number
  muted: boolean
  archived: boolean
  lastMessage: TelegramMessageInfo | null
}

/** A chat as callers name it: marked id, username, or 'me' (Saved Messages). */
export type TelegramChatRef = number | string

export class TelegramChatNotFoundError extends Error {
  constructor(ref: TelegramChatRef) {
    super(`чат «${ref}» не найден среди известных аккаунту`)
    this.name = 'TelegramChatNotFoundError'
  }
}

/** `-100123`, `123`, `@name`, `name`, `me` → what the client can resolve; null for anything else. */
export function parseChatRef(raw: string): TelegramChatRef | null {
  const s = raw.trim()
  if (/^-?\d{1,20}$/.test(s)) return Number(s)
  if (s === 'me' || s === 'self') return 'me'
  const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s)
  return m ? m[1]! : null
}

export function toChatInfo(peer: Peer): TelegramChatInfo {
  if (peer.type === 'user') {
    return { id: peer.id, type: peer.isBot ? 'bot' : 'user', title: peer.displayName, username: peer.username }
  }
  const type = peer.chatType === 'group' || peer.chatType === 'supergroup' ? peer.chatType : 'channel'
  return { id: peer.id, type, title: peer.title, username: peer.username }
}

export function toMessageInfo(msg: Message): TelegramMessageInfo {
  const chat = toChatInfo(msg.chat)
  const media = (msg.media as { type?: string } | null)?.type ?? null
  return {
    id: msg.id,
    date: msg.date.toISOString(),
    chatId: chat.id,
    chatTitle: chat.title,
    from: msg.sender.displayName,
    fromId: msg.sender.id,
    outgoing: msg.isOutgoing,
    text: msg.text,
    replyTo: (msg.replyToMessage as { id?: number | null } | null)?.id ?? null,
    media,
  }
}

export function toDialogInfo(dialog: Dialog): TelegramDialogInfo {
  const last = dialog.lastMessage
  return {
    ...toChatInfo(dialog.peer),
    unread: dialog.unreadCount,
    muted: dialog.isMuted === true,
    archived: dialog.isArchived,
    lastMessage: last && !last.isService ? toMessageInfo(last) : null,
  }
}

/** How many dialogs a title search looks through (newest first). */
const DIALOG_SCAN = 500

export class TelegramUserChannel implements Channel {
  readonly name = 'telegram-user'

  private tg: TelegramClient
  private started = false

  constructor(
    private config: TelegramUserConfig,
    private sink: CaptureSink
  ) {
    this.tg = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: config.sessionPath,
    })
  }

  async start(): Promise<void> {
    await this.tg.connect()
    let selfName: string
    try {
      const me = await this.tg.getMe()
      selfName = me.displayName
    } catch (err) {
      console.error(
        `[telegram-user] no valid session at ${this.config.sessionPath} — run \`bun run scripts/telegram-login.ts\` once (${(err as Error).message})`
      )
      await this.tg.destroy()
      return
    }

    this.tg.onNewMessage.add((msg) => {
      void this.handleMessage(msg).catch((err) =>
        console.error('[telegram-user] capture failed:', err)
      )
    })
    this.tg.startUpdatesLoop()
    this.started = true
    console.log(`[telegram-user] listening as ${selfName}`)
  }

  async stop(): Promise<void> {
    if (this.started) this.tg.stopUpdatesLoop()
    await this.tg.destroy()
    this.started = false
  }

  // ── For the inbox agents ──────────────────────────────────────────────────

  /** False until a valid session connected: the calls below would fail. */
  get ready(): boolean {
    return this.started
  }

  private async resolved<T>(ref: TelegramChatRef, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      const e = err as { name?: string; text?: string; message?: string }
      const unknownPeer =
        e.name === 'MtPeerNotFoundError' ||
        /PEER_ID_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHANNEL_INVALID|CHAT_ID_INVALID/.test(`${e.text ?? ''} ${e.message ?? ''}`)
      if (unknownPeer) throw new TelegramChatNotFoundError(ref)
      throw err
    }
  }

  /** Dialogs, newest first; `query` keeps those whose title or username contains it. */
  async listChats(opts: { query?: string; limit?: number } = {}): Promise<TelegramDialogInfo[]> {
    const limit = opts.limit ?? 30
    const needle = (opts.query ?? '').trim().toLowerCase().replace(/^@/, '')
    const out: TelegramDialogInfo[] = []
    for await (const dialog of this.tg.iterDialogs({ limit: needle ? DIALOG_SCAN : limit, archived: 'keep' })) {
      const info = toDialogInfo(dialog)
      if (needle && !info.title.toLowerCase().includes(needle) && !(info.username ?? '').toLowerCase().includes(needle)) continue
      out.push(info)
      if (out.length >= limit) break
    }
    return out
  }

  chatInfo(ref: TelegramChatRef): Promise<TelegramChatInfo> {
    return this.resolved(ref, async () => toChatInfo(await this.tg.getPeer(ref)))
  }

  /** Messages of one chat, newest first; `beforeId` pages further back. */
  history(ref: TelegramChatRef, opts: { limit?: number; beforeId?: number } = {}): Promise<TelegramMessageInfo[]> {
    return this.resolved(ref, async () => {
      const page = await this.tg.getHistory(ref, {
        limit: opts.limit ?? 30,
        ...(opts.beforeId ? { offset: { id: opts.beforeId, date: 0 } } : {}),
      })
      return page.filter((m) => !m.isService).map(toMessageInfo)
    })
  }

  /** Full-text search in one chat, or across all of them when `chat` is omitted. */
  search(opts: { query: string; chat?: TelegramChatRef; limit?: number }): Promise<TelegramMessageInfo[]> {
    const limit = opts.limit ?? 20
    const chat = opts.chat
    if (chat === undefined) {
      return this.tg.searchGlobal({ query: opts.query, limit }).then((page) => page.map(toMessageInfo))
    }
    return this.resolved(chat, async () =>
      (await this.tg.searchMessages({ query: opts.query, chatId: chat, limit })).map(toMessageInfo)
    )
  }

  /** Send plain text as the account owner. Callers are responsible for the user's consent. */
  send(ref: TelegramChatRef, text: string, replyTo?: number): Promise<TelegramMessageInfo> {
    return this.resolved(ref, async () => toMessageInfo(await this.tg.sendText(ref, text, replyTo ? { replyTo } : {})))
  }

  /** Create a plain group owned by the account, with these members (a bot's @username works). */
  async createGroup(title: string, users: TelegramChatRef[]): Promise<TelegramChatInfo> {
    const { chat } = await this.tg.createGroup({ title, users })
    return toChatInfo(chat)
  }

  /** Invite link of a group the account administers. */
  async inviteLink(ref: TelegramChatRef): Promise<string> {
    return (await this.tg.exportInviteLink(ref)).link
  }

  private async handleMessage(msg: Message): Promise<void> {
    const item = toCapturedItem(msg, this.config.captureOutgoing ?? true)
    if (!item) return
    await this.sink(item)
  }
}

export function toCapturedItem(msg: Message, captureOutgoing = true): CapturedItem | null {
  if (msg.isOutgoing && !captureOutgoing) return null
  if (msg.isService) return null

  const sender = msg.sender
  if (sender.type === 'user' && sender.isBot) return null

  const chat = msg.chat
  let sourceChannel: CapturedItem['sourceChannel']
  if (chat.type === 'user') {
    // Outgoing DM to a bot = the grammY capture bot or similar — capturing it
    // would double every explicit capture the user types (self-capture loop).
    if (msg.isOutgoing && (chat as { isBot?: boolean }).isBot) return null
    sourceChannel = 'telegram_user_dm'
  } else if (chat.chatType === 'group' || chat.chatType === 'supergroup') {
    sourceChannel = 'telegram_group'
  } else {
    // channel / gigagroup / monoforum — broadcast noise, skip
    return null
  }

  const text = msg.text.trim()
  if (!text) return null

  const isDm = chat.type === 'user'
  const chatTitle = chat.type === 'user' ? chat.displayName : chat.title
  return {
    text,
    sourceChannel,
    type: 'text',
    timestamp: msg.date.toISOString(),
    sourceMeta: {
      chatId: chat.id,
      chatTitle,
      messageId: msg.id,
      senderId: sender.id,
      authorName: sender.displayName,
      // Identity signals for the Proposer, mirroring the Slack adapter.
      // fromSelf=true → the USER wrote this (outgoing): completion evidence
      // for open items, or a first-person commitment — never a request TO the
      // user, so mentionsSelf stays false for outgoing.
      fromSelf: msg.isOutgoing,
      mentionsSelf: msg.isOutgoing ? false : msg.isMention || chat.type === 'user',
      isDm,
      // For an outgoing DM the chat peer IS the recipient — lets the Proposer
      // match "Reply to <name>" items without guessing from the text.
      ...(msg.isOutgoing && isDm ? { recipientName: chatTitle } : {}),
    },
  }
}
