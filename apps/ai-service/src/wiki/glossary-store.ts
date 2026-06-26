/**
 * GlossaryStore — write side of the glossary decoder ring (DB table `glossary`).
 *
 * The glossary reader (glossary-reader.ts) consults three sources to build the
 * KNOWN_GLOSSARY block: wiki entity frontmatter (type), memory facts
 * (expansion), and THIS table (user-confirmed decodings + rejections). This
 * store owns the last one:
 *   - onboarding scan upserts CANDIDATE rows (status='candidate'),
 *   - the user confirms / edits / rejects them in the wizard,
 *   - confirmed rows are surfaced to the LLM; rejected rows are remembered so
 *     the same shorthand is never re-proposed.
 *
 * Shares the Context Store SQLite handle (pass contextStore.rawDb in).
 */

import type { DB } from '../context-store/db'
import type { ConfirmedGlossarySource, GlossaryEntry, GlossaryKind } from './glossary-reader'

export type GlossaryStatus = 'candidate' | 'confirmed' | 'rejected'
export type GlossarySource = 'onboarding' | 'live' | 'user'

export interface GlossaryRecord {
  slug: string
  term: string
  expansion: string
  kind: GlossaryKind
  aliases: string[]
  status: GlossaryStatus
  source: GlossarySource
  confidence: number | null
  mentionCount: number
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
}

interface GlossaryRow {
  slug: string
  term: string
  expansion: string
  kind: string
  aliases: string
  status: string
  source: string
  confidence: number | null
  mention_count: number
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

export interface UpsertCandidateInput {
  slug: string
  term: string
  kind: GlossaryKind
  expansion?: string
  aliases?: string[]
  confidence?: number | null
  source?: GlossarySource
}

export interface ConfirmInput {
  slug: string
  /** Final expansion the user accepted/edited. Empty allowed (term + kind only). */
  expansion?: string
  /** When the user corrects the term/kind during confirmation. */
  term?: string
  kind?: GlossaryKind
  aliases?: string[]
}

export class GlossaryStore {
  constructor(private readonly db: DB) {}

  /**
   * Insert a candidate or refresh an existing one. Never downgrades a
   * confirmed/rejected row back to candidate — once the user has decided, the
   * scan must not overwrite that decision. For an existing candidate we bump
   * mention_count and keep the better (non-empty / higher-confidence) fields.
   */
  upsertCandidate(input: UpsertCandidateInput): GlossaryRecord {
    const now = new Date().toISOString()
    const existing = this.get(input.slug)
    if (existing) {
      if (existing.status !== 'candidate') {
        // User already confirmed or rejected — leave the decision intact,
        // just count the new sighting.
        this.db
          .query('UPDATE glossary SET mention_count = mention_count + 1, updated_at = ? WHERE slug = ?')
          .run(now, input.slug)
        return this.get(input.slug)!
      }
      const expansion = input.expansion?.trim() || existing.expansion
      const aliases = mergeAliases(existing.aliases, input.aliases ?? [])
      const confidence = pickConfidence(existing.confidence, input.confidence)
      this.db
        .query(
          `UPDATE glossary
             SET term = ?, expansion = ?, kind = ?, aliases = ?, confidence = ?,
                 mention_count = mention_count + 1, updated_at = ?
           WHERE slug = ?`
        )
        .run(
          input.term,
          expansion,
          input.kind,
          JSON.stringify(aliases),
          confidence,
          now,
          input.slug
        )
      return this.get(input.slug)!
    }

    this.db
      .query(
        `INSERT INTO glossary
           (slug, term, expansion, kind, aliases, status, source, confidence,
            mention_count, confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, 1, NULL, ?, ?)`
      )
      .run(
        input.slug,
        input.term,
        input.expansion?.trim() ?? '',
        input.kind,
        JSON.stringify(input.aliases ?? []),
        input.source ?? 'onboarding',
        input.confidence ?? null,
        now,
        now
      )
    return this.get(input.slug)!
  }

  /** Mark a candidate confirmed (optionally editing term/expansion/kind). */
  confirm(input: ConfirmInput): GlossaryRecord | null {
    const existing = this.get(input.slug)
    if (!existing) return null
    const now = new Date().toISOString()
    const term = input.term?.trim() || existing.term
    const expansion = input.expansion !== undefined ? input.expansion.trim() : existing.expansion
    const kind = input.kind ?? existing.kind
    const aliases = input.aliases ? mergeAliases(existing.aliases, input.aliases) : existing.aliases
    this.db
      .query(
        `UPDATE glossary
           SET term = ?, expansion = ?, kind = ?, aliases = ?, status = 'confirmed',
               source = 'user', confirmed_at = ?, updated_at = ?
         WHERE slug = ?`
      )
      .run(term, expansion, kind, JSON.stringify(aliases), now, now, input.slug)
    return this.get(input.slug)
  }

  /** Mark a candidate rejected — remembered so the scan never re-proposes it. */
  reject(slug: string): GlossaryRecord | null {
    const existing = this.get(slug)
    if (!existing) return null
    const now = new Date().toISOString()
    this.db
      .query(
        `UPDATE glossary SET status = 'rejected', source = 'user', updated_at = ? WHERE slug = ?`
      )
      .run(now, slug)
    return this.get(slug)
  }

  get(slug: string): GlossaryRecord | null {
    const row = this.db
      .query<GlossaryRow, [string]>('SELECT * FROM glossary WHERE slug = ?')
      .get(slug)
    return row ? rowToRecord(row) : null
  }

  /** True when a row exists in any status — lets the scan skip already-decided
   *  slugs (confirmed OR rejected) without re-proposing them. */
  isKnown(slug: string): boolean {
    const r = this.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM glossary WHERE slug = ?')
      .get(slug)
    return (r?.n ?? 0) > 0
  }

  listByStatus(status: GlossaryStatus, limit = 200): GlossaryRecord[] {
    const rows = this.db
      .query<GlossaryRow, [string, number]>(
        'SELECT * FROM glossary WHERE status = ? ORDER BY mention_count DESC, updated_at DESC LIMIT ?'
      )
      .all(status, limit)
    return rows.map(rowToRecord)
  }

  countByStatus(status: GlossaryStatus): number {
    const r = this.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM glossary WHERE status = ?')
      .get(status)
    return r?.n ?? 0
  }
}

/**
 * Adapts a GlossaryStore into the reader's ConfirmedGlossarySource: confirmed
 * rows become decoder-ring entries; rejected slugs are surfaced so the reader
 * can suppress them. Synchronous (bun:sqlite) so the reader's scan stays cheap.
 */
export class GlossaryStoreSource implements ConfirmedGlossarySource {
  constructor(private readonly store: GlossaryStore) {}

  confirmedEntries(): GlossaryEntry[] {
    return this.store.listByStatus('confirmed').map((r) => ({
      slug: r.slug,
      term: r.term,
      aliases: r.aliases,
      kind: r.kind,
      expansion: r.expansion,
      mentionCount: r.mentionCount,
    }))
  }

  rejectedSlugs(): Set<string> {
    return new Set(this.store.listByStatus('rejected').map((r) => r.slug))
  }
}

function rowToRecord(r: GlossaryRow): GlossaryRecord {
  return {
    slug: r.slug,
    term: r.term,
    expansion: r.expansion,
    kind: r.kind as GlossaryKind,
    aliases: parseAliases(r.aliases),
    status: r.status as GlossaryStatus,
    source: r.source as GlossarySource,
    confidence: r.confidence,
    mentionCount: r.mention_count,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
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

function pickConfidence(a: number | null, b: number | null | undefined): number | null {
  if (typeof b === 'number') return typeof a === 'number' ? Math.max(a, b) : b
  return a
}
