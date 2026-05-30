/**
 * Reader/index over the activity log (<wiki>/activities/<date>.jsonl).
 *
 * Turns the append-only activity stream into "what's relevant to THIS entity"
 * — the attributed statements (who said / asked / committed what) involving
 * the entity. This is what makes the graph answer "who do I talk to about X"
 * instead of just listing co-occurring nouns. Pure, deterministic, no LLM:
 * the statements are verbatim from what the vision extractor already captured.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSlug } from './entity-extractor'
import type { ActivityRecord, Statement } from './activity-extractor'

export interface StoredActivity extends ActivityRecord {
  ts: string
  capturePath: string
}

export interface EntityStatement {
  ts: string
  /** Headline of the activity this statement came from. */
  activity: string
  who: string
  what: string
  kind: Statement['kind']
}

/** Load activity records, newest first. `days` caps how far back to read. */
export async function loadActivities(
  wikiRoot: string,
  opts: { days?: number; max?: number } = {}
): Promise<StoredActivity[]> {
  const dir = join(wikiRoot, 'activities')
  if (!existsSync(dir)) return []
  let files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  if (opts.days && opts.days > 0) files = files.slice(0, opts.days)
  const out: StoredActivity[] = []
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as StoredActivity)
      } catch {
        /* skip malformed */
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1))
  return opts.max ? out.slice(0, opts.max) : out
}

/**
 * Statements involving an entity. An activity is relevant when the entity is
 * one of its `entities` (by slug) or the entity's name/alias appears among
 * the participants. For a person entity we prefer statements they themselves
 * made; for a project/tool we surface the statements around it.
 */
export function statementsForEntity(
  activities: StoredActivity[],
  entity: { slug: string; name: string; aliases?: string[]; isPerson?: boolean },
  opts: { max?: number } = {}
): EntityStatement[] {
  const names = new Set(
    [entity.name, ...(entity.aliases ?? [])]
      .filter(Boolean)
      .map((n) => n.toLowerCase().trim())
  )
  const matchesName = (s: string) => names.has(s.toLowerCase().trim())

  // Dedup repeated statements: near-identical frames of the same chat produce
  // the same line many times. Key on who+normalized-what; keep the newest
  // (activities are newest-first, so first seen wins).
  const out: EntityStatement[] = []
  const seen = new Set<string>()
  for (const act of activities) {
    const inEntities = act.entities.some((e) => normalizeSlug(e.entity) === entity.slug)
    const inParticipants = act.participants.some(matchesName)
    if (!inEntities && !inParticipants) continue

    for (const st of act.statements) {
      // For a person, keep statements they made; for non-person, keep all
      // statements from activities the entity is part of.
      if (entity.isPerson && !matchesName(st.who)) continue
      const key = `${st.who.toLowerCase().trim()}|${st.what.toLowerCase().replace(/\s+/g, ' ').trim()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ts: act.ts, activity: act.activity, who: st.who, what: st.what, kind: st.kind })
    }
  }
  return opts.max ? out.slice(0, opts.max) : out
}

/**
 * Render the statements as a markdown "## Activity" section body. Deterministic
 * and grounded — no LLM. Returns '' when there's nothing to show.
 */
export function renderActivitySection(statements: EntityStatement[]): string {
  if (statements.length === 0) return ''
  const lines = statements.map((s) => {
    const date = s.ts.slice(0, 10)
    const kind = s.kind && s.kind !== 'said' && s.kind !== 'other' ? ` [${s.kind}]` : ''
    return `- ${date} · **${s.who}**${kind}: ${s.what}`
  })
  return lines.join('\n')
}
