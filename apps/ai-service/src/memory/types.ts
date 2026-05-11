/**
 * Type definitions for the event+facts memory module.
 *
 * Distinct from Context Store: that one stores short-TTL captures used by
 * the Enricher/Proposer for *recent* context. This module stores long-lived
 * events + LLM-extracted facts, used for *historical* context retrieval.
 */

export interface Event {
  id: string
  ts: string
  source: 'screen' | 'audio' | string
  app: string | null
  title: string | null
  body: string
  meta: Record<string, unknown> | null
  capturePath: string | null
  contentHash: string
  ingestedAt: string
}

export interface NewEventInput {
  id: string
  ts: string
  source: string
  app?: string | null
  title?: string | null
  body: string
  meta?: Record<string, unknown> | null
  capturePath?: string | null
}

export type FactType =
  | 'working_on'
  | 'waiting_on'
  | 'met_with'
  | 'knows_about'
  | 'location'
  | 'role'
  | 'status'
  | 'other'

export interface Fact {
  id: number
  statement: string
  entitySlug: string | null
  factType: FactType | string | null
  validFrom: string
  validTo: string | null
  sourceEventId: string | null
  confidence: number | null
  createdAt: string
}

export interface NewFactInput {
  statement: string
  entitySlug?: string | null
  factType?: FactType | string | null
  validFrom: string
  sourceEventId?: string | null
  confidence?: number | null
}

export interface DailySummary {
  date: string
  summary: string
  eventCount: number
  factsAdded: number
  createdAt: string
}

/** A retrieved event with its hybrid-search score breakdown. */
export interface RetrievedEvent extends Event {
  /** Final RRF score after fusing FTS + vector ranks. Higher is better. */
  score: number
  /** Per-channel ranks; useful for debugging "why was this retrieved?". */
  ranks: { fts?: number; vec?: number }
}

export interface FocusContext {
  /** Active facts (valid_to IS NULL) for slugs related to the focus query. */
  activeFacts: Fact[]
  /** Top-K events retrieved by hybrid search against the query. */
  recentEvents: RetrievedEvent[]
  /** Entity slugs that appeared in retrieved events, ranked by frequency. */
  relatedEntities: Array<{ slug: string; mentions: number }>
  /** Optional LLM-synthesized one-paragraph briefing (omitted if no LLM). */
  briefing?: string
}
