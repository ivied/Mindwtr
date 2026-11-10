/**
 * Agent runner entrypoint — run ON THE HOST (not in Docker):
 *
 *   AI_SERVICE_URL=http://localhost:3030 AI_SERVICE_TOKEN=… bun run src/run.ts
 *
 * Install as a launchd agent with ./install-launchd.sh. See README.md for the
 * full list of settings.
 */

import { homedir, hostname } from 'node:os'
import { RunsClient } from './client'
import { startRunner, type RunnerConfig } from './runner'

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number((raw ?? '').trim() || NaN)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const baseUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:3030'
const token = process.env.AI_SERVICE_TOKEN ?? ''
if (!token) {
  console.error('[agent-runner] AI_SERVICE_TOKEN is required (ai-service HTTP_AUTH_TOKEN)')
  process.exit(1)
}

const cfg: RunnerConfig = {
  name: process.env.AGENT_RUNNER_NAME || hostname().split('.')[0] || 'mac',
  concurrency: Math.max(1, Math.floor(num(process.env.AGENT_RUNNER_CONCURRENCY, 2))),
  pollMs: Math.max(1000, num(process.env.AGENT_RUNNER_POLL_MS, 3000)),
  flushMs: 1500,
  cwd: process.env.AGENT_RUNNER_CWD || homedir(),
  model: process.env.AGENT_RUNNER_MODEL || undefined,
  maxBudgetUsd: num(process.env.AGENT_RUNNER_MAX_BUDGET_USD, 3),
  turnTimeoutMs: num(process.env.AGENT_RUNNER_TURN_TIMEOUT_MIN, 30) * 60_000,
  // The agent inherits this environment, including the tokens it needs to
  // query ai-service and Mindwtr (see the system prompt).
  chrome: (process.env.AGENT_RUNNER_CHROME ?? 'true').trim().toLowerCase() !== 'false',
  secretsFile: process.env.AGENT_SECRETS_FILE || undefined,
  env: { ...process.env, AGENT_RUNNER_TOKEN: undefined, AI_SERVICE_URL: baseUrl, AI_SERVICE_TOKEN: token },
}

const runner = startRunner(new RunsClient(baseUrl, token, process.env.AGENT_RUNNER_TOKEN?.trim() ?? ''), cfg)

// In-flight turns die with the process; ai-service parks them as "stopped"
// once the heartbeat goes quiet, and they resume from the UI.
const shutdown = (sig: string) => {
  console.log(`[agent-runner] ${sig} — stopping (${runner.activeCount()} turn(s) in flight)`)
  runner.stop()
  process.exit(0)
}
// (cast: the installed bun typings only declare the 'memoryPressure' overload)
const signals = process as unknown as { on(event: string, cb: () => void): void }
signals.on('SIGINT', () => shutdown('SIGINT'))
signals.on('SIGTERM', () => shutdown('SIGTERM'))
