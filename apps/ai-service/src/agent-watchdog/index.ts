/**
 * AI-Agent stale-claim watchdog.
 *
 * OpenClaw claims a task by tagging `ai-stage:doing` + `locked-by:openclaw-…`.
 * If the OpenClaw turn crashes or the host goes offline mid-execution, the
 * task is stuck in `doing` forever. This watchdog scans every N minutes for
 * tasks older than the timeout and reverts them:
 *
 *   doing>2h  →  queued, tags=[…, "ai-retry:<n>"]   (let next cron pick it up)
 *   doing+retry>=3  →  error                          (bail out, user retries)
 *
 * Why on the ai-service side (not OpenClaw): when OpenClaw is dead, there's
 * nobody on its host to recover. ai-service runs 24/7 in Docker.
 */

import type { MindwtrClient } from '../api/mindwtr-client'

export interface AgentWatchdogConfig {
  /** Tasks in `ai-stage:doing` older than this revert to queued. Default 2h. */
  staleAfterMs: number
  /** After this many retries the task is parked in `ai-stage:error`. Default 3. */
  maxRetries: number
  /** Poll interval. Default 10 min. */
  intervalMs: number
}

export const DEFAULT_AGENT_WATCHDOG_CONFIG: AgentWatchdogConfig = {
  staleAfterMs: 2 * 60 * 60 * 1000,
  maxRetries: 3,
  intervalMs: 10 * 60 * 1000,
}

interface MindwtrTaskLite {
  id: string
  title?: string
  tags?: string[]
  updatedAt?: string
  status?: string
}

export function startAgentWatchdog(
  mindwtr: MindwtrClient,
  cfg: AgentWatchdogConfig = DEFAULT_AGENT_WATCHDOG_CONFIG,
  log: (msg: string) => void = (m) => console.log(`[agent-watchdog] ${m}`)
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async () => {
    try {
      const reverted = await sweep(mindwtr, cfg, log)
      if (reverted > 0) log(`tick: reverted ${reverted} stale doing task(s)`)
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`)
    }
  }

  // Fire one sweep at start so a restart immediately recovers stuck tasks.
  void tick()
  timer = setInterval(tick, cfg.intervalMs)

  return {
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

async function sweep(
  mindwtr: MindwtrClient,
  cfg: AgentWatchdogConfig,
  log: (msg: string) => void
): Promise<number> {
  // Statuses an @ai-agent task may legitimately sit in. Mindwtr's /v1/tasks
  // can't filter by tag/assignee, so we pull each status and filter locally.
  const statuses: Array<'next' | 'waiting' | 'someday'> = ['next', 'waiting', 'someday']
  const candidates: MindwtrTaskLite[] = []
  for (const s of statuses) {
    try {
      const tasks = (await mindwtr.listTasks({ status: s, limit: 500 })) as MindwtrTaskLite[]
      for (const t of tasks) {
        if (!Array.isArray(t.tags)) continue
        if (!t.tags.includes('ai-stage:doing')) continue
        candidates.push(t)
      }
    } catch (err) {
      log(`listTasks(${s}) failed: ${(err as Error).message}`)
    }
  }

  if (candidates.length === 0) return 0

  const now = Date.now()
  let reverted = 0

  for (const task of candidates) {
    const updatedAt = task.updatedAt ? Date.parse(task.updatedAt) : 0
    if (!Number.isFinite(updatedAt) || updatedAt === 0) continue
    const ageMs = now - updatedAt
    if (ageMs < cfg.staleAfterMs) continue

    const tags = task.tags ?? []
    const retryCount = readRetryCount(tags)
    const nextTags = tags
      .filter((t) => t !== 'ai-stage:doing')
      .filter((t) => !t.startsWith('locked-by:'))
      .filter((t) => !t.startsWith('ai-retry:'))

    if (retryCount + 1 > cfg.maxRetries) {
      nextTags.push('ai-stage:error')
      nextTags.push(`ai-error:max-retries-${retryCount + 1}`)
      log(
        `task ${task.id.slice(0, 8)} "${(task.title ?? '').slice(0, 40)}" → error (retries=${retryCount + 1})`
      )
    } else {
      nextTags.push('ai-stage:queued')
      nextTags.push(`ai-retry:${retryCount + 1}`)
      log(
        `task ${task.id.slice(0, 8)} "${(task.title ?? '').slice(0, 40)}" → queued (retry ${retryCount + 1}, age ${Math.round(ageMs / 60000)}m)`
      )
    }

    try {
      await mindwtr.updateTask(task.id, { tags: nextTags })
      reverted += 1
    } catch (err) {
      log(`updateTask(${task.id.slice(0, 8)}) failed: ${(err as Error).message}`)
    }
  }

  return reverted
}

function readRetryCount(tags: string[]): number {
  for (const t of tags) {
    if (t.startsWith('ai-retry:')) {
      const n = Number(t.slice('ai-retry:'.length))
      if (Number.isFinite(n)) return n
    }
  }
  return 0
}
