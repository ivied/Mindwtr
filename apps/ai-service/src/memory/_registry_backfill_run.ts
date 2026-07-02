/**
 * TEMP backfill-simulation runner for EntityRegistrar.
 * Runs inside the ai-service container against a COPY of context.db
 * (_registry_backfill.db), never the live DB. Throwaway script.
 */

import { openDb } from '../context-store/db'
import { LLMClient } from '../ai/client'
import { MemoryStore } from './store'
import { EntityRegistryStore } from './entity-registry-store'
import { EntityRegistrar, type WindowResult } from './entity-registrar'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Parse "reset after 8m 27s" / "reset after 9m" from a 429 body. Returns ms, fallback if absent. */
function parseRetryAfterMs(msg: string, fallbackMs: number): number {
  const m = msg.match(/reset after\s+(?:(\d+)m)?\s*(?:(\d+)s)?/i)
  if (!m) return fallbackMs
  const min = m[1] ? Number(m[1]) : 0
  const sec = m[2] ? Number(m[2]) : 0
  const ms = (min * 60 + sec) * 1000
  return ms > 0 ? ms + 5000 : fallbackMs // +5s slack
}

/** Run one window, retrying on 429 usage-limit until it clears. */
async function runWindowResilient(
  registrar: EntityRegistrar,
  startIso: string,
  endIso: string
): Promise<WindowResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await registrar.runWindow(startIso, endIso)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const is429 = msg.includes('429') || /usage limit/i.test(msg)
      if (!is429 || attempt > 12) throw e
      const waitMs = parseRetryAfterMs(msg, 60_000)
      console.log(
        `   ⏳ 429 on ${startIso.slice(5, 16)} (attempt ${attempt}) — waiting ${Math.round(waitMs / 1000)}s for reset`
      )
      await sleep(waitMs)
    }
  }
}

function envOr(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v) return v
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

async function main() {
  const dbPath = envOr('REGISTRY_DB', '/app/data/_registry_backfill.db')
  const windowHours = Number(process.env.REGISTRY_WINDOW_HOURS ?? '4')
  const pauseMs = Number(process.env.REGISTRY_PAUSE_MS ?? '1500')
  const limitWindows = process.env.REGISTRY_LIMIT_WINDOWS
    ? Number(process.env.REGISTRY_LIMIT_WINDOWS)
    : undefined

  const { db, vecAvailable } = openDb(dbPath)
  const memory = new MemoryStore({ db, vecAvailable })
  const registry = new EntityRegistryStore(db)

  const llm = new LLMClient(envOr('LLM_BASE_URL'), envOr('LLM_API_KEY'), {
    opus: envOr('LLM_MODEL_OPUS'),
    sonnet: envOr('LLM_MODEL_SONNET'),
  })

  // bounds of the events table
  const bounds = db
    .query<{ lo: string | null; hi: string | null; n: number }, []>(
      'SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) n FROM events'
    )
    .get()
  if (!bounds?.lo || !bounds.hi) throw new Error('no events in db')

  const from = process.env.REGISTRY_FROM ?? bounds.lo
  const to = process.env.REGISTRY_TO ?? bounds.hi

  console.log(`📚 EntityRegistrar backfill simulation`)
  console.log(`   db:        ${dbPath}`)
  console.log(`   events:    ${bounds.n}  [${bounds.lo} .. ${bounds.hi}]`)
  console.log(`   range:     ${from} .. ${to}`)
  console.log(`   window:    ${windowHours}h   pause: ${pauseMs}ms`)
  console.log(`   model:     ${envOr('LLM_MODEL_OPUS')}`)
  console.log(`   registry start count: ${registry.count()}`)
  console.log()

  const registrar = new EntityRegistrar({
    registry,
    memory,
    llm,
    model: envOr('LLM_MODEL_OPUS'),
  })

  let wi = 0
  const started = Date.now()
  const stepMs = windowHours * 3_600_000
  let cursor = Date.parse(from)
  const endMs = Date.parse(to)
  while (cursor < endMs) {
    const wStart = new Date(cursor).toISOString()
    const wEnd = new Date(Math.min(cursor + stepMs, endMs)).toISOString()
    const r = await runWindowResilient(registrar, wStart, wEnd)
    wi++
    const slugs = r.decisions
      .map((d) => `${d.decision === 'new' ? '+' : '='}${d.slug}`)
      .join(' ')
    console.log(
      `[w${String(wi).padStart(3, '0')}] ${r.startIso.slice(5, 16)}–${r.endIso.slice(11, 16)}  ` +
        `events=${String(r.eventCount).padStart(4)} applied=${String(r.applied).padStart(2)} ` +
        `total=${String(registry.count()).padStart(3)}  ${slugs}`
    )
    if (limitWindows && wi >= limitWindows) {
      console.log(`\n(stopping early at REGISTRY_LIMIT_WINDOWS=${limitWindows})`)
      break
    }
    cursor += stepMs
    if (pauseMs > 0 && cursor < endMs) await sleep(pauseMs)
  }

  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log()
  console.log(`✅ done in ${elapsed}s — registry now has ${registry.count()} entities`)
  console.log()

  // dump the resulting registry, grouped, for inspection
  const all = registry.list(0, 5000)
  const byType = new Map<string, typeof all>()
  for (const e of all) {
    const arr = byType.get(e.type) ?? []
    arr.push(e)
    byType.set(e.type, arr)
  }
  for (const [type, arr] of [...byType.entries()].sort()) {
    console.log(`\n=== ${type.toUpperCase()} (${arr.length}) ===`)
    for (const e of arr.sort((a, b) => b.mentionCount - a.mentionCount)) {
      const parent = e.parentSlug ? ` ⊂ ${e.parentSlug}` : ''
      const aliases = e.aliases.length ? ` (aka ${e.aliases.slice(0, 4).join(', ')})` : ''
      console.log(`  ${String(e.mentionCount).padStart(3)}× ${e.slug}${parent}${aliases} — ${e.description}`)
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
