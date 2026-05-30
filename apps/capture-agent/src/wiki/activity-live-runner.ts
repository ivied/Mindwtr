/**
 * Live activity runner — keeps "what I'm doing now" fresh for the macOS widget.
 *
 * Separate from the wiki rollup (which builds the graph every ~10 min): this
 * grabs the single newest screen capture every WIKI_LIVE_ACTIVITY_INTERVAL_MS,
 * runs ONE vision+OCR activity extraction, and writes the full ActivityRecord
 * to ~/.gtd-pipeline-activity.json (atomic), then pings the widget to reload.
 *
 * Cost is one vision call per interval *only when the screen changed* (it
 * skips when the newest capture hasn't advanced), so an idle screen costs
 * nothing.
 *
 *   bun run src/wiki/activity-live-runner.ts
 *
 * Env:
 *   AGENT_WIKI_DIR                  — required
 *   WIKI_LLM_BASE_URL / _API_KEY    — required
 *   WIKI_LLM_MODEL                  — default cc/claude-sonnet-4-6
 *   WIKI_LIVE_ACTIVITY_INTERVAL_MS  — default 60000
 *   AGENT_ACTIVITY_STATUS_FILE      — default ~/.gtd-pipeline-activity.json
 *   AGENT_WIDGET_RELOAD_HELPER      — optional, pinged after each write
 */

import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { LlmClient } from './llm-client'
import { parseCaptureMd } from './frontmatter'
import { extractActivity } from './activity-extractor'

async function newestScreenCapture(capturesRoot: string): Promise<string | null> {
  // Walk today's + yesterday's day-dirs (cheap) for the most recent screen .md.
  if (!existsSync(capturesRoot)) return null
  const found: Array<{ path: string; mtime: number }> = []
  const years = await readdir(capturesRoot).catch(() => [])
  // Descend year/month/day, but only the most recent leaf dirs to stay cheap.
  const recentDirs: string[] = []
  for (const y of years.sort().reverse().slice(0, 1)) {
    const months = await readdir(join(capturesRoot, y)).catch(() => [])
    for (const m of months.sort().reverse().slice(0, 1)) {
      const days = await readdir(join(capturesRoot, y, m)).catch(() => [])
      for (const d of days.sort().reverse().slice(0, 2)) {
        recentDirs.push(join(capturesRoot, y, m, d))
      }
    }
  }
  for (const dir of recentDirs) {
    const files = await readdir(dir).catch(() => [])
    for (const f of files) {
      if (!f.endsWith('.md') || !f.includes('-screen-')) continue
      const p = join(dir, f)
      const s = await stat(p).catch(() => null)
      if (s) found.push({ path: p, mtime: s.mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0]?.path ?? null
}

async function main() {
  const wikiRoot = process.env.AGENT_WIKI_DIR
  const baseUrl = process.env.WIKI_LLM_BASE_URL
  const apiKey = process.env.WIKI_LLM_API_KEY
  const model = process.env.WIKI_LLM_MODEL ?? 'cc/claude-sonnet-4-6'
  const intervalMs = Number(process.env.WIKI_LIVE_ACTIVITY_INTERVAL_MS ?? 60_000)
  const outFile =
    process.env.AGENT_ACTIVITY_STATUS_FILE ??
    join(process.env.HOME ?? '', '.gtd-pipeline-activity.json')
  const reloadHelper = process.env.AGENT_WIDGET_RELOAD_HELPER

  if (!wikiRoot) throw new Error('AGENT_WIKI_DIR is required')
  if (!baseUrl || !apiKey) throw new Error('WIKI_LLM_BASE_URL and WIKI_LLM_API_KEY are required')

  const llm = new LlmClient({ baseUrl, apiKey, model })
  const capturesRoot = join(wikiRoot, 'captures')
  console.log(`👁 live-activity runner — every ${Math.round(intervalMs / 1000)}s → ${outFile}`)

  let lastPath = ''
  let stopped = false

  const tick = async () => {
    try {
      const mdPath = await newestScreenCapture(capturesRoot)
      if (!mdPath || mdPath === lastPath) return // no new screen → no vision call
      const raw = await readFile(mdPath, 'utf8')
      const { meta, body } = parseCaptureMd(raw)
      const image = meta.image ? String(meta.image) : ''
      if (!image) return
      const imgPath = join(dirname(mdPath), image)
      if (!existsSync(imgPath)) return
      const b64 = (await readFile(imgPath)).toString('base64')

      const act = await extractActivity(llm, {
        imageBase64: b64,
        ocrText: body,
        app: String(meta.app ?? ''),
        ts: String(meta.ts ?? ''),
      })
      lastPath = mdPath

      const payload = { updatedAt: new Date().toISOString(), ts: String(meta.ts ?? ''), ...act }
      const tmp = join(dirname(outFile), `.${basename(outFile)}.tmp`)
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, outFile)
      console.log(`👁 ${act.activity.slice(0, 80)}`)

      if (reloadHelper) {
        try {
          const c = spawn(reloadHelper, ['PipelineWidget'], { stdio: 'ignore', detached: true })
          c.unref()
          c.on('error', () => {})
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn(`[live-activity] ${(err as Error).message}`)
    }
  }

  const loop = async () => {
    while (!stopped) {
      await tick()
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  const shutdown = () => {
    stopped = true
    console.log('🛑 live-activity runner stopping')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  void loop()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
