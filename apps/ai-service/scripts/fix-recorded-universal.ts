/**
 * One-off backfill: mark every chunk of recorded playbooks ('user' source,
 * path under recorded/) as 'universal' + classified_by='user'.
 *
 * Pre-fix, the distiller only flipped the first chunk matched by path (the
 * leading HTML-comment preamble), leaving the real step chunks hidden as
 * 'openclaw-only'. This repairs already-distilled sessions so the Proposer
 * can see them. New sessions are handled correctly by the patched distiller.
 *
 * Run inside the ai-service container:
 *   bun run apps/ai-service/scripts/fix-recorded-universal.ts
 */

import { join } from 'node:path'
import { ContextStore } from '../src/context-store/store'
import { ProceduralStore } from '../src/memory/procedural/store'

const DATA_DIR = process.env.DATA_DIR ?? '/app/data'

const store = ContextStore.open(
  { dbPath: join(DATA_DIR, 'context.db'), ttlMs: 7 * 24 * 60 * 60 * 1000 },
)

const procedural = new ProceduralStore({
  db: store.rawDb,
  vecAvailable: store.hasVectorSearch,
})

const { items } = procedural.listChunks({ source: 'user', limit: 500 })
const recorded = items.filter((c) => c.path.startsWith('recorded/'))

let flipped = 0
for (const c of recorded) {
  if (c.appliesTo === 'universal' && c.classifiedBy === 'user') continue
  procedural.classify(c.id, 'universal', 'user')
  flipped += 1
  console.log(
    `→ universal: ${c.path}#${c.sectionIndex} (${c.sectionTitle ?? '(preamble)'})`,
  )
}

console.log(
  `Done. recorded chunks=${recorded.length}, flipped=${flipped}.`,
)
