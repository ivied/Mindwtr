/**
 * Mac worker entrypoint — run ON THE HOST (not in Docker):
 *
 *   MINDWTR_CLOUD_URL=… MINDWTR_AUTH_TOKEN=… bun run src/mac-worker/run.ts
 *
 * It polls Mindwtr cloud for @ai-agent tasks targeted at this Mac and resumes
 * the matching Claude Code thread. Reads the same env as ai-service so it drops
 * into the existing .env with no new config.
 */

import { MindwtrClient } from '../api/mindwtr-client'
import { DEFAULT_MAC_WORKER_CONFIG, startMacWorker, type MacWorkerConfig } from './index'

const baseUrl = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
const authToken = process.env.MINDWTR_AUTH_TOKEN ?? ''

if (!authToken) {
  console.error('[mac-worker] MINDWTR_AUTH_TOKEN is required')
  process.exit(1)
}

const cfg: MacWorkerConfig = {
  ...DEFAULT_MAC_WORKER_CONFIG,
  host: process.env.MAC_WORKER_HOST ?? DEFAULT_MAC_WORKER_CONFIG.host,
  claudeBin: process.env.CLAUDE_BIN ?? DEFAULT_MAC_WORKER_CONFIG.claudeBin,
  extraArgs: (process.env.CLAUDE_EXTRA_ARGS ?? '').split(' ').filter(Boolean),
  intervalMs: Number(process.env.MAC_WORKER_INTERVAL_MS ?? DEFAULT_MAC_WORKER_CONFIG.intervalMs),
}

const mindwtr = new MindwtrClient({ baseUrl, authToken })
const { stop } = startMacWorker(mindwtr, cfg)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[mac-worker] ${sig} — stopping`)
    stop()
    process.exit(0)
  })
}
