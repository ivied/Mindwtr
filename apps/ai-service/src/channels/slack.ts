/**
 * Slack adapter using Socket Mode (no public URL required).
 * Self-created app model: user provides their own app token + bot token.
 *
 * Capture rules:
 * - DM to the bot → always capture
 * - Channel message → only if bot is mentioned
 * - Ignore bot's own messages and other bots
 * - Skip message subtypes (edits, deletes, joins, etc.)
 */

import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import type { Channel, CaptureSink } from './types'
import type { CapturedItem } from '../capture/normalizer'

interface SlackConfig {
  appToken: string // xapp-*
  botToken: string // xoxb-*
}

interface SlackMessageEvent {
  type: 'message'
  subtype?: string
  channel_type?: 'im' | 'channel' | 'group' | 'mpim'
  channel: string
  user?: string
  text?: string
  ts: string
  bot_id?: string
}

export class SlackChannel implements Channel {
  readonly name = 'slack'

  private socket: SocketModeClient
  private web: WebClient
  private botUserId?: string

  constructor(
    private config: SlackConfig,
    private sink: CaptureSink
  ) {
    this.socket = new SocketModeClient({ appToken: config.appToken })
    this.web = new WebClient(config.botToken)
  }

  async start(): Promise<void> {
    // Resolve our bot user id to filter out self-messages and detect mentions
    const authTest = await this.web.auth.test()
    this.botUserId = authTest.user_id as string

    this.socket.on('events_api', async (envelope: { event?: SlackMessageEvent }) => {
      const event = envelope.event
      if (!event || event.type !== 'message') return
      await this.handleMessage(event)
    })

    await this.socket.start()
  }

  async stop(): Promise<void> {
    await this.socket.disconnect()
  }

  private async handleMessage(event: SlackMessageEvent): Promise<void> {
    // Skip edits, deletes, system messages
    if (event.subtype) return

    // Skip bot messages (including our own)
    if (event.bot_id || event.user === this.botUserId) return

    const text = event.text?.trim()
    if (!text) return

    const isDm = event.channel_type === 'im'
    const botMention = this.botUserId ? `<@${this.botUserId}>` : null
    const isMentioned = !!botMention && text.includes(botMention)

    // Channel messages: only if bot is mentioned
    if (!isDm && !isMentioned) return

    // Strip the mention from text
    const cleanText = isMentioned && botMention ? text.replaceAll(botMention, '').trim() : text
    if (!cleanText) return

    const item: CapturedItem = {
      text: cleanText,
      sourceChannel: isDm ? 'slack_dm' : 'slack_channel',
      type: 'text',
      timestamp: slackTsToIso(event.ts),
      sourceMeta: {
        channelId: event.channel,
        userId: event.user,
        ts: event.ts,
        channelType: event.channel_type,
      },
    }

    try {
      await this.sink(item)
    } catch (err) {
      console.error('[slack] Failed to capture:', err)
    }
  }
}

function slackTsToIso(ts: string): string {
  const [seconds, micro] = ts.split('.')
  const ms = Number(seconds) * 1000 + Math.floor(Number(micro ?? '0') / 1000)
  return new Date(ms).toISOString()
}
