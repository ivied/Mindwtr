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
  TaskRevisor,
  addFacts,
  addQuestions,
  factsFor,
  factCount,
  timelineTail,
  taskLines,
  topTasks,
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
        (/40[13]/.test(msg) && /reset after/i.test(msg)) ||
        /50[0-9]/.test(msg) ||
        /timeout|timed out|ECONNRESET|ECONNREFUSED|ConnectionRefused|Unable to connect|fetch failed/i.test(msg)
      if (!retriable || a > 200) throw e
      const w = parseRetryAfterMs(msg, 60_000)
      console.log(`   429 on ${label} (try ${a}) wait ${Math.round(w / 1000)}s :: ${msg.slice(0, 160).replace(/\n/g, ' ')}`)
      await sleep(w)
    }
  }
}

async function main() {
  const dbPath = envOr('REGISTRY_DB', '/app/data/_sim2.db')
  const windowHours = Number(process.env.SIM_WINDOW_HOURS ?? '4')
  const pauseMs = Number(process.env.SIM_PAUSE_MS ?? '1000')
  const minEvents = Number(process.env.SIM_MIN_EVENTS ?? '20')
  const chunkEvents = Number(process.env.SIM_CHUNK_EVENTS ?? '150')
  const limit = process.env.SIM_LIMIT_WINDOWS ? Number(process.env.SIM_LIMIT_WINDOWS) : undefined
  const aboutEvery = Number(process.env.ABOUT_EVERY ?? '4') // re-synth About after +N facts
  const reviseEvery = Number(process.env.REVISE_EVERY ?? '10') // task revision cadence (windows)
  const reviseMinTasks = Number(process.env.REVISE_MIN_TASKS ?? '15')

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
  const revisor = new TaskRevisor(llm, model)

  const b = db
    .query<{ lo: string; hi: string; n: number }, []>('SELECT MIN(ts) lo, MAX(ts) hi, COUNT(*) n FROM events')
    .get()!
  const from = process.env.SIM_FROM ?? b.lo
  const to = process.env.SIM_TO ?? b.hi

  console.log(`Data-layer simulation v2 (empty start, fact-derived About)`)
  console.log(`  db ${dbPath}  events ${b.n} [${b.lo}..${b.hi}]`)
  console.log(`  range ${from}..${to}  window ${windowHours}h  chunk ${chunkEvents}ev  pause ${pauseMs}ms  limit ${limit ?? 'inf'}  aboutEvery ${aboutEvery}`)
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

    // split oversized windows into sub-ranges of <= chunkEvents events so a
    // single LLM request stays under the router's per-minute token limit
    const subRanges: Array<[string, string]> = []
    if (events.length <= chunkEvents) {
      subRanges.push([wStart, wEnd])
    } else {
      const n = Math.ceil(events.length / chunkEvents)
      for (let c = 0; c < n; c++) {
        const lo = c === 0 ? wStart : events[c * chunkEvents]!.ts
        const hi = c === n - 1 ? wEnd : events[(c + 1) * chunkEvents]!.ts
        if (Date.parse(hi) > Date.parse(lo)) subRanges.push([lo, hi])
      }
    }

    const touchedAll = new Set<string>()
    const touchedForAbout = new Set<string>()
    let appliedTotal = 0
    let aboutN = 0

    for (const [sLo, sHi] of subRanges) {
      // 1) entity pass
      const entRes = await withRetry(`entity ${sLo.slice(5, 16)}`, () => registrar.runWindow(sLo, sHi))
      appliedTotal += entRes.applied
      const touched = [...new Set(entRes.decisions.map((d) => d.slug))]
      touched.forEach((s) => touchedAll.add(s))
      if (touched.length === 0) continue

      // 2) accumulate chunk signal
      const subEvents = memory.eventsBetween(sLo, sHi, 5000)
      const hiddenTails = new Map<string, string>()
      const active = touched.map((slug) => {
        const reg = registry.get(slug)
        const card = cards.get(slug)
        const shown = card ? topTasks(card.open_tasks) : ''
        if (card && shown !== card.open_tasks) {
          const shownLines = taskLines(shown) - 1 // minus the "... more" marker
          hiddenTails.set(
            slug,
            card.open_tasks
              .split('\n')
              .filter((l) => l.trim())
              .slice(shownLines)
              .join('\n')
          )
        }
        return {
          slug,
          type: reg?.type ?? card?.type ?? 'topic',
          timelineTail: card ? timelineTail(card.timeline, 5) : '',
          openTasks: shown,
        }
      })
      const ex = await withRetry(`extract ${sLo.slice(5, 16)}`, () => extractor.extract(subEvents, active, wEnd, OWNER_SLUG))
      for (const e of ex.entities) {
        const type = registry.get(e.slug)?.type ?? e.type
        const tasksAllowed = (type === 'project' || type === 'person') && e.slug !== OWNER_SLUG
        // extractor only saw the top of a truncated list; re-append the hidden tail so its replace doesn't drop it
        const tail = hiddenTails.get(e.slug)
        const newTasks = e.open_tasks && tail ? e.open_tasks + '\n' + tail : e.open_tasks
        // omitted field (empty) keeps prior list for allowed types; disallowed types are force-cleared
        cards.applyWindow(e.slug, type, e.timeline_additions, tasksAllowed ? newTasks || null : '', wEnd)
      }
      addFacts(db, ex.facts, wEnd)
      addQuestions(db, ex.questions, wEnd)
      ex.entities.forEach((e) => touchedForAbout.add(e.slug))
      ex.facts.forEach((f) => touchedForAbout.add(f.slug))
    }

    {
      // 3) cadenced About re-synthesis for entities whose facts grew enough
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

    let revisedN = 0
    if (wi % reviseEvery === 0) {
      const bloated = db
        .query<{ slug: string }, [number]>(
          `SELECT slug FROM entity_cards
           WHERE type IN ('project','person') AND open_tasks != ''
             AND (LENGTH(open_tasks) - LENGTH(REPLACE(open_tasks, char(10), '')) + 1) >= ?`
        )
        .all(reviseMinTasks)
      for (const { slug } of bloated) {
        const card = cards.get(slug)!
        const r = await withRetry(`revise ${slug}`, () =>
          revisor.revise(slug, card.type, card.open_tasks, timelineTail(card.timeline, 15))
        )
        if (r) {
          cards.setTasks(slug, r.open_tasks, r.closed_tasks, wEnd)
          revisedN++
          console.log(`   revised ${slug}: ${taskLines(card.open_tasks)} -> ${taskLines(r.open_tasks)} open (+${taskLines(r.closed_tasks)} closed)`)
        }
      }
    }

    console.log(
      `[w${pad(wi)}] ${wStart.slice(5, 16)}-${wEnd.slice(11, 16)}  ev=${String(events.length).padStart(4)}${subRanges.length > 1 ? `/${subRanges.length}ch` : ''}  ` +
        `ent=${String(appliedTotal).padStart(2)} about=${String(aboutN).padStart(2)}${revisedN ? ` rev=${revisedN}` : ''}  ` +
        `[reg=${registry.count()} cards=${cards.count()}]  ${[...touchedAll].slice(0, 10).join(' ')}`
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
