/**
 * Standalone entry point for the rollup loop. Run from a separate Terminal:
 *
 *   bun run src/wiki/rollup-runner.ts
 *
 * Wakes every WIKI_ROLLUP_INTERVAL_MS (default 10 min), runs one rollup pass,
 * logs the result. Stops gracefully on SIGINT/SIGTERM.
 */

import { LlmClient } from './llm-client'
import { runRollup } from './rollup'

async function main() {
  const wikiRoot = process.env.AGENT_WIKI_DIR
  const baseUrl = process.env.WIKI_LLM_BASE_URL
  const apiKey = process.env.WIKI_LLM_API_KEY
  const model = process.env.WIKI_LLM_MODEL ?? 'cc/claude-opus-4-6'
  const intervalMs = Number(process.env.WIKI_ROLLUP_INTERVAL_MS ?? 600_000)

  if (!wikiRoot) throw new Error('AGENT_WIKI_DIR is required')
  if (!baseUrl) throw new Error('WIKI_LLM_BASE_URL is required')
  if (!apiKey) throw new Error('WIKI_LLM_API_KEY is required')

  const llm = new LlmClient({ baseUrl, apiKey, model })

  console.log(`🔄 Rollup runner starting`)
  console.log(`   wiki: ${wikiRoot}`)
  console.log(`   model: ${model}`)
  console.log(`   interval: ${intervalMs}ms (${Math.round(intervalMs / 60_000)}m)`)

  let stopped = false
  process.on('SIGINT', () => {
    console.log('🛑 Stopping rollup runner')
    stopped = true
  })
  process.on('SIGTERM', () => {
    stopped = true
  })

  while (!stopped) {
    const startedAt = Date.now()
    try {
      const result = await runRollup({
        wikiRoot,
        llm,
        log: (msg) => console.log(`[rollup] ${msg}`),
      })
      const elapsed = Date.now() - startedAt
      console.log(
        `[rollup] done: +${result.newCaptures} captures, ${result.entitiesUpdated} entities, ${result.skipped} skipped (${elapsed}ms)`
      )
    } catch (err) {
      console.error(`[rollup] FAILED: ${(err as Error).message}`)
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
