/**
 * Slack adapter — user-token (xoxp-) polling across one or more workspaces.
 *
 * Why user-token + poll (not bot + Socket Mode): the goal is "see what I see"
 * across workspaces the user does NOT own. A bot only sees DMs to itself and
 * @-mentions; a user token inherits the user's own visibility (DMs, group DMs,
 * channels they're a member of). Each workspace yields its own xoxp- token, so
 * config is an array of { token } — one per workspace.
 *
 * Polling model (validated against live data):
 *   - "New for the agent" = our own saved cursor per conversation, NOT Slack's
 *     unread_count (which is 0 whenever the user has read it in the Slack client,
 *     so it never fires for a human who reads their own messages).
 *   - Bootstrap: on first sight of a conversation, save latest ts WITHOUT
 *     pulling history — we start watching from "now", not backfill the archive.
 *   - Each cycle: list conversations (cheap) → for each, compare latest message
 *     ts to saved cursor → only fetch conversations.history(oldest=cursor) where
 *     it moved. Silent conversations cost ~one list call, not a history call.
 *
 * Rate limit: conversations.history is ~5 req/min per workspace for non-Marketplace
 * apps. We pace history calls per workspace and walk conversations over many cycles
 * rather than hammering all of them at once. This is background collection, not
 * realtime — lag of minutes is acceptable.
 *
 * Push/pull:
 *   - DMs (im) and group DMs (mpim) → slack_dm  → push (creates inbox task).
 *   - Channels (public/private)     → slack_channel → pull (Context Store only).
 */

import { WebClient } from '@slack/web-api'
import type { Channel, CaptureSink } from './types'
import type { CapturedItem } from '../capture/normalizer'

export interface SlackWorkspaceConfig {
  /** xoxp- user token for one workspace. */
  token: string
}

export interface SlackConfig {
  workspaces: SlackWorkspaceConfig[]
  /** Poll cadence per workspace. Default 5 min. */
  pollIntervalMs?: number
  /**
   * Max history fetches per workspace per cycle. Keeps us under the ~5 req/min
   * history limit. Default 4 (leaves headroom for the list call).
   */
  maxHistoryPerCycle?: number
  /** Delay between paced API calls within a workspace. Default 1500ms. */
  pacingMs?: number
}

interface ConversationCursorStore {
  /** Returns the last-seen Slack ts for a conversation, or null if unseen. */
  get(key: string): Promise<string | null>
  set(key: string, ts: string): Promise<void>
}

interface SlackConversation {
  id: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_channel?: boolean
  is_group?: boolean
  name?: string
  user?: string
}

interface SlackMessage {
  type?: string
  subtype?: string
  text?: string
  ts: string
  user?: string
  bot_id?: string
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_MAX_HISTORY_PER_CYCLE = 4
const DEFAULT_PACING_MS = 1500

export class SlackChannel implements Channel {
  readonly name = 'slack'

  private workspaces: SlackWorkspace[]
  private pollIntervalMs: number
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private running = false

  constructor(
    config: SlackConfig,
    sink: CaptureSink,
    cursors: ConversationCursorStore
  ) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const maxHistory = config.maxHistoryPerCycle ?? DEFAULT_MAX_HISTORY_PER_CYCLE
    const pacingMs = config.pacingMs ?? DEFAULT_PACING_MS
    this.workspaces = config.workspaces.map(
      (ws) => new SlackWorkspace(ws.token, sink, cursors, maxHistory, pacingMs)
    )
  }

  async start(): Promise<void> {
    this.stopped = false
    // Resolve identity for each workspace before first poll; drop any that fail
    // auth so one bad token doesn't kill the others.
    const ok: SlackWorkspace[] = []
    for (const ws of this.workspaces) {
      try {
        await ws.init()
        ok.push(ws)
      } catch (err) {
        console.error('[slack] workspace auth failed, skipping:', err)
      }
    }
    this.workspaces = ok
    if (this.workspaces.length === 0) {
      console.warn('[slack] no usable workspaces — channel idle')
      return
    }
    console.log(
      `[slack] ${this.workspaces.length} workspace(s): ${this.workspaces.map((w) => w.teamName).join(', ')}`
    )
    this.timer = setTimeout(() => void this.loop(), 2000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped || this.running) return
    this.running = true
    try {
      for (const ws of this.workspaces) {
        if (this.stopped) break
        try {
          await ws.poll()
        } catch (err) {
          console.error(`[slack] poll failed for ${ws.teamName}:`, err)
        }
      }
    } finally {
      this.running = false
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
    }
  }
}

class SlackWorkspace {
  private web: WebClient
  private selfUserId = ''
  teamName = '<unknown>'
  teamId = ''

  constructor(
    token: string,
    private sink: CaptureSink,
    private cursors: ConversationCursorStore,
    private maxHistoryPerCycle: number,
    private pacingMs: number
  ) {
    this.web = new WebClient(token)
  }

  async init(): Promise<void> {
    const auth = await this.web.auth.test()
    this.selfUserId = (auth.user_id as string) ?? ''
    this.teamName = (auth.team as string) ?? '<unknown>'
    this.teamId = (auth.team_id as string) ?? ''
  }

  async poll(): Promise<void> {
    const conversations = await this.listConversations()
    let historyBudget = this.maxHistoryPerCycle

    for (const conv of conversations) {
      const key = `slack:${this.teamId}:${conv.id}`
      const latest = await this.latestTs(conv.id)
      if (!latest) continue // empty conversation

      const cursor = await this.cursors.get(key)

      // Bootstrap: first time we see this conversation, mark "watch from now"
      // without backfilling history into the inbox.
      if (cursor === null) {
        await this.cursors.set(key, latest)
        continue
      }

      if (latest <= cursor) continue // nothing new since we last looked

      if (historyBudget <= 0) {
        // Out of history budget this cycle — leave cursor as-is, pick it up next
        // cycle. We do NOT advance the cursor, so no messages are lost.
        continue
      }
      historyBudget--

      const messages = await this.fetchSince(conv.id, cursor)
      let newestTs = cursor
      for (const msg of messages) {
        if (msg.ts > newestTs) newestTs = msg.ts
        const item = this.toCapturedItem(conv, msg)
        if (!item) continue
        try {
          await this.sink(item)
        } catch (err) {
          console.error(`[slack] capture failed (${this.teamName} ${conv.id}):`, err)
        }
      }
      await this.cursors.set(key, newestTs)
    }
  }

  private async listConversations(): Promise<SlackConversation[]> {
    const out: SlackConversation[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const res = await this.web.users.conversations({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor,
      })
      for (const c of res.channels ?? []) out.push(c as SlackConversation)
      cursor = res.response_metadata?.next_cursor || undefined
      pages++
      if (cursor) await this.pace()
    } while (cursor && pages < 10)
    return out
  }

  /** Latest message ts in a conversation without pulling full history. */
  private async latestTs(channel: string): Promise<string | null> {
    const res = await this.web.conversations.history({ channel, limit: 1 })
    const msg = (res.messages ?? [])[0] as SlackMessage | undefined
    await this.pace()
    return msg?.ts ?? null
  }

  private async fetchSince(channel: string, oldest: string): Promise<SlackMessage[]> {
    const res = await this.web.conversations.history({
      channel,
      oldest,
      inclusive: false,
      limit: 100,
    })
    await this.pace()
    return ((res.messages ?? []) as SlackMessage[])
      .slice()
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
  }

  private toCapturedItem(conv: SlackConversation, msg: SlackMessage): CapturedItem | null {
    // Skip system messages (joins, topic changes, etc.) and any bot output.
    if (msg.subtype) return null
    if (msg.bot_id) return null
    if (msg.user && msg.user === this.selfUserId) {
      // Keep own messages? They're context too, but for GTD "what others want
      // from me" the signal is inbound. Drop self to cut noise.
      return null
    }
    const text = msg.text?.trim()
    if (!text) return null

    const isDm = !!conv.is_im || !!conv.is_mpim
    return {
      text,
      sourceChannel: isDm ? 'slack_dm' : 'slack_channel',
      type: 'text',
      timestamp: slackTsToIso(msg.ts),
      sourceMeta: {
        workspace: this.teamName,
        teamId: this.teamId,
        channelId: conv.id,
        channelName: conv.name,
        userId: msg.user,
        ts: msg.ts,
        isDm,
      },
    }
  }

  private pace(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.pacingMs))
  }
}

function slackTsToIso(ts: string): string {
  const [seconds, micro] = ts.split('.')
  const ms = Number(seconds) * 1000 + Math.floor(Number(micro ?? '0') / 1000)
  return new Date(ms).toISOString()
}
