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
import type { SearchHit } from '../context-store/types'

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
