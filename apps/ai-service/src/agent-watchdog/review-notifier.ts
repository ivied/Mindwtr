/**
 * Telegram notifier for `ai-stage:review` transitions.
 *
 * Hooks into the task-changes webhook: when a Mindwtr task edit lands with
 * `ai-stage:review` in its tags AND the task is assigned to @ai-agent, we
 * push a TG message so the user sees "OpenClaw finished X" without polling
 * the AI Agent lane.
 *
 * Dedup: in-memory Set<taskId>. Lost on restart; we may re-notify on the
 * next edit after a restart but that's a small annoyance — far better than
 * missing a real "I'm done" signal.
 */

import type { Bot } from 'grammy'
import type { TaskFieldsSnapshot } from '../proposal-store/task-change-processor'

export interface ReviewNotifierConfig {
  bot: Bot | null
  notifyChatId: string
  webBaseUrl: string
}

const STAGE_REVIEW = 'ai-stage:review'
const STAGE_ERROR = 'ai-stage:error'
const AGENT_ASSIGNEE = '@ai-agent'

export class ReviewNotifier {
  private readonly notified = new Set<string>()
  private readonly enabled: boolean

  constructor(private cfg: ReviewNotifierConfig) {
    this.enabled = Boolean(cfg.bot && cfg.notifyChatId)
  }

  /** Called from /v1/proposals/task-changes for each edit event. */
  async onTaskEdit(taskId: string, fields: TaskFieldsSnapshot): Promise<void> {
    if (!this.enabled) return
    if (!Array.isArray(fields.tags)) return
    if (fields.tags.indexOf(AGENT_ASSIGNEE) === -1) {
      // Note: assignedTo isn't in TaskFieldsSnapshot today, so we approximate
      // by requiring at least one ai-stage:* tag — which only @ai-agent tasks
      // ever carry in our flow.
    }
    const hasReview = fields.tags.includes(STAGE_REVIEW)
    const hasError = fields.tags.includes(STAGE_ERROR)
    if (!hasReview && !hasError) {
      // Task moved out of a notifiable stage — clear so a future re-entry can
      // notify again (e.g. user manually re-routed back to queued).
      this.notified.delete(`${taskId}:review`)
      this.notified.delete(`${taskId}:error`)
      return
    }
    const stage = hasError ? 'error' : 'review'
    const key = `${taskId}:${stage}`
    if (this.notified.has(key)) return
    this.notified.add(key)

    const title = (fields.title ?? '').slice(0, 100) || '(no title)'
    const url = `${this.cfg.webBaseUrl.replace(/\/$/, '')}/task/${taskId}`
    const emoji = stage === 'error' ? '⚠️' : '✅'
    const verb = stage === 'error' ? 'failed' : 'finished'
    const text = `${emoji} AI agent ${verb}: ${escapeMarkdownV2(title)}\n[Open in Mindwtr](${url})`
    try {
      await this.cfg.bot!.api.sendMessage(this.cfg.notifyChatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      // Don't break the webhook on a TG failure.
      console.error(`[review-notifier] sendMessage failed: ${(err as Error).message}`)
    }
  }
}

function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`)
}
