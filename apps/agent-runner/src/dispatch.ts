/**
 * Session dispatcher entrypoint — run on a computer whose Claude Code sessions
 * the inbox agents may hand work to (see session-dispatch.ts):
 *
 *   AI_SERVICE_URL=http://<server>:3030 AI_SERVICE_TOKEN=… AGENT_RUNNER_TOKEN=… bun run dispatch.ts
 *
 * Install as a launchd agent with install-dispatcher.sh. It has to run inside
 * the user's login session: from a plain SSH shell Claude Code cannot reach
 * the keychain and is not signed in.
 */

import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SIGNATURE, DispatchClient, startDispatcher, type DispatchConfig } from './session-dispatch'

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number((raw ?? '').trim() || NaN)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const baseUrl = process.env.AI_SERVICE_URL ?? ''
const token = process.env.AI_SERVICE_TOKEN ?? ''
const runnerToken = process.env.AGENT_RUNNER_TOKEN ?? ''
if (!baseUrl || !token || !runnerToken) {
  console.error('[session-dispatch] AI_SERVICE_URL, AI_SERVICE_TOKEN and AGENT_RUNNER_TOKEN are required')
  process.exit(1)
}

const machine = (process.env.AGENT_DISPATCH_MACHINE || hostname().split('.')[0] || 'computer')
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^[^a-z0-9]+/, '')
  .slice(0, 60)

const cfg: DispatchConfig = {
  machine,
  pollMs: Math.max(1000, num(process.env.AGENT_DISPATCH_POLL_MS, 3000)),
  indexEveryMs: 20_000,
  days: num(process.env.AGENT_DISPATCH_DAYS, 30),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  senderModel: process.env.AGENT_DISPATCH_SENDER_MODEL || 'haiku',
  permissionMode: process.env.AGENT_DISPATCH_PERMISSION_MODE ?? 'auto',
  signature: process.env.AGENT_DISPATCH_SIGNATURE || DEFAULT_SIGNATURE,
  workDir: process.env.AGENT_DISPATCH_DIR || join(homedir(), '.cache', 'gtd-agents'),
  waitIdleMs: num(process.env.AGENT_DISPATCH_WAIT_IDLE_MIN, 30) * 60_000,
  turnTimeoutMs: num(process.env.AGENT_DISPATCH_TURN_TIMEOUT_MIN, 40) * 60_000,
  concurrency: Math.max(1, Math.floor(num(process.env.AGENT_DISPATCH_CONCURRENCY, 2))),
  log: (msg) => console.log(`${new Date().toISOString()} [session-dispatch] ${msg}`),
}

cfg.log(`machine "${machine}" → ${baseUrl}`)
const dispatcher = startDispatcher(new DispatchClient(baseUrl, token, runnerToken), cfg)

const shutdown = (sig: string) => {
  cfg.log(`${sig} — stopping (${dispatcher.activeCount()} goal(s) in flight; open sessions keep working and are picked up on restart)`)
  dispatcher.stop()
  process.exit(0)
}
// (cast: the installed bun typings only declare the 'memoryPressure' overload)
const signals = process as unknown as { on(event: string, cb: () => void): void }
signals.on('SIGINT', () => shutdown('SIGINT'))
signals.on('SIGTERM', () => shutdown('SIGTERM'))
