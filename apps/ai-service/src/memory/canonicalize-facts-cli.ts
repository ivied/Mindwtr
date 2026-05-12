/**
 * One-shot canonicalization sweep over facts + event_entities tables.
 *
 * Reads the wiki for canonical slugs + aliases, then rewrites every fact
 * and event-entity row whose entity_slug has a known canonical form.
 *
 * Safe to re-run — it's idempotent (already-canonical rows are no-ops).
 *
 * Usage (run inside the ai-service container):
 *
 *   AGENT_WIKI_DIR=/app/wiki DATA_DIR=/app/data \
 *   bun run src/memory/canonicalize-facts-cli.ts
 *
 * Set CANONICALIZE_DRY_RUN=1 to preview without writing.
 */

import { join } from 'node:path'
import { openDb } from '../context-store/db'
import { SlugCanonicalizer } from './slug-canonicalizer'

async function main() {
  const wikiDir = process.env.AGENT_WIKI_DIR
  if (!wikiDir) throw new Error('AGENT_WIKI_DIR is required')
  const dataDir = process.env.DATA_DIR ?? '/app/data'
  const dryRun = process.env.CANONICALIZE_DRY_RUN === '1'

  const canon = new SlugCanonicalizer({ wikiDir, log: console.log })
  await canon.rebuild()

  const { db } = openDb(join(dataDir, 'context.db'))

  // -------- facts --------
  const factRows = db
    .query<{ id: number; entity_slug: string | null }, []>(
      'SELECT id, entity_slug FROM facts WHERE entity_slug IS NOT NULL'
    )
    .all()

  let factPlanned = 0
  let factPassthrough = 0
  const factPlan: Array<{ id: number; from: string; to: string }> = []
  for (const row of factRows) {
    const loose = row.entity_slug!
    const canonical = canon.canonicalOf(loose)
    if (!canonical || canonical === loose) {
      factPassthrough += 1
      continue
    }
    factPlan.push({ id: row.id, from: loose, to: canonical })
    factPlanned += 1
  }
  console.log(`\nFacts: ${factRows.length} total, ${factPlanned} to rewrite, ${factPassthrough} already canonical or unknown`)

  // Sample 10 of the planned rewrites
  for (const p of factPlan.slice(0, 10)) {
    console.log(`  rewrite fact ${p.id}: "${p.from}" → "${p.to}"`)
  }
  if (factPlan.length > 10) console.log(`  ... and ${factPlan.length - 10} more`)

  // -------- event_entities --------
  // event_entities has a composite PK (event_id, entity_slug). Direct UPDATE
  // could conflict if the canonical row already exists, so we DELETE the old
  // row and INSERT OR IGNORE the new one per event. Wrap each event in a
  // transaction; on conflict the OR IGNORE wins.
  const eeRows = db
    .query<{ event_id: string; entity_slug: string }, []>(
      'SELECT event_id, entity_slug FROM event_entities'
    )
    .all()
  let eePlanned = 0
  const eePlan: Array<{ event_id: string; from: string; to: string }> = []
  for (const row of eeRows) {
    const canonical = canon.canonicalOf(row.entity_slug)
    if (!canonical || canonical === row.entity_slug) continue
    eePlan.push({ event_id: row.event_id, from: row.entity_slug, to: canonical })
    eePlanned += 1
  }
  console.log(`\nevent_entities: ${eeRows.length} total, ${eePlanned} to rewrite`)
  for (const p of eePlan.slice(0, 5)) {
    console.log(`  rewrite event_entity (${p.event_id.slice(0, 8)}…): "${p.from}" → "${p.to}"`)
  }
  if (eePlan.length > 5) console.log(`  ... and ${eePlan.length - 5} more`)

  if (dryRun) {
    console.log('\nDRY RUN — no writes performed.')
    return
  }

  // Apply.
  console.log('\nApplying...')
  const updateFact = db.query('UPDATE facts SET entity_slug = ? WHERE id = ?')
  db.transaction(() => {
    for (const p of factPlan) updateFact.run(p.to, p.id)
  })()

  const insertEE = db.query('INSERT OR IGNORE INTO event_entities (event_id, entity_slug) VALUES (?, ?)')
  const deleteEE = db.query('DELETE FROM event_entities WHERE event_id = ? AND entity_slug = ?')
  db.transaction(() => {
    for (const p of eePlan) {
      insertEE.run(p.event_id, p.to)
      deleteEE.run(p.event_id, p.from)
    }
  })()

  // Resulting stats
  const factsByCanon = db
    .query<{ entity_slug: string; n: number }, []>(
      "SELECT entity_slug, COUNT(*) AS n FROM facts WHERE valid_to IS NULL GROUP BY entity_slug ORDER BY n DESC LIMIT 10"
    )
    .all()
  console.log('\nTop 10 active-facts slugs after canonicalization:')
  for (const r of factsByCanon) console.log(`  ${r.entity_slug.padEnd(40)} ${r.n}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
