/**
 * Standalone entry point for the curator loop. Run from a separate Terminal:
 *
 *   bun run src/wiki/curator/curator-runner.ts
 *
 * Wakes every WIKI_CURATOR_INTERVAL_MS (default 1 hour), runs one
 * pipeline pass (A→B→C→D), logs the result. Stops gracefully on
 * SIGINT/SIGTERM.
 *
 * Env vars (same shape as rollup-runner):
 *   AGENT_WIKI_DIR           — required
 *   WIKI_LLM_BASE_URL        — required (synth phase)
 *   WIKI_LLM_API_KEY         — required (synth phase)
 *   WIKI_LLM_MODEL           — default cc/claude-opus-4-6
 *   WIKI_CURATOR_INTERVAL_MS — default 3_600_000 (1h)
 *   WIKI_CURATOR_DRY_RUN     — "1" to dry-run every pass (no writes)
 *   WIKI_CURATOR_PHASES      — CSV like "gc,merge"; default all
 */

import { LlmClient } from '../llm-client'
import { runCuratorPipeline } from './pipeline'

async function main() {
  const wikiRoot = process.env.AGENT_WIKI_DIR
  const baseUrl = process.env.WIKI_LLM_BASE_URL
  const apiKey = process.env.WIKI_LLM_API_KEY
  const model = process.env.WIKI_LLM_MODEL ?? 'cc/claude-opus-4-6'
  const intervalMs = Number(process.env.WIKI_CURATOR_INTERVAL_MS ?? 3_600_000)
  const dryRun = process.env.WIKI_CURATOR_DRY_RUN === '1'
  const phasesEnv = process.env.WIKI_CURATOR_PHASES
  const phases = phasesEnv
    ? (phasesEnv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as Array<'gc' | 'merge' | 'synth' | 'cluster'>)
    : undefined

  if (!wikiRoot) throw new Error('AGENT_WIKI_DIR is required')
  if (!baseUrl) throw new Error('WIKI_LLM_BASE_URL is required')
  if (!apiKey) throw new Error('WIKI_LLM_API_KEY is required')

  const llm = new LlmClient({ baseUrl, apiKey, model })

  console.log(`🧹 Curator runner starting`)
  console.log(`   wiki: ${wikiRoot}`)
  console.log(`   model: ${model}`)
  console.log(`   interval: ${intervalMs}ms (${Math.round(intervalMs / 60_000)}m)`)
  console.log(`   phases: ${phases ? phases.join(',') : 'all'}`)
  if (dryRun) console.log(`   dryRun: true (no writes)`)

  let stopped = false
  process.on('SIGINT', () => {
    console.log('🛑 Stopping curator runner')
    stopped = true
  })
  process.on('SIGTERM', () => {
    stopped = true
  })

  while (!stopped) {
    try {
      await runCuratorPipeline({
        wikiDir: wikiRoot,
        llm,
        phases,
        dryRun,
        log: (msg) => console.log(msg),
      })
    } catch (err) {
      console.error(`[curator] FAILED: ${(err as Error).message}`)
    }
    if (stopped) break
    await sleep(intervalMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
