/**
 * Memory as agent runs see it: facts picked for a task, plus the facts the
 * user confirmed (which outrank everything inferred from captured events).
 * Built from the database alone, so the gateway process and the full service
 * can each have one.
 */
import type { Database } from 'bun:sqlite'
import { EntityRegistryStore } from '../memory/entity-registry-store'
import type { MemoryStore } from '../memory/store'
import { TaskContextAssembler, entitiesInText, renderTaskContext, slugOf, type KnownEntity } from '../memory/task-context'
import type { AgentRunsMemory } from './types'

export interface AgentRunsMemoryDeps {
  db: Database
  store: MemoryStore
  /** Recent captured messages about a text; optional. */
  searchEvents?: (query: string, limit: number, withinDays: number) => Promise<Array<{ ts: string; source: string; body: string }>>
}

export function buildAgentRunsMemory(deps: AgentRunsMemoryDeps): AgentRunsMemory {
  const registry = new EntityRegistryStore(deps.db)
  let cache: { at: number; entities: KnownEntity[] } = { at: 0, entities: [] }
  const entities = (): KnownEntity[] => {
    if (Date.now() - cache.at > 60_000) {
      cache = {
        at: Date.now(),
        entities: registry.list(0, 10_000).map((e) => ({ slug: e.slug, name: e.name, type: e.type, aliases: e.aliases, mentionCount: e.mentionCount })),
      }
    }
    return cache.entities
  }
  const assembler = new TaskContextAssembler({ store: deps.store, entities, searchEvents: deps.searchEvents })
  const item = (f: { id: number; statement: string; entitySlug: string | null; createdAt: string }) => ({
    id: f.id,
    statement: f.statement,
    entity: f.entitySlug,
    createdAt: f.createdAt,
  })
  return {
    taskContext: async (text) => renderTaskContext(await assembler.assemble(text)),
    list: () => deps.store.allVerifiedFacts().map(item),
    save: (statement, entity) => {
      // File it under the entity the registry already knows by that name, so
      // it surfaces whichever spelling a later task uses.
      const slug = entity ? (entitiesInText(entity, entities())[0]?.slug ?? slugOf(entity)) : null
      return item(
        deps.store.insertFact({ statement, entitySlug: slug || null, factType: 'rule', validFrom: new Date().toISOString(), confidence: 1, origin: 'user' })
      )
    },
    remove: (id) => deps.store.closeFact(id, new Date().toISOString()),
  }
}
