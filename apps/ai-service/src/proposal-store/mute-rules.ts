/**
 * Mute rules — "не предлагай такое".
 *
 * A rule is created from a rejected create-card (POST reject { mute: true }):
 * we store the card's normalized title keywords + source channel. Before the
 * commitment pipeline writes a new proposal, it asks `findMatch` — when a rule
 * matches, the proposal is silently skipped (audited at the pipeline level).
 *
 * Match = same source channel (or rule channel is NULL = any) AND at least
 * MATCH_RATIO of the rule's keywords appear in the candidate title. Keyword
 * overlap (not exact signature) so wording drift doesn't defeat the mute —
 * the whole point is "stop suggesting this KIND of thing".
 */

import { randomUUID } from 'node:crypto'
import type { DB } from '../context-store/db'
import { normalize } from '../commitment/title-signature'

const MATCH_RATIO = 0.6

export interface MuteRule {
  id: string
  sourceChannel: string | null
  keywords: string[]
  sampleTitle: string
  createdAt: string
}

interface MuteRuleRow {
  id: string
  source_channel: string | null
  keywords: string
  sample_title: string
  created_at: string
}

function rowToRule(row: MuteRuleRow): MuteRule {
  let keywords: string[] = []
  try {
    const parsed = JSON.parse(row.keywords)
    if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string')
  } catch {
    // Corrupt row — treat as unmatchable rather than crash the pipeline.
  }
  return {
    id: row.id,
    sourceChannel: row.source_channel,
    keywords,
    sampleTitle: row.sample_title,
    createdAt: row.created_at,
  }
}

export class MuteRuleStore {
  constructor(private db: DB) {}

  /**
   * Create a rule from a card title + channel. Returns null (no rule) when
   * the title normalizes to fewer than 2 keywords — a 1-word rule would mute
   * far too broadly.
   */
  create(input: { title: string; sourceChannel?: string | null }): MuteRule | null {
    const keywords = normalize(input.title).split(' ').filter(Boolean)
    if (keywords.length < 2) return null
    const rule: MuteRule = {
      id: randomUUID(),
      sourceChannel: input.sourceChannel?.trim() || null,
      keywords,
      sampleTitle: input.title.slice(0, 200),
      createdAt: new Date().toISOString(),
    }
    this.db.run(
      `INSERT INTO proposal_mute_rules (id, source_channel, keywords, sample_title, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [rule.id, rule.sourceChannel, JSON.stringify(rule.keywords), rule.sampleTitle, rule.createdAt]
    )
    return rule
  }

  list(): MuteRule[] {
    const rows = this.db
      .query<MuteRuleRow, []>(
        'SELECT id, source_channel, keywords, sample_title, created_at FROM proposal_mute_rules ORDER BY created_at DESC'
      )
      .all()
    return rows.map(rowToRule)
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM proposal_mute_rules WHERE id = ?', [id])
    return result.changes > 0
  }

  /**
   * First rule matching the candidate title/channel, or null. Called on the
   * pipeline hot path — rules are few (user-created), so a full scan is fine.
   */
  findMatch(title: string, sourceChannel: string | null | undefined): MuteRule | null {
    const words = new Set(normalize(title).split(' ').filter(Boolean))
    if (words.size === 0) return null
    for (const rule of this.list()) {
      if (rule.sourceChannel && rule.sourceChannel !== (sourceChannel ?? '')) continue
      if (rule.keywords.length === 0) continue
      const hits = rule.keywords.filter((k) => words.has(k)).length
      if (hits / rule.keywords.length >= MATCH_RATIO) return rule
    }
    return null
  }
}
