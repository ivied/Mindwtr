/**
 * TEMP consolidation pass over the backfilled registry.
 * One LLM call over the ≥N-mention core: returns merge groups (fold duplicate
 * slugs into one canonical) and a drop list (ambient noise that slipped in).
 * Writes the cleaned result to entity_registry_clean (original kept intact).
 * Throwaway script, runs inside the container on the copy DB.
 */

import { Database } from 'bun:sqlite'
import { LLMClient } from '../ai/client'

function envOr(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v) return v
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is required`)
}

interface Row {
  slug: string
  name: string
  type: string
  parent_slug: string | null
  aliases: string
  description: string
  mention_count: number
  first_seen: string
  last_seen: string
  updated_at: string
}

const CONSOLIDATE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'consolidate',
    description: 'Report duplicate merges and ambient-noise drops over the entity registry core.',
    parameters: {
      type: 'object',
      properties: {
        merges: {
          type: 'array',
          description:
            'Groups of slugs that are the SAME real entity and should fold into one. canonical = the slug to keep; members = the other slugs to fold in (their mentions/aliases merge into canonical).',
          items: {
            type: 'object',
            properties: {
              canonical: { type: 'string' },
              members: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['canonical', 'members'],
          },
        },
        drops: {
          type: 'array',
          description:
            'Slugs that are ambient noise / not a durable entity worth keeping (one-off background apps, generic UI, transient browsing). Be conservative — only clear noise.',
          items: { type: 'string' },
        },
      },
      required: ['merges', 'drops'],
    },
  },
}

async function main() {
  const dbPath = envOr('REGISTRY_DB', '/app/data/_registry_backfill.db')
  const minMentions = Number(process.env.CONSOLIDATE_MIN ?? '3')
  const db = new Database(dbPath)

  const rows = db
    .query<Row, [number]>(
      'SELECT * FROM entity_registry WHERE mention_count >= ? ORDER BY type, mention_count DESC'
    )
    .all(minMentions)

  const listing = rows
    .map((r) => {
      const p = r.parent_slug ? ` parent=${r.parent_slug}` : ''
      const a = JSON.parse(r.aliases || '[]') as string[]
      const al = a.length ? ` aka=[${a.slice(0, 5).join(', ')}]` : ''
      return `${r.slug} [${r.type}] x${r.mention_count}${p}${al} :: ${r.description}`
    })
    .join('\n')

  console.log(`🧹 Consolidation pass over ${rows.length} entities (≥${minMentions} mentions)`)

  const llm = new LLMClient(envOr('LLM_BASE_URL'), envOr('LLM_API_KEY'), {
    opus: envOr('LLM_MODEL_OPUS'),
    sonnet: envOr('LLM_MODEL_SONNET'),
  })

  const system = `You are cleaning up a personal knowledge base's ENTITY REGISTRY. You are given the core entity list (each: slug [type] xMentions parent= aka=[...] :: description).

Two jobs:
1) MERGES — find slugs that are the SAME real entity recorded twice under different slugs (spelling variants, abbreviation vs full name, same project named two ways). Fold them: pick the best slug as canonical, list the others as members. Judge by MEANING + description, not just string overlap. NEVER merge two DIFFERENT real people who merely share a first name (e.g. sergey-kurdyuk vs sergey-kazakov stay separate).
2) DROPS — slugs that are ambient noise, not durable entities: generic background apps/sites browsed once, generic UI, transient topics. Be CONSERVATIVE: when in doubt, keep it. Real projects, real people, real recurring hobbies, real tools = keep.

Call consolidate exactly once.`

  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `REGISTRY CORE:\n${listing}\n\nCall consolidate.` },
    ],
    tools: [CONSOLIDATE_TOOL],
    tool_choice: { type: 'function', function: { name: 'consolidate' } },
    max_tokens: 6000,
    temperature: 0.1,
    model: envOr('LLM_MODEL_OPUS'),
  })

  const call = res.choices[0]?.message?.tool_calls?.[0]
  if (!call) throw new Error('no tool call returned')
  const out = JSON.parse(call.function.arguments) as {
    merges?: { canonical: string; members: string[]; reason?: string }[]
    drops?: string[]
  }
  const merges = out.merges ?? []
  const drops = new Set(out.drops ?? [])

  console.log(`\n=== MERGES (${merges.length}) ===`)
  for (const m of merges) {
    console.log(`  ${m.canonical} ⟵ ${m.members.join(', ')}${m.reason ? '  (' + m.reason + ')' : ''}`)
  }
  console.log(`\n=== DROPS (${drops.size}) ===`)
  console.log('  ' + [...drops].join(', '))

  // Build cleaned set in memory
  const folded = new Map<string, string>() // member -> canonical
  for (const m of merges) for (const mem of m.members) folded.set(mem, m.canonical)

  const kept = new Map<string, Row & { extraAliases: Set<string> }>()
  for (const r of rows) {
    if (drops.has(r.slug)) continue
    if (folded.has(r.slug)) continue // will be folded into canonical
    kept.set(r.slug, { ...r, extraAliases: new Set(JSON.parse(r.aliases || '[]')) })
  }
  // fold members' mentions/aliases into canonicals
  for (const r of rows) {
    const canon = folded.get(r.slug)
    if (!canon) continue
    const target = kept.get(canon)
    if (!target) continue
    target.mention_count += r.mention_count
    target.extraAliases.add(r.slug)
    for (const a of JSON.parse(r.aliases || '[]') as string[]) target.extraAliases.add(a)
  }

  // Write clean table
  db.exec('DROP TABLE IF EXISTS entity_registry_clean')
  db.exec(`CREATE TABLE entity_registry_clean (
    slug TEXT PRIMARY KEY, name TEXT, type TEXT, aliases TEXT, parent_slug TEXT,
    description TEXT, mention_count INTEGER, first_seen TEXT, last_seen TEXT, updated_at TEXT)`)
  const ins = db.prepare(
    'INSERT INTO entity_registry_clean (slug,name,type,aliases,parent_slug,description,mention_count,first_seen,last_seen,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  for (const r of kept.values()) {
    ins.run(
      r.slug,
      r.name,
      r.type,
      JSON.stringify([...r.extraAliases]),
      r.parent_slug,
      r.description,
      r.mention_count,
      r.first_seen,
      r.last_seen,
      r.updated_at
    )
  }

  const finalCount = db.query('SELECT COUNT(*) c FROM entity_registry_clean').get() as { c: number }
  console.log(`\n✅ clean registry: ${finalCount.c} entities (was ${rows.length} core, ${merges.length} merges, ${drops.size} drops)`)

  // dump clean by type
  for (const t of ['project', 'person', 'organization', 'technology', 'topic', 'hobby']) {
    const tr = db
      .query<{ slug: string; parent_slug: string | null; mention_count: number; description: string }, [string]>(
        'SELECT slug,parent_slug,mention_count,description FROM entity_registry_clean WHERE type=? ORDER BY mention_count DESC'
      )
      .all(t)
    if (tr.length === 0) continue
    console.log(`\n=== ${t.toUpperCase()} (${tr.length}) ===`)
    for (const r of tr) {
      const p = r.parent_slug ? ` ⊂ ${r.parent_slug}` : ''
      console.log(`  ${String(r.mention_count).padStart(4)}× ${r.slug}${p} — ${(r.description || '').slice(0, 85)}`)
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
