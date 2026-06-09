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
 * Rate limit (post-March-2026): conversations.history for non-Marketplace apps
 * is Tier 1 — 1 request/minute per workspace, max 15 messages/call. We treat
 * conversations.history as a scarce budget:
 *   - A per-workspace token bucket caps history calls to historyBudgetPerMin
 *     (default 1) and refuses calls that would exceed it.
 *   - 429s parse Retry-After and pause the bucket until the window clears.
 *   - We do NOT call history just to peek at the latest ts (the old latestTs
 *     double-spent the budget). Instead each eligible conversation spends one
 *     history call to fetch-since-cursor directly.
 *   - Conversations are walked round-robin across cycles so a busy first
 *     channel can't starve the rest under a 1/min ceiling.
 * This is background collection, not realtime — lag of minutes is acceptable.
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
   * conversations.history calls allowed per workspace per rolling minute.
   * Slack's Tier-1 ceiling for non-Marketplace apps is 1. Default 1.
   */
  historyBudgetPerMin?: number
  /** Delay between paced non-history API calls within a workspace. Default 1500ms. */
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
const DEFAULT_HISTORY_BUDGET_PER_MIN = 1
const DEFAULT_PACING_MS = 1500

/**
 * Per-workspace budget for conversations.history. Refills 1/min (sliding
 * window over the last 60s). When Slack returns 429 with Retry-After, we
 * block the bucket until that deadline regardless of the window.
 */
export class HistoryBudget {
  private timestamps: number[] = []
  private blockedUntil = 0

  constructor(private perMin: number) {}

  /** True if a history call may be spent right now. */
  canSpend(now = Date.now()): boolean {
    if (now < this.blockedUntil) return false
    this.prune(now)
    return this.timestamps.length < this.perMin
  }

  spend(now = Date.now()): void {
    this.timestamps.push(now)
  }

  /** Apply a Retry-After (seconds) pause from a 429 response. */
  penalize(retryAfterSec: number, now = Date.now()): void {
    const until = now + Math.max(1, retryAfterSec) * 1000
    if (until > this.blockedUntil) this.blockedUntil = until
  }

  private prune(now: number): void {
    const cutoff = now - 60_000
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift()
    }
  }
}

/** Extract Retry-After seconds from a Slack WebAPI error, defaulting to 60. */
function retryAfterFromError(err: unknown): number | null {
  const e = err as { code?: string; retryAfter?: number; data?: { error?: string } }
  // @slack/web-api surfaces rate limits as code 'slack_webapi_rate_limited_error'
  // with a numeric retryAfter (seconds) on the error object.
  if (typeof e?.retryAfter === 'number') return e.retryAfter
  if (e?.code === 'slack_webapi_rate_limited_error') return 60
  return null
}

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
    const historyBudget = config.historyBudgetPerMin ?? DEFAULT_HISTORY_BUDGET_PER_MIN
    const pacingMs = config.pacingMs ?? DEFAULT_PACING_MS
    this.workspaces = config.workspaces.map(
      (ws) => new SlackWorkspace(ws.token, sink, cursors, historyBudget, pacingMs)
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
  private selfName = ''
  teamName = '<unknown>'
  teamId = ''
  /** Slack userId → display name cache (best-effort, populated lazily). */
  private nameCache = new Map<string, string>()
  private historyBudget: HistoryBudget
  /** Round-robin offset into the conversation list across cycles. */
  private rrOffset = 0

  constructor(
    token: string,
    private sink: CaptureSink,
    private cursors: ConversationCursorStore,
    historyBudgetPerMin: number,
    private pacingMs: number
  ) {
    this.web = new WebClient(token)
    this.historyBudget = new HistoryBudget(historyBudgetPerMin)
  }

  async init(): Promise<void> {
    const auth = await this.web.auth.test()
    this.selfUserId = (auth.user_id as string) ?? ''
    this.teamName = (auth.team as string) ?? '<unknown>'
    this.teamId = (auth.team_id as string) ?? ''
    this.selfName = await this.userName(this.selfUserId)
  }

  /** Resolve a Slack userId to a display name, cached. Falls back to the id. */
  private async userName(userId: string | undefined): Promise<string> {
    if (!userId) return ''
    const hit = this.nameCache.get(userId)
    if (hit !== undefined) return hit
    try {
      const info = await this.web.users.info({ user: userId })
      const u = info.user as { real_name?: string; name?: string } | undefined
      const name = u?.real_name ?? u?.name ?? userId
      this.nameCache.set(userId, name)
      await this.pace()
      return name
    } catch {
      this.nameCache.set(userId, userId)
      return userId
    }
  }

  /** Replace <@U123> mentions in text with @DisplayName, resolving via cache. */
  private async resolveMentions(text: string): Promise<string> {
    const ids = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]!)
    let out = text
    for (const id of [...new Set(ids)]) {
      const name = await this.userName(id)
      out = out.replaceAll(`<@${id}>`, `@${name}`)
    }
    return out
  }

  async poll(): Promise<void> {
    const conversations = await this.listConversations()
    if (conversations.length === 0) return

    // Round-robin: start where we left off so a busy early channel can't
    // starve the rest under a 1/min history ceiling.
    const n = conversations.length
    const start = this.rrOffset % n
    const ordered = [...conversations.slice(start), ...conversations.slice(0, start)]
    this.rrOffset = (start + 1) % n

    for (const conv of ordered) {
      const key = `slack:${this.teamId}:${conv.id}`
      const cursor = await this.cursors.get(key)

      // Bootstrap: first time we see this conversation, mark "watch from now"
      // without backfilling history into the inbox. Uses conversations.info
      // (Tier 3, not the scarce history budget) to read the latest ts.
      if (cursor === null) {
        const latest = await this.latestTsViaInfo(conv.id)
        if (latest) await this.cursors.set(key, latest)
        continue
      }

      // Spend one history call to pull anything since the cursor. If the
      // budget is exhausted (or we're in a 429 penalty window), stop the whole
      // cycle: leave cursors untouched so nothing is lost, resume next cycle.
      if (!this.historyBudget.canSpend()) break
      this.historyBudget.spend()

      let messages: SlackMessage[]
      try {
        messages = await this.fetchSince(conv.id, cursor)
      } catch (err) {
        const retryAfter = retryAfterFromError(err)
        if (retryAfter !== null) {
          this.historyBudget.penalize(retryAfter)
          console.warn(
            `[slack] history rate-limited (${this.teamName}); backing off ${retryAfter}s`
          )
          break // stop this cycle; cursor untouched
        }
        console.error(`[slack] fetchSince failed (${this.teamName} ${conv.id}):`, err)
        continue
      }

      let newestTs = cursor
      for (const msg of messages) {
        if (msg.ts > newestTs) newestTs = msg.ts
        const item = await this.toCapturedItem(conv, msg)
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

  /**
   * Latest message ts via conversations.info (Tier 3), used only at bootstrap
   * to set the initial cursor without spending the scarce history budget.
   * The `latest` field is present in the live response but not typed by
   * @slack/web-api, hence the cast.
   */
  private async latestTsViaInfo(channel: string): Promise<string | null> {
    try {
      const res = await this.web.conversations.info({ channel })
      const ch = res.channel as { latest?: { ts?: string } } | undefined
      await this.pace()
      return ch?.latest?.ts ?? null
    } catch (err) {
      // Bootstrap is best-effort; a failure just means we retry next cycle.
      console.warn(`[slack] info failed (${this.teamName} ${channel}):`, (err as Error).message)
      return null
    }
  }

  /** Max 15 messages/call on the Tier-1 limit; we request 15. */
  private async fetchSince(channel: string, oldest: string): Promise<SlackMessage[]> {
    const res = await this.web.conversations.history({
      channel,
      oldest,
      inclusive: false,
      limit: 15,
    })
    await this.pace()
    return ((res.messages ?? []) as SlackMessage[])
      .slice()
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
  }

  private async toCapturedItem(
    conv: SlackConversation,
    msg: SlackMessage
  ): Promise<CapturedItem | null> {
    // Skip system messages (joins, topic changes, etc.) and any bot output.
    if (msg.subtype) return null
    if (msg.bot_id) return null
    if (msg.user && msg.user === this.selfUserId) {
      // Own messages are noise for "what others want from me" — drop them.
      // (Mentions of self authored by others still pass; that's the signal.)
      return null
    }
    const rawText = msg.text?.trim()
    if (!rawText) return null

    const isDm = !!conv.is_im || !!conv.is_mpim
    const mentionsSelf = rawText.includes(`<@${this.selfUserId}>`)
    const authorName = await this.userName(msg.user)
    const text = await this.resolveMentions(rawText)

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
        authorName,
        // Identity signals for the Proposer: this message is from someone else
        // (own messages are dropped above). mentionsSelf=true means the user is
        // being addressed/asked — a request FOR the user, not a delegation.
        fromSelf: false,
        mentionsSelf,
        selfName: this.selfName,
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
