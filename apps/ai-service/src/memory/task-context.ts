/**
 * What memory knows about one task — the block an agent run starts with.
 *
 * `focus-context` starts from whatever events a search returns and then dumps
 * every active fact of the entities those events mention. For a task that is
 * the wrong way round: a short title names its projects and people outright.
 * So here we go from the text to the entities (registry names and aliases),
 * and from the entities to a small, ranked set of facts:
 *
 *   1. confirmed — what the user stated or confirmed; always included, and the
 *      agent is told to treat it as true;
 *   2. inferred — extracted from captured conversations; a hint to verify;
 *   3. a few recent captured messages on the subject.
 */
import type { MemoryStore } from './store'
import type { Fact } from './types'

export interface KnownEntity {
  slug: string
  name: string
  type: string
  aliases: string[]
  mentionCount: number
}

export interface TaskContext {
  entities: Array<{ slug: string; name: string; type: string }>
  /** Confirmed by the user and tied to none of the entities: general rules. */
  general: Fact[]
  /** Confirmed by the user, about the entities in the task. */
  confirmed: Fact[]
  inferred: Fact[]
  events: Array<{ ts: string; source: string; excerpt: string }>
}

export interface TaskContextDeps {
  store: MemoryStore
  /** Entities the registry knows; empty when the entity layer is off. */
  entities: () => KnownEntity[]
  /** Recent captured messages about the text; optional and allowed to fail. */
  searchEvents?: (query: string, limit: number, withinDays: number) => Promise<Array<{ ts: string; source: string; body: string }>>
  now?: () => Date
}

const MAX_ENTITIES = 5
const MAX_INFERRED_PER_ENTITY = 8
/** Facts that share no word with the task are only recent activity: a couple are enough. */
const MAX_UNRELATED_PER_ENTITY = 2
const MAX_INFERRED = 20
const INFERRED_DAYS = 120
const MAX_EVENTS = 5

/** Lowercase, punctuation to spaces — so "HiQ:" and "hiq" compare equal and words keep their borders. */
export const normalize = (text: string): string =>
  ` ${text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `

/** The slug an alias would have if it had been registered on its own ("HighQ Fitness" → "highq-fitness"). */
export const slugOf = (text: string): string => normalize(text).trim().replace(/ /g, '-')

/**
 * Russian names change their ending with the case ("Настя" → "Насте", "Насти"):
 * a one-word Cyrillic name also matches a word that shares everything but the
 * last letter and is about the same length.
 */
function inflected(name: string, words: string[]): boolean {
  if (name.includes(' ') || name.length < 4 || !/^[\u0430-\u044f\u0451]+$/.test(name)) return false
  const stem = name.slice(0, -1)
  return words.some((w) => w.startsWith(stem) && Math.abs(w.length - name.length) <= 2)
}

const TYPE_WEIGHT: Record<string, number> = { project: 3, organization: 3, person: 2, topic: 1, technology: 0, hobby: 0 }

/**
 * Entities the text names: a name or alias must appear as whole words. Short
 * aliases ("PR", "git") and generic technology terms are the usual source of
 * false matches, so they need to be longer to count and rank last.
 */
export function entitiesInText(text: string, known: KnownEntity[]): Array<KnownEntity & { matched: string }> {
  const hay = normalize(text)
  const words = hay.trim().split(' ')
  const found: Array<KnownEntity & { matched: string; score: number }> = []
  for (const entity of known) {
    const minLen = entity.type === 'technology' || entity.type === 'hobby' ? 5 : 3
    let best = ''
    for (const variant of [entity.name, ...entity.aliases, entity.slug.replace(/-/g, ' ')]) {
      const needle = normalize(variant)
      if (needle.trim().length < minLen || needle.trim().length <= best.length) continue
      if (hay.includes(needle) || inflected(needle.trim(), words)) best = needle.trim()
    }
    if (!best) continue
    found.push({
      ...entity,
      matched: best,
      score: (TYPE_WEIGHT[entity.type] ?? 0) * 10 + Math.min(best.length, 20) + Math.log10(1 + entity.mentionCount),
    })
  }
  return found.sort((a, b) => b.score - a.score).slice(0, MAX_ENTITIES)
}

/**
 * Tasks are written in Russian, facts are mostly extracted in English. A few
 * business words are bridged so a task about "инвойс" finds facts about an
 * "invoice"; everything else matches only within one language.
 */
const BRIDGE: Record<string, string[]> = {
  // keys are in normalized form: «й» is folded to «и», «ё» to «е»
  инвои: ['invoi'],
  счет: ['invoi', 'bill'],
  счета: ['invoi', 'bill'],
  оплат: ['payme', 'paid'],
  плате: ['payme', 'paid'],
  часы: ['hours'],
  часов: ['hours'],
  зарпл: ['salar', 'payro'],
  отпус: ['vacat', 'leave', 'timeo'],
  догов: ['contr'],
  контр: ['contr'],
  ставк: ['rate'],
  отчет: ['repor'],
  встре: ['meeti'],
  доступ: ['acces'],
}

const tokens = (text: string, bridge = false): Set<string> => {
  const out = new Set<string>()
  for (const word of normalize(text).split(' ')) {
    if (word.length < 4) continue
    // Crude stem: enough to match "инвойсы" with "инвойс" and "invoices" with "invoice".
    const stem = word.slice(0, 5)
    out.add(stem)
    if (bridge) for (const other of BRIDGE[stem] ?? BRIDGE[word.slice(0, 4)] ?? []) out.add(other)
  }
  return out
}

export class TaskContextAssembler {
  constructor(private deps: TaskContextDeps) {}

  /** Every slug the facts about an entity may be filed under: its own and the ones its aliases would have produced. */
  private slugsOf(entity: KnownEntity): string[] {
    return [...new Set([entity.slug, ...entity.aliases.map(slugOf), slugOf(entity.name)].filter((s) => s.length >= 2))].slice(0, 80)
  }

  async assemble(text: string): Promise<TaskContext> {
    const store = this.deps.store
    const now = (this.deps.now ?? (() => new Date()))()
    const known = this.deps.entities()
    // A fact the user saved may name something the registry has never seen.
    const knownSlugs = new Set(known.map((e) => e.slug))
    const extra: KnownEntity[] = store
      .verifiedSlugs()
      .filter((slug) => !knownSlugs.has(slug))
      .map((slug) => ({ slug, name: slug.replace(/-/g, ' '), type: 'topic', aliases: [], mentionCount: 0 }))
    const entities = entitiesInText(text, [...known, ...extra])

    const general = store.verifiedFacts(null, 40)
    const confirmed: Fact[] = []
    const inferred: Fact[] = []
    const want = tokens(text, true)
    // The entity's own names are in every one of its facts: they say nothing about relevance.
    for (const entity of entities) for (const t of tokens([entity.name, ...entity.aliases].join(' '))) want.delete(t)
    const since = new Date(now.getTime() - INFERRED_DAYS * 86_400_000).toISOString()
    for (const entity of entities) {
      const slugs = this.slugsOf(entity)
      confirmed.push(...store.verifiedFacts(slugs, 40))
      const ranked = store
        .inferredFactsFor(slugs, since, 400)
        .map((fact) => {
          const overlap = [...tokens(fact.statement)].filter((t) => want.has(t)).length
          const ageDays = (now.getTime() - Date.parse(fact.validFrom)) / 86_400_000
          return { fact, score: overlap * 3 + Math.max(0, 1 - ageDays / INFERRED_DAYS) }
        })
        .sort((a, b) => b.score - a.score)
      const related = ranked.filter((r) => r.score >= 3).slice(0, MAX_INFERRED_PER_ENTITY)
      const recent = ranked.filter((r) => r.score < 3).slice(0, MAX_UNRELATED_PER_ENTITY)
      inferred.push(...[...related, ...recent].map((r) => r.fact))
    }

    let events: TaskContext['events'] = []
    if (this.deps.searchEvents) {
      try {
        const hits = await Promise.race([
          this.deps.searchEvents(text.slice(0, 300), MAX_EVENTS * 4, INFERRED_DAYS),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
        ])
        // Screen captures are OCR noise in a prompt; conversations and notes are what helps.
        events = hits.filter((e) => e.source !== 'screen').slice(0, MAX_EVENTS).map((e) => ({ ts: e.ts, source: e.source, excerpt: e.body.replace(/\s+/g, ' ').slice(0, 260) }))
      } catch {
        events = [] // the block is still useful without recent messages
      }
    }

    const seen = new Set<number>()
    const unique = (facts: Fact[]) => facts.filter((f) => !seen.has(f.id) && seen.add(f.id))
    return {
      entities: entities.map(({ slug, name, type }) => ({ slug, name, type })),
      general: unique(general),
      confirmed: unique(confirmed),
      inferred: unique(inferred).slice(0, MAX_INFERRED),
      events,
    }
  }
}

const day = (iso: string): string => iso.slice(0, 10)

/** The block as the agent reads it. Empty string when memory has nothing to say. */
export function renderTaskContext(ctx: TaskContext): string {
  const lines: string[] = []
  const confirmed = [...ctx.confirmed, ...ctx.general]
  if (confirmed.length) {
    lines.push('## Подтверждено пользователем — считай это верным', ...confirmed.map((f) => `- ${f.statement}${f.entitySlug ? ` [${f.entitySlug}]` : ''}`))
  }
  if (ctx.inferred.length) {
    lines.push(
      '',
      '## Выведено из переписки — подсказки, могли устареть; проверь, прежде чем опираться',
      ...ctx.inferred.map((f) => `- (${day(f.validFrom)}) ${f.statement}`)
    )
  }
  if (ctx.events.length) {
    lines.push('', '## Недавние сообщения по теме', ...ctx.events.map((e) => `- (${day(e.ts)}, ${e.source}) ${e.excerpt}`))
  }
  if (!lines.length) return ''
  const about = ctx.entities.length ? `О чём задача по реестру: ${ctx.entities.map((e) => `${e.name} (${e.type})`).join(', ')}.` : ''
  return ['# Что известно из памяти', about, ...lines].filter((l, i) => l !== '' || i > 1).join('\n')
}
