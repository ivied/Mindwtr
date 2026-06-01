/**
 * Mac worker — the local executor for @ai-agent tasks targeted at this machine.
 *
 * It is a second worker alongside OpenClaw, claiming the SAME way (so the
 * existing agent-watchdog recovers it if it crashes), but instead of running
 * in the cloud it resumes a local Claude Code thread:
 *
 *   poll cloud → claim an `ai-target:mac*` task (ai-stage:queued → doing,
 *   locked-by:mac-<host>) → run `claude --resume <id> -p "<task>"` in the
 *   thread's repo → write the result back + ai-stage:review (or error).
 *
 * Runs on the host (NOT in Docker) — it needs the real `claude` CLI and
 * ~/.claude session store. Start it with `bun run src/mac-worker/run.ts`.
 *
 * SAFETY: launched without `--dangerously-skip-permissions`, so a headless run
 * can read and report but cannot silently merge/deploy. Widen via CLAUDE_EXTRA_ARGS
 * once the routing is trusted (the read-only-first slice we agreed on).
 */

import { spawn } from 'node:child_process'
import type { MindwtrClient, Task } from '../api/mindwtr-client'
import { parseTargetTag } from '../commitment/routing-target'
import { findThread, getRepoPaths } from '../threads/registry'

export interface MacWorkerConfig {
  /** Label used in locked-by:mac-<host>. */
  host: string
  /** Path to the claude CLI. */
  claudeBin: string
  /** Extra args appended to every claude invocation (e.g. --allowedTools …). */
  extraArgs: string[]
  /** Poll interval. Default 60s. */
  intervalMs: number
  /** Per-task wall-clock cap before the run is killed. Default 20 min. */
  timeoutMs: number
  /** Statuses an @ai-agent task may sit in (cloud can't filter by tag). */
  statuses: string[]
}

export const DEFAULT_MAC_WORKER_CONFIG: MacWorkerConfig = {
  host: 'mac',
  claudeBin: 'claude',
  extraArgs: [],
  intervalMs: 60 * 1000,
  timeoutMs: 20 * 60 * 1000,
  statuses: ['next', 'waiting', 'someday', 'inbox'],
}

type Log = (msg: string) => void

export function startMacWorker(
  mindwtr: MindwtrClient,
  cfg: MacWorkerConfig = DEFAULT_MAC_WORKER_CONFIG,
  log: Log = (m) => console.log(`[mac-worker] ${m}`)
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  const tick = async () => {
    if (running) return // never overlap runs
    running = true
    try {
      const task = await claimNext(mindwtr, cfg, log)
      if (task) await runTask(mindwtr, cfg, task, log)
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`)
    } finally {
      running = false
    }
  }

  log(`started on host="${cfg.host}", poll=${cfg.intervalMs}ms`)
  void tick()
  timer = setInterval(tick, cfg.intervalMs)
  return {
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

/** Find one queued mac-targeted @ai-agent task and atomically claim it. */
async function claimNext(mindwtr: MindwtrClient, cfg: MacWorkerConfig, log: Log): Promise<Task | null> {
  for (const status of cfg.statuses) {
    let tasks: Task[]
    try {
      tasks = await mindwtr.listTasks({ status, limit: 500 })
    } catch (err) {
      log(`listTasks(${status}) failed: ${(err as Error).message}`)
      continue
    }
    for (const t of tasks) {
      const tags = t.tags ?? []
      if (t.assignedTo !== '@ai-agent') continue
      if (!tags.includes('ai-stage:queued')) continue
      const target = parseTargetTag(tags)
      if (!target || (target.kind !== 'mac-thread' && target.kind !== 'mac-new')) continue

      // Claim: queued → doing + locked-by. The watchdog reverts this if we die.
      const claimed = stripRuntime(tags).concat(['ai-stage:doing', `locked-by:mac-${cfg.host}`])
      try {
        await mindwtr.updateTask(t.id, { tags: claimed })
      } catch (err) {
        log(`claim(${t.id.slice(0, 8)}) failed: ${(err as Error).message}`)
        continue
      }
      log(`claimed ${t.id.slice(0, 8)} "${(t.title ?? '').slice(0, 50)}"`)
      return { ...t, tags: claimed }
    }
  }
  return null
}

async function runTask(mindwtr: MindwtrClient, cfg: MacWorkerConfig, task: Task, log: Log): Promise<void> {
  const target = parseTargetTag(task.tags)!
  const repo =
    target.kind === 'mac-thread'
      ? findThread(target.sessionId)?.repo ?? 'home'
      : target.kind === 'mac-new'
        ? target.repo
        : 'home'
  const repoPaths = getRepoPaths()
  const cwd = repoPaths[repo] ?? repoPaths.home
  const args =
    target.kind === 'mac-thread'
      ? ['--resume', target.sessionId, '-p', buildPrompt(task), ...cfg.extraArgs]
      : ['-p', buildPrompt(task), ...cfg.extraArgs]

  log(`run ${task.id.slice(0, 8)} → ${target.kind} in ${cwd}`)
  const started = Date.now()
  const result = await runClaude(cfg.claudeBin, args, cwd, cfg.timeoutMs)
  const secs = Math.round((Date.now() - started) / 1000)

  if (result.ok) {
    const note = result.output.trim() || '(agent produced no output)'
    const description = `${task.description ?? ''}\n\n## Agent result (mac · ${secs}s)\n${note}`
    await mindwtr.updateTask(task.id, {
      description,
      tags: stripRuntime(task.tags ?? []).concat(['ai-stage:review']),
    })
    log(`done ${task.id.slice(0, 8)} → review (${secs}s)`)
  } else {
    const reason = (result.error || `exit ${result.code}`).slice(0, 200)
    await mindwtr.updateTask(task.id, {
      description: `${task.description ?? ''}\n\n## Agent error (mac · ${secs}s)\n${reason}`,
      tags: stripRuntime(task.tags ?? []).concat(['ai-stage:error', 'ai-error:mac-run']),
    })
    log(`fail ${task.id.slice(0, 8)} → error: ${reason}`)
  }
}

function buildPrompt(task: Task): string {
  return [
    'You are resuming work on a tracked task from the user’s GTD system.',
    'Do the work, then end with a short plain-language summary of what you did',
    'and anything the user needs to see or decide.',
    '',
    '# Task',
    task.title,
    task.description ? `\n${task.description}` : '',
  ].join('\n')
}

interface RunResult {
  ok: boolean
  output: string
  error: string
  code: number | null
}

function runClaude(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const child = spawn(bin, args, { cwd, env: process.env })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ ok: false, output: out, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, code: null })
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, output: out, error: e.message, code: null })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, output: out, error: err, code })
    })
  })
}

/** Drop the per-run lifecycle tags so we can re-stamp a clean stage. */
function stripRuntime(tags: string[]): string[] {
  return tags.filter(
    (t) =>
      !t.startsWith('ai-stage:') && !t.startsWith('locked-by:') && !t.startsWith('ai-error:')
  )
}
