/**
 * EntityPipeline — production background job that keeps the entity layer
 * (registry → cards → facts → About → glossary questions) caught up with the
 * events table. Port of the simulation runner validated on the full May–July
 * history (handoff-entity-registry.md).
 *
 * Per window:
 *   1. EntityRegistrar.runWindow   -> registry grows; touched slugs returned
 *   2. WindowExtractor.extract     -> facts/timeline/open_tasks/questions accumulate
 *   3. AboutSynthesizer (cadenced) -> re-synthesize About+relations when a slug's
 *      fact count grew by >= aboutEvery since the last About
 *   4. TaskRevisor (cadenced)      -> compact 15+-line open_tasks into open+closed
 *
 * Shadow mode: writes only its own tables; nothing reads them yet. The tick is
 * serialized (no overlapping runs) and only processes windows that ended at
 * least `lagMs` ago so a window's captures are complete.
 */

import type { DB } from '../context-store/db'
import type { LLMClient } from '../ai/client'
import type { MemoryStore } from './store'
import type { EntityRegistrar } from './entity-registrar'
import type { EntityRegistryStore } from './entity-registry-store'
import {
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
} from './entity-cards'

const JOB_NAME = 'entity-pipeline'

export interface EntityPipelineOptions {
  db: DB
  memory: MemoryStore
  registry: EntityRegistryStore
  registrar: EntityRegistrar
  llm: LLMClient
  model?: string
  ownerSlug: string
  /** Window size. Default 4h. */
  windowMs?: number
  /** Only process windows that ended at least this long ago. Default 30min. */
  lagMs?: number
  /** Skip windows with fewer events than this. Default 20. */
  minEvents?: number
  /** Split oversized windows into chunks of <= this many events. Default 80. */
  chunkEvents?: number
  /** Re-synth About after +N facts. Default 4. */
  aboutEvery?: number
  /** Run TaskRevisor every N processed windows. Default 3. */
  reviseEvery?: number
  /** Revise task lists with at least this many lines. Default 15. */
  reviseMinTasks?: number
  /** Max windows per tick (bounds LLM spend per tick). Default 3. */
  maxWindowsPerTick?: number
  log?: (msg: string) => void
}

export class EntityPipeline {
  private readonly cards: CardStore
  private readonly extractor: WindowExtractor
  private readonly aboutSynth: AboutSynthesizer
  private readonly revisor: TaskRevisor
  private readonly windowMs: number
  private readonly lagMs: number
  private readonly minEvents: number
  private readonly chunkEvents: number
  private readonly aboutEvery: number
  private readonly reviseEvery: number
  private readonly reviseMinTasks: number
  private readonly maxWindowsPerTick: number
  private readonly log: (msg: string) => void
  private windowsSinceRevision = 0
  private running = false

  constructor(private readonly opts: EntityPipelineOptions) {
    this.cards = new CardStore(opts.db)
    this.extractor = new WindowExtractor(opts.llm, opts.model)
    this.aboutSynth = new AboutSynthesizer(opts.llm, opts.model)
    this.revisor = new TaskRevisor(opts.llm, opts.model)
    this.windowMs = opts.windowMs ?? 4 * 3_600_000
    this.lagMs = opts.lagMs ?? 30 * 60_000
    this.minEvents = opts.minEvents ?? 20
    this.chunkEvents = opts.chunkEvents ?? 80
    this.aboutEvery = opts.aboutEvery ?? 4
    this.reviseEvery = opts.reviseEvery ?? 3
    this.reviseMinTasks = opts.reviseMinTasks ?? 15
    this.maxWindowsPerTick = opts.maxWindowsPerTick ?? 3
    this.log = opts.log ?? (() => {})
  }

  cardStore(): CardStore {
    return this.cards
  }

  /** Process up to maxWindowsPerTick due windows. Serialized; safe to call on a timer. */
  async tick(): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 }
    this.running = true
    try {
      let processed = 0
      while (processed < this.maxWindowsPerTick) {
        const did = await this.processNextWindow()
        if (!did) break
        processed++
      }
      return { processed }
    } finally {
      this.running = false
    }
  }

  private cursor(): string {
    const row = this.opts.db
      .query<{ cursor: string }, [string]>('SELECT cursor FROM job_cursors WHERE job = ?')
      .get(JOB_NAME)
    if (row) return row.cursor
    // First run: start from the beginning of events (backfilled DBs carry
    // their knowledge over via the migrated sim tables + cursor seed).
    const lo = this.opts.db.query<{ lo: string | null }, []>('SELECT MIN(ts) lo FROM events').get()?.lo
    return lo ?? new Date().toISOString()
  }

  private setCursor(iso: string): void {
    this.opts.db
      .query(
        `INSERT INTO job_cursors (job, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
      )
      .run(JOB_NAME, iso, new Date().toISOString())
  }

  /** Returns false when no window is due yet. */
  private async processNextWindow(): Promise<boolean> {
    const from = this.cursor()
    const wStartMs = Date.parse(from)
    const wEndMs = wStartMs + this.windowMs
    if (wEndMs > Date.now() - this.lagMs) return false

    const wStart = new Date(wStartMs).toISOString()
    const wEnd = new Date(wEndMs).toISOString()
    const events = this.opts.memory.eventsBetween(wStart, wEnd, 5000)
    if (events.length <= this.minEvents) {
      this.setCursor(wEnd)
      return true
    }

    const subRanges: Array<[string, string]> = []
    if (events.length <= this.chunkEvents) {
      subRanges.push([wStart, wEnd])
    } else {
      const n = Math.ceil(events.length / this.chunkEvents)
      for (let c = 0; c < n; c++) {
        const lo = c === 0 ? wStart : events[c * this.chunkEvents]!.ts
        const hi = c === n - 1 ? wEnd : events[(c + 1) * this.chunkEvents]!.ts
        if (Date.parse(hi) > Date.parse(lo)) subRanges.push([lo, hi])
      }
    }

    const touchedForAbout = new Set<string>()
    let appliedTotal = 0

    for (const [sLo, sHi] of subRanges) {
      const entRes = await this.opts.registrar.runWindow(sLo, sHi)
      appliedTotal += entRes.applied
      const touched = [...new Set(entRes.decisions.map((d) => d.slug))]
      if (touched.length === 0) continue

      const subEvents = this.opts.memory.eventsBetween(sLo, sHi, 5000)
      const hiddenTails = new Map<string, string>()
      const active = touched.map((slug) => {
        const reg = this.opts.registry.get(slug)
        const card = this.cards.get(slug)
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
          timelineTail: card ? timelineTail(card.timeline) : '',
          openTasks: shown,
        }
      })
      const ex = await this.extractor.extract(subEvents, active, wEnd, this.opts.ownerSlug)
      for (const e of ex.entities) {
        const type = this.opts.registry.get(e.slug)?.type ?? e.type
        const tasksAllowed = (type === 'project' || type === 'person') && e.slug !== this.opts.ownerSlug
        // extractor only saw the top of a truncated list; re-append the hidden tail so its replace doesn't drop it
        const tail = hiddenTails.get(e.slug)
        const newTasks = e.open_tasks && tail ? e.open_tasks + '\n' + tail : e.open_tasks
        // omitted field (empty) keeps prior list for allowed types; disallowed types are force-cleared
        this.cards.applyWindow(e.slug, type, e.timeline_additions, tasksAllowed ? newTasks || null : '', wEnd)
      }
      addFacts(this.opts.db, ex.facts, wEnd)
      addQuestions(this.opts.db, ex.questions, wEnd)
      ex.entities.forEach((e) => touchedForAbout.add(e.slug))
      ex.facts.forEach((f) => touchedForAbout.add(f.slug))
    }

    let aboutN = 0
    for (const slug of touchedForAbout) {
      const card = this.cards.get(slug)
      if (!card) continue
      const fc = factCount(this.opts.db, slug)
      const grew = fc - card.facts_at_last_about
      const needsFirst = !card.about && fc >= 2
      if (needsFirst || grew >= this.aboutEvery) {
        const reg = this.opts.registry.get(slug)
        const { about, relations } = await this.aboutSynth.synth(
          slug,
          reg?.type ?? card.type,
          factsFor(this.opts.db, slug)
        )
        if (about) this.cards.setAbout(slug, about, relations, fc, wEnd)
        aboutN++
      }
    }

    let revisedN = 0
    this.windowsSinceRevision++
    if (this.windowsSinceRevision >= this.reviseEvery) {
      this.windowsSinceRevision = 0
      for (const card of this.cards.bloatedTaskCards(this.reviseMinTasks)) {
        const r = await this.revisor.revise(card.slug, card.type, card.open_tasks, timelineTail(card.timeline, 15))
        if (r) {
          this.cards.setTasks(card.slug, r.open_tasks, r.closed_tasks, wEnd)
          revisedN++
        }
      }
    }

    this.setCursor(wEnd)
    this.log(
      `[entity-pipeline] ${wStart.slice(5, 16)}-${wEnd.slice(11, 16)} ev=${events.length}` +
        `${subRanges.length > 1 ? `/${subRanges.length}ch` : ''} ent=${appliedTotal} about=${aboutN}` +
        `${revisedN ? ` rev=${revisedN}` : ''} [reg=${this.opts.registry.count()} cards=${this.cards.count()}]`
    )
    return true
  }
}
