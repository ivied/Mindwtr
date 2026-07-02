/**
 * TEMP data-layer simulation runner v2 (throwaway, container, copy DB).
 *
 * Per window:
 *   1. EntityRegistrar.runWindow      -> registry grows; touched slugs returned
 *   2. WindowExtractor.extract        -> facts/timeline/open_tasks/questions accumulate
 *   3. AboutSynthesizer (cadenced)    -> re-synthesize About+relations from a slug's
 *      accumulated facts, only when its fact count grew by >= ABOUT_EVERY since the
 *      last About (or it has no About yet and has >= 2 facts).
 *
 * This removes the About-drift: a dry window only adds facts; About is derived
 * from the whole fact history, not from "old About + latest window".
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
  WindowExtractor,
  AboutSynthesizer,
  addFacts,
  addQuestions,
  factsFor,
  factCount,
  timelineTail,
} from './_sim_data_layer2'

function envOr(name: string, fb?: string): string {
  const v = process.env[name]
  if (v) return v
  if (fb !== undefined) return fb
  throw new Error(`${name} required`)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const OWNER_SLUG = process.env.SIM_OWNER_SLUG ?? 'sergey-kurdyuk'

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
      const retriable =
        msg.includes('429') ||
        /usage limit/i.test(msg) ||
        (msg.includes('403') && /reset after/i.test(msg)) ||
        /50[0-9]/.test(msg) ||
        /timeout|timed out|ECONNRESET|ECONNREFUSED|ConnectionRefused|Unable to connect|fetch failed/i.test(msg)
      if (!retriable || a > 200) throw e
      const w = parseRetryAfterMs(msg, 60_000)
      console.log(`   429 on ${label} (try ${a}) wait ${Math.round(w / 1000)}s`)
      await sleep(w)
    }
  }
}

async function main() {
  const dbPath = envOr('REGISTRY_DB', '/app/data/_sim2.db')
  const windowHours = Number(process.env.SIM_WINDOW_HOURS ?? '4')
  const pauseMs = Number(process.env.SIM_PAUSE_MS ?? '1000')
  const minEvents = Number(process.env.SIM_MIN_EVENTS ?? '20')
  const limit = process.env.SIM_LIMIT_WINDOWS ? Number(process.env.SIM_LIMIT_WINDOWS) : undefined
  const aboutEvery = Number(process.env.ABOUT_EVERY ?? '4') // re-synth About after +N facts

  const { db, vecAvailable } = openDb(dbPath)
  const memory = new MemoryStore({ db, vecAvailable })
  const registry = new EntityRegistryStore(db)
  ensureSimTables(db)
  if (process.env.SIM_RESUME !== '1') {
    resetSimTables(db)
    db.exec('DELETE FROM entity_registry')
  }

  const llm = new LLMClient(envOr('LLM_BASE_URL'), envOr('LLM_API_KEY'), {
    opus: envOr('LLM_MODEL_OPUS'),
    sonnet: envOr('LLM_MODEL_SONNET'),
  })
  const model = envOr('LLM_MODEL_OPUS')
  const registrar = new EntityRegistrar({ registry, memory, llm, model })
  const cards = new CardStore(db)
  const extractor = new WindowExtractor(llm, model)
  const aboutSynth = new AboutSynthesizer(llm, model)

  const b = db
    .query<{ lo: string; hi: string; n: number }, []>('SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) n FROM events')
    .get()!
  const from = process.env.SIM_FROM ?? b.lo
  const to = process.env.SIM_TO ?? b.hi

  console.log(`Data-layer simulation v2 (empty start, fact-derived About)`)
  console.log(`  db ${dbPath}  events ${b.n} [${b.lo}..${b.hi}]`)
  console.log(`  range ${from}..${to}  window ${windowHours}h  pause ${pauseMs}ms  limit ${limit ?? 'inf'}  aboutEvery ${aboutEvery}`)
  console.log(`  model ${model}\n`)

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
      cursor += stepMs
      continue
    }
    wi++

    // 1) entity pass
    const entRes = await withRetry(`entity ${wStart.slice(5, 16)}`, () => registrar.runWindow(wStart, wEnd))
    const touched = [...new Set(entRes.decisions.map((d) => d.slug))]

    let aboutN = 0
    if (touched.length > 0) {
      // 2) accumulate window signal
      const active = touched.map((slug) => {
        const reg = registry.get(slug)
        const card = cards.get(slug)
        return {
          slug,
          type: reg?.type ?? card?.type ?? 'topic',
          timelineTail: card ? timelineTail(card.timeline) : '',
          openTasks: card?.open_tasks ?? '',
        }
      })
      const ex = await withRetry(`extract ${wStart.slice(5, 16)}`, () => extractor.extract(events, active, wEnd, OWNER_SLUG))
      for (const e of ex.entities) {
        const type = registry.get(e.slug)?.type ?? e.type
        const tasksAllowed = (type === 'project' || type === 'person') && e.slug !== OWNER_SLUG
        // omitted field (empty) keeps prior list for allowed types; disallowed types are force-cleared
        cards.applyWindow(e.slug, type, e.timeline_additions, tasksAllowed ? e.open_tasks || null : '', wEnd)
      }
      addFacts(db, ex.facts, wEnd)
      addQuestions(db, ex.questions, wEnd)

      // 3) cadenced About re-synthesis for entities whose facts grew enough
      const touchedForAbout = new Set([...ex.entities.map((e) => e.slug), ...ex.facts.map((f) => f.slug)])
      for (const slug of touchedForAbout) {
        const card = cards.get(slug)
        if (!card) continue
        const fc = factCount(db, slug)
        const grew = fc - card.facts_at_last_about
        const needsFirst = !card.about && fc >= 2
        if (needsFirst || grew >= aboutEvery) {
          const reg = registry.get(slug)
          const { about, relations } = await withRetry(`about ${slug}`, () =>
            aboutSynth.synth(slug, reg?.type ?? card.type, factsFor(db, slug))
          )
          if (about) cards.setAbout(slug, about, relations, fc, wEnd)
          aboutN++
        }
      }
    }

    console.log(
      `[w${pad(wi)}] ${wStart.slice(5, 16)}-${wEnd.slice(11, 16)}  ev=${String(events.length).padStart(4)}  ` +
        `ent=${String(entRes.applied).padStart(2)} about=${String(aboutN).padStart(2)}  ` +
        `[reg=${registry.count()} cards=${cards.count()}]  ${touched.slice(0, 10).join(' ')}`
    )

    if (limit && wi >= limit) {
      console.log(`\n(stop at SIM_LIMIT_WINDOWS=${limit})`)
      break
    }
    cursor += stepMs
    if (pauseMs > 0 && cursor < endMs) await sleep(pauseMs)
  }

  const el = Math.round((Date.now() - started) / 1000)
  const q = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM glossary_questions').get()!.c
  const f = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM sim_facts').get()!.c
  console.log(`\ndone ${el}s - reg=${registry.count()} cards=${cards.count()} facts=${f} questions=${q}`)
}

function pad(n: number): string {
  return String(n).padStart(3, '0')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
