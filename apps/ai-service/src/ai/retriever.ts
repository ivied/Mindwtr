/**
 * Context retriever — given new captured text, find related past captures
 * from Context Store and format them as priorContext for the Classifier.
 *
 * Uses semantic search when ContextStore has embeddings + sqlite-vec; otherwise
 * falls back to FTS5. Both paths return SearchHit[] which we format here.
 *
 * Legacy keyword-extraction helper is kept for testing and as a last-ditch
 * fallback when no Context Store is available.
 */

import type { ContextStore } from '../context-store/store'
import type { CaptureRecord, SearchHit } from '../context-store/types'

export interface RetrieverConfig {
  topK: number
  /** Min length of query text to bother searching */
  minQueryLength: number
  /** Optional time window for retrieval (ms) — defaults to 7 days */
  withinMs?: number
}

export const DEFAULT_RETRIEVER_CONFIG: RetrieverConfig = {
  topK: 5,
  minQueryLength: 8,
  withinMs: 7 * 24 * 60 * 60 * 1000,
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'would',
  'should', 'could', 'about', 'into', 'just', 'than', 'then', 'them', 'they',
  'their', 'there', 'these', 'those', 'what', 'when', 'where', 'which', 'while',
  'screen', 'capture', 'window', 'title', 'http', 'https', 'localhost',
  'это', 'этот', 'для', 'или', 'нет', 'как', 'что', 'так', 'тоже', 'если',
  'была', 'были', 'есть', 'надо', 'нужно', 'буду', 'будет', 'может',
])

export interface ExtractKeywordsConfig {
  minKeywordLength: number
}

const DEFAULT_EXTRACT_CONFIG: ExtractKeywordsConfig = { minKeywordLength: 4 }

/** Kept for tests and minimal-fallback FTS query construction. */
export function extractKeywords(
  text: string,
  config: ExtractKeywordsConfig = DEFAULT_EXTRACT_CONFIG
): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= config.minKeywordLength && !STOPWORDS.has(t))

  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** Default ±5 min window for cross-channel temporal context. */
export const DEFAULT_TEMPORAL_WINDOW_MS = 5 * 60 * 1000

export class ContextRetriever {
  constructor(
    private store: ContextStore,
    private config: RetrieverConfig = DEFAULT_RETRIEVER_CONFIG
  ) {}

  async retrieve(text: string): Promise<string> {
    if (text.length < this.config.minQueryLength) return ''

    let hits: SearchHit[] = []
    try {
      hits = await this.store.retrieve(text, {
        topK: this.config.topK,
        withinMs: this.config.withinMs,
      })
    } catch (err) {
      console.warn('[retriever] Context Store search failed:', (err as Error).message)
      return ''
    }

    if (hits.length === 0) return ''
    return formatHits(hits)
  }

  /**
   * Cross-channel temporal context: everything captured around `centerIso`
   * ±windowMs, ordered chronologically and tagged so the LLM can see the
   * surrounding multimodal scene (screen OCR + audio transcripts + TG
   * captures that landed in the same minute). Complements semantic
   * `retrieve()` — temporal context catches "the meeting I was just talking
   * about" cases that vec similarity misses when the wording is short.
   */
  temporalContext(
    centerIso: string,
    opts: { windowMs?: number; excludeId?: string; limit?: number } = {}
  ): string {
    const windowMs = opts.windowMs ?? DEFAULT_TEMPORAL_WINDOW_MS
    let captures: CaptureRecord[] = []
    try {
      captures = this.store.recentAroundTimestamp(centerIso, windowMs, {
        excludeId: opts.excludeId,
        limit: opts.limit ?? 20,
      })
    } catch (err) {
      console.warn('[retriever] temporal-context query failed:', (err as Error).message)
      return ''
    }
    if (captures.length === 0) return ''
    const windowMin = Math.round(windowMs / 60_000)
    const header = `Cross-channel activity around capture time (±${windowMin} min, chronological):`
    const lines = captures.map((c) => {
      const ts = c.capturedAt.slice(11, 19) // HH:MM:SS UTC
      const meta = c.sourceMeta && Object.keys(c.sourceMeta).length > 0
        ? ` ${formatMeta(c.sourceMeta)}`
        : ''
      const text = c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text
      return `- [${ts}] [${c.sourceChannel}${meta}] ${text.replace(/\n/g, ' ')}`
    })
    return `${header}\n${lines.join('\n')}`
  }
}

function formatHits(hits: SearchHit[]): string {
  const lines = hits.map((h) => {
    const meta =
      h.capture.sourceMeta && Object.keys(h.capture.sourceMeta).length > 0
        ? ` ${formatMeta(h.capture.sourceMeta)}`
        : ''
    const text = h.capture.text.length > 200 ? `${h.capture.text.slice(0, 200)}…` : h.capture.text
    const score = h.score !== null ? ` (sim ${h.score.toFixed(2)})` : ''
    return `- [${h.capture.sourceChannel}${meta}]${score} ${text.replace(/\n/g, ' ')}`
  })
  return `Past relevant context:\n${lines.join('\n')}`
}

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof meta.app === 'string') parts.push(String(meta.app))
  if (typeof meta.windowTitle === 'string') parts.push(String(meta.windowTitle))
  if (typeof meta.from === 'string') parts.push(`from:${meta.from}`)
  return parts.length > 0 ? parts.join(' · ') : ''
}
