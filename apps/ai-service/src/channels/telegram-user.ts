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
 */

import { TelegramClient } from '@mtcute/bun'
import type { Message } from '@mtcute/bun'
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
