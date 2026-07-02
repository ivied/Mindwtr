/**
 * EntityRegistryStore — write/read side of the clean entity registry
 * (DB table `entity_registry`, schema v9).
 *
 * This is the "who/what is real" view, kept deliberately separate from the
 * noisy `event_entities` raw mention log and the wiki markdown. The
 * EntityRegistrar (LLM) curates it: it dedups by meaning (folding spelling
 * variants into one canonical slug via `aliases`), assigns a `type`, and links
 * sub-entities to a `parent_slug` for hierarchy.
 *
 * Keep this thin — no LLM, no retrieval logic. Shares the Context Store SQLite
 * handle (pass contextStore.rawDb in).
 */

import type { DB } from '../context-store/db'

export type EntityType =
  | 'project'
  | 'person'
  | 'organization'
  | 'technology'
  | 'topic'
  | 'hobby'

export interface RegistryEntity {
  slug: string
  name: string
  type: EntityType
  aliases: string[]
  parentSlug: string | null
  description: string
  mentionCount: number
  firstSeen: string
  lastSeen: string
  updatedAt: string
}

interface RegistryRow {
  slug: string
  name: string
  type: string
  aliases: string
  parent_slug: string | null
  description: string
  mention_count: number
  first_seen: string
  last_seen: string
  updated_at: string
}

export interface UpsertEntityInput {
  slug: string
  name: string
  type: EntityType
  /** Spelling/slug variants the registrar folded into this entity. */
  aliases?: string[]
  /** Hierarchy parent (must be another registry slug); null = top-level. */
  parentSlug?: string | null
  /** One-line discriminator the registrar wrote. */
  description?: string
  /** ISO ts of the window/event this sighting came from (drives first/last_seen). */
  seenAt?: string
  /** How many mentions to add for this sighting. Default 1. */
  mentions?: number
}

export class EntityRegistryStore {
  constructor(private readonly db: DB) {}

  /**
   * Insert a new entity or update an existing one. On update: bumps
   * mention_count, merges aliases, advances last_seen, and fills in better
   * (non-empty) name/description/parent without clobbering existing values
   * with empties.
   */
  upsert(input: UpsertEntityInput): RegistryEntity {
    const now = new Date().toISOString()
    const seenAt = input.seenAt ?? now
    const mentions = input.mentions ?? 1
    const existing = this.get(input.slug)

    if (existing) {
      const aliases = mergeAliases(existing.aliases, input.aliases ?? [])
      const name = input.name.trim() || existing.name
      const description = input.description?.trim() || existing.description
      const parentSlug =
        input.parentSlug !== undefined ? input.parentSlug : existing.parentSlug
      const firstSeen = seenAt < existing.firstSeen ? seenAt : existing.firstSeen
      const lastSeen = seenAt > existing.lastSeen ? seenAt : existing.lastSeen
      this.db
        .query(
          `UPDATE entity_registry
             SET name = ?, type = ?, aliases = ?, parent_slug = ?, description = ?,
                 mention_count = mention_count + ?, first_seen = ?, last_seen = ?, updated_at = ?
           WHERE slug = ?`
        )
        .run(
          name,
          input.type,
          JSON.stringify(aliases),
          parentSlug,
          description,
          mentions,
          firstSeen,
          lastSeen,
          now,
          input.slug
        )
      return this.get(input.slug)!
    }

    this.db
      .query(
        `INSERT INTO entity_registry
           (slug, name, type, aliases, parent_slug, description, mention_count,
            first_seen, last_seen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.slug,
        input.name.trim(),
        input.type,
        JSON.stringify(input.aliases ?? []),
        input.parentSlug ?? null,
        input.description?.trim() ?? '',
        mentions,
        seenAt,
        seenAt,
        now
      )
    return this.get(input.slug)!
  }

  /**
   * Fold a spelling/slug variant into an existing canonical entity (the
   * registrar decided `variant` is really `canonicalSlug`). Adds the variant to
   * aliases and bumps the mention count. No-op if the canonical entity is
   * missing (caller should upsert it first).
   */
  foldAlias(canonicalSlug: string, variant: string, seenAt?: string, mentions = 1): RegistryEntity | null {
    const existing = this.get(canonicalSlug)
    if (!existing) return null
    const now = new Date().toISOString()
    const at = seenAt ?? now
    const aliases = mergeAliases(existing.aliases, [variant])
    const lastSeen = at > existing.lastSeen ? at : existing.lastSeen
    this.db
      .query(
        `UPDATE entity_registry
           SET aliases = ?, mention_count = mention_count + ?, last_seen = ?, updated_at = ?
         WHERE slug = ?`
      )
      .run(JSON.stringify(aliases), mentions, lastSeen, now, canonicalSlug)
    return this.get(canonicalSlug)
  }

  get(slug: string): RegistryEntity | null {
    const row = this.db
      .query<RegistryRow, [string]>('SELECT * FROM entity_registry WHERE slug = ?')
      .get(slug)
    return row ? rowToEntity(row) : null
  }

  /**
   * Find the canonical entity whose slug OR alias matches the given variant.
   * Lets the registrar / readers resolve a free slug to its canonical home.
   */
  findByAliasOrSlug(variant: string): RegistryEntity | null {
    const direct = this.get(variant)
    if (direct) return direct
    // Aliases stored as JSON array; scan candidates (registry is small — hundreds).
    const rows = this.db
      .query<RegistryRow, []>('SELECT * FROM entity_registry')
      .all()
    for (const row of rows) {
      const e = rowToEntity(row)
      if (e.aliases.includes(variant)) return e
    }
    return null
  }

  /** Registry entries with mention_count ≥ min, sorted by mention_count desc. */
  list(minMentions = 0, limit = 1000): RegistryEntity[] {
    const rows = this.db
      .query<RegistryRow, [number, number]>(
        'SELECT * FROM entity_registry WHERE mention_count >= ? ORDER BY mention_count DESC LIMIT ?'
      )
      .all(minMentions, limit)
    return rows.map(rowToEntity)
  }

  /** Direct children of a parent slug (hierarchy). */
  childrenOf(parentSlug: string): RegistryEntity[] {
    const rows = this.db
      .query<RegistryRow, [string]>(
        'SELECT * FROM entity_registry WHERE parent_slug = ? ORDER BY mention_count DESC'
      )
      .all(parentSlug)
    return rows.map(rowToEntity)
  }

  count(): number {
    const r = this.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entity_registry')
      .get()
    return r?.n ?? 0
  }
}

function rowToEntity(r: RegistryRow): RegistryEntity {
  return {
    slug: r.slug,
    name: r.name,
    type: r.type as EntityType,
    aliases: parseAliases(r.aliases),
    parentSlug: r.parent_slug,
    description: r.description,
    mentionCount: r.mention_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    updatedAt: r.updated_at,
  }
}

function parseAliases(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0) : []
  } catch {
    return []
  }
}

function mergeAliases(a: string[], b: string[]): string[] {
  const set = new Set<string>()
  for (const x of [...a, ...b]) {
    const t = x.trim()
    if (t) set.add(t)
  }
  return [...set]
}
