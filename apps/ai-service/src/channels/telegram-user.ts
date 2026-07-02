/**
 * Telegram user-account adapter (MTProto via mtcute) — "see what I see".
 * Receives ALL incoming messages for the logged-in personal account: DMs and
 * groups. Channels/broadcasts are skipped (noise). Own outgoing messages and
 * bot senders are skipped (the grammY capture bot is a bot — this also
 * prevents self-capture loops).
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
    const item = toCapturedItem(msg)
    if (!item) return
    await this.sink(item)
  }
}

export function toCapturedItem(msg: Message): CapturedItem | null {
  if (msg.isOutgoing) return null
  if (msg.isService) return null

  const sender = msg.sender
  if (sender.type === 'user' && sender.isBot) return null

  const chat = msg.chat
  let sourceChannel: CapturedItem['sourceChannel']
  if (chat.type === 'user') {
    sourceChannel = 'telegram_user_dm'
  } else if (chat.chatType === 'group' || chat.chatType === 'supergroup') {
    sourceChannel = 'telegram_group'
  } else {
    // channel / gigagroup / monoforum — broadcast noise, skip
    return null
  }

  const text = msg.text.trim()
  if (!text) return null

  return {
    text,
    sourceChannel,
    type: 'text',
    timestamp: msg.date.toISOString(),
    sourceMeta: {
      chatId: chat.id,
      chatTitle: chat.type === 'user' ? chat.displayName : chat.title,
      messageId: msg.id,
      senderId: sender.id,
      authorName: sender.displayName,
      // Identity signals for the Proposer, mirroring the Slack adapter:
      // own messages are dropped above, so everything here is from others.
      fromSelf: false,
      mentionsSelf: msg.isMention || chat.type === 'user',
      isDm: chat.type === 'user',
    },
  }
}
