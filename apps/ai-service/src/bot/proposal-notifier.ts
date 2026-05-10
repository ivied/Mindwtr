/**
 * ProposalNotifier — pushes Telegram notifications for new Proposals (FR43).
 *
 * Awareness-only by design: the card carries a one-line summary plus a single
 * `📂 Open in Mindwtr` button that deep-links to the web UI. All decisions
 * (approve / reject / comment / dialogue) happen in the web — Telegram is a
 * lousy place to render diffs and chain text-input prompts, and the moment a
 * proposal is resolved elsewhere any inline buttons here go stale.
 *
 * No-op when notifyChatId is unset.
 */

import { Bot, InlineKeyboard } from 'grammy'
import type { ProposalRecord, ProposalStatus } from '../proposal-store/types'
import type { ProposalPayload } from '../proposal-store/payloads'

export interface ProposalNotifierOptions {
  bot: Bot
  /** Telegram chat id (numeric or @username). Disabled when empty. */
  notifyChatId: string
  /** Base URL of the Mindwtr web UI; deep-links open `<base>/?view=proposals&id=<id>`. */
  webBaseUrl: string
}

export class ProposalNotifier {
  private bot: Bot | null
  private chatId: string
  private webBaseUrl: string

  constructor(options: ProposalNotifierOptions) {
    this.chatId = options.notifyChatId.trim()
    this.bot = this.chatId ? options.bot : null
    this.webBaseUrl = options.webBaseUrl.replace(/\/$/, '')
  }

  get enabled(): boolean {
    return this.bot !== null && this.chatId !== ''
  }

  /** Send a notification for a newly-created Proposal. Single Open button. */
  async notifyCreated(p: ProposalRecord): Promise<void> {
    if (!this.enabled) return
    try {
      const text = renderCreated(p)
      const keyboard = new InlineKeyboard().url('📂 Open in Mindwtr', this.deepLink(p.id))
      await this.bot!.api.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    } catch (err) {
      console.warn('[notifier] notifyCreated failed:', (err as Error).message)
    }
  }

  /** Optional resolution ping (text only — no buttons since the proposal is closed). */
  async notifyResolved(p: ProposalRecord, status: ProposalStatus): Promise<void> {
    if (!this.enabled) return
    try {
      const text = renderResolved(p, status)
      await this.bot!.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' })
    } catch (err) {
      console.warn('[notifier] notifyResolved failed:', (err as Error).message)
    }
  }

  private deepLink(proposalId: string): string {
    // AI proposals live inside the Inbox view (bottom zone). The `id` query
    // param auto-expands the matching card.
    return `${this.webBaseUrl}/?view=inbox&id=${encodeURIComponent(proposalId)}`
  }
}

// ---- rendering ----

function renderCreated(p: ProposalRecord): string {
  const summary = summarize(p)
  return [
    '🤖 <b>AI Proposal</b>',
    `<i>${escapeHtml(p.sourceAgent)}</i>`,
    '',
    `<b>${escapeHtml(typeLabel(p))}</b>`,
    summary ? escapeHtml(summary) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function renderResolved(p: ProposalRecord, status: ProposalStatus): string {
  const emoji = STATUS_EMOJI[status] ?? '•'
  return `${emoji} Proposal <code>${escapeHtml(p.id.slice(0, 8))}</code> → <b>${status}</b>`
}

const STATUS_EMOJI: Record<ProposalStatus, string> = {
  pending: '⏳',
  approved: '✅',
  rejected: '❌',
  superseded: '↪️',
  stale: '🕒',
  expired: '🗓️',
}

function typeLabel(p: ProposalRecord): string {
  const payload = p.currentPayload as ProposalPayload | null
  if (!payload || typeof payload !== 'object') return p.type
  switch (payload.kind) {
    case 'create':
      return `Create: ${payload.task.title || '(untitled)'}`
    case 'modify': {
      const fields = payload.diff.map((d) => d.field).join(', ')
      return `Modify task: ${fields || '(no fields)'}`
    }
    case 'delete':
      return `Delete task — ${payload.reason || 'no reason'}`
    case 'move':
      return `Move task → ${payload.toProject ?? '(no project)'}`
    case 'merge':
      return `Merge ${payload.sourceTaskIds.length} tasks`
    case 'split':
      return `Split task into ${payload.resultTasks.length} parts`
  }
  return p.type
}

function summarize(p: ProposalRecord): string {
  const payload = p.currentPayload as ProposalPayload | null
  if (!payload || typeof payload !== 'object') return ''
  switch (payload.kind) {
    case 'create':
      return [payload.task.description, payload.traceback?.captureExcerpt]
        .filter(Boolean)
        .join('\n')
        .slice(0, 400)
    case 'modify':
      return payload.diff
        .map((d) => `• ${d.field}: ${truncate(String((d as { from: unknown }).from), 40)} → ${truncate(String((d as { to: unknown }).to), 40)}`)
        .join('\n')
    case 'delete':
      return payload.reason
    case 'move':
      return `From ${payload.fromProject ?? '(none)'} to ${payload.toProject ?? '(none)'}`
    case 'merge':
      return `Sources: ${payload.sourceTaskIds.join(', ')}`
    case 'split':
      return payload.resultTasks.map((t) => `• ${t.title}`).join('\n')
  }
  return ''
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
