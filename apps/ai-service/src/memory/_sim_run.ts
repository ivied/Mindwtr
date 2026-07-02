/**
 * TEMP full data-layer simulation runner (throwaway, in-container, copy DB).
 *
 * Walks events oldest→newest in fixed windows, starting from EMPTY memory
 * (registry + cards + facts + questions all cleared first). Each window:
 *   1. EntityRegistrar.runWindow  → registry grows; touched slugs come back
 *   2. CardSynthesizer.synthesize → cards/facts/questions for touched slugs
 * Honest day-by-day accumulation: each step only knows the past.
 *
 * Env:
 *   REGISTRY_DB=/app/data/_sim.db           (default; a fresh copy)
 *   SIM_WINDOW_HOURS=4
 *   SIM_PAUSE_MS=1200
 *   SIM_LIMIT_WINDOWS=50                     (small run; omit for full)
 *   SIM_FROM / SIM_TO                        (ISO; default = full events range)
 */

import { openDb } from '../context-store/db'
import { LLMClient } from '../ai/client'
import { MemoryStore } from './store'
import { EntityRegistryStore } from './entity-registry-store'
import { EntityRegistrar } from './entity-registrar'
import {
  ensureSimTables,
  resetSimTables,
  CardStore,
  CardSynthesizer,
  applyCardUpdates,
  addFacts,
  addQuestions,
} from './_sim_data_layer'

function envOr(name: string, fb?: string): string {
  const v = process.env[name]
  if (v) return v
  if (fb !== undefined) return fb
  throw new Error(`${name} required`)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function parseRetryAfterMs(msg: string, fb: number): number {
  const m = msg.match(/reset after\s+(?:(\d+)m)?\s*(?:(\d+)s)?/i)
  if (!m) return fb
  const ms = ((m[1] ? +m[1] : 0) * 60 + (m[2] ? +m[2] : 0)) * 1000
  return ms > 0 ? ms + 5000 : fb
}
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let a = 1; ; a++) {
    try {
      return await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const is429 = msg.includes('429') || /usage limit/i.test(msg)
      if (!is429 || a > 12) throw e
      const w = parseRetryAfterMs(msg, 60_000)
      console.log(`   ⏳ 429 on ${label} (try ${a}) — wait ${Math.round(w / 1000)}s`)
      await sleep(w)
    }
  }
}

async function main() {
  const dbPath = envOr('REGISTRY_DB', '/app/data/_sim.db')
  const windowHours = Number(process.env.SIM_WINDOW_HOURS ?? '4')
  const pauseMs = Number(process.env.SIM_PAUSE_MS ?? '1200')
  const limit = process.env.SIM_LIMIT_WINDOWS ? Number(process.env.SIM_LIMIT_WINDOWS) : undefined
  // Skip thin/ambient windows so a capped run spends its budget on substantive ones.
  const minEvents = Number(process.env.SIM_MIN_EVENTS ?? '0')

  const { db, vecAvailable } = openDb(dbPath)
  const memory = new MemoryStore({ db, vecAvailable })
  const registry = new EntityRegistryStore(db)
  ensureSimTables(db)
  resetSimTables(db)
  db.exec('DELETE FROM entity_registry') // honest start: empty memory

  const llm = new LLMClient(envOr('LLM_BASE_URL'), envOr('LLM_API_KEY'), {
    opus: envOr('LLM_MODEL_OPUS'),
    sonnet: envOr('LLM_MODEL_SONNET'),
  })
  const model = envOr('LLM_MODEL_OPUS')
  const registrar = new EntityRegistrar({ registry, memory, llm, model })
  const cards = new CardStore(db)
  const synth = new CardSynthesizer(llm, model)

  const b = db
    .query<{ lo: string; hi: string; n: number }, []>('SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) n FROM events')
    .get()!
  const from = process.env.SIM_FROM ?? b.lo
  const to = process.env.SIM_TO ?? b.hi

  console.log(`🧪 Data-layer simulation (empty start)`)
  console.log(`   db: ${dbPath}  events: ${b.n} [${b.lo}..${b.hi}]`)
  console.log(`   range: ${from}..${to}  window: ${windowHours}h  pause: ${pauseMs}ms  limit: ${limit ?? '∞'}`)
  console.log(`   model: ${model}\n`)

  const stepMs = windowHours * 3_600_000
  let cursor = Date.parse(from)
  const endMs = Date.parse(to)
  let wi = 0
  const started = Date.now()

  while (cursor < endMs) {
    const wStart = new Date(cursor).toISOString()
    const wEnd = new Date(Math.min(cursor + stepMs, endMs)).toISOString()
    const events = memory.eventsBetween(wStart, wEnd, 5000)

    if (events.length <= minEvents) {
      // thin window — skip silently, does NOT consume the window budget
      cursor += stepMs
      continue
    }
    wi++

    // 1) entity pass
    const entRes = await withRetry(`entity ${wStart.slice(5, 16)}`, () => registrar.runWindow(wStart, wEnd))
    const touched = [...new Set(entRes.decisions.map((d) => d.slug))]

    // 2) card pass over touched entities
    let cardN = 0
    let factN = 0
    let qN = 0
    if (touched.length > 0) {
      const active = touched.map((slug) => {
        const reg = registry.get(slug)
        return { slug, type: reg?.type ?? 'topic', card: cards.get(slug) }
      })
      const sr = await withRetry(`card ${wStart.slice(5, 16)}`, () =>
        synth.synthesize(events, active, wEnd)
      )
      applyCardUpdates(cards, sr.cards, wEnd)
      addFacts(db, sr.facts, wEnd)
      addQuestions(db, sr.questions, wEnd)
      cardN = sr.cards.length
      factN = sr.facts.length
      qN = sr.questions.length
    }

    console.log(
      `[w${pad(wi)}] ${wStart.slice(5, 16)}–${wEnd.slice(11, 16)}  ev=${String(events.length).padStart(4)}  ` +
        `ent=${String(entRes.applied).padStart(2)} card=${String(cardN).padStart(2)} fact=${String(factN).padStart(2)} q=${String(qN).padStart(2)}  ` +
        `[reg=${registry.count()} cards=${cards.count()}]  ${touched.slice(0, 12).join(' ')}`
    )

    if (limit && wi >= limit) {
      console.log(`\n(stop at SIM_LIMIT_WINDOWS=${limit})`)
      break
    }
    cursor += stepMs
    if (pauseMs > 0 && cursor < endMs) await sleep(pauseMs)
  }

  const el = Math.round((Date.now() - started) / 1000)
  const qCount = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM glossary_questions').get()!.c
  const fCount = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM sim_facts').get()!.c
  console.log(`\n✅ done ${el}s — reg=${registry.count()} cards=${cards.count()} facts=${fCount} questions=${qCount}`)
}

function pad(n: number): string {
  return String(n).padStart(3, '0')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
