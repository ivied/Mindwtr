/**
 * Context retriever — given a new captured text, find related past tasks
 * via Mindwtr SQLite FTS search and format them as priorContext for the LLM.
 *
 * Pure keyword-based retrieval for MVP. Vector embeddings will replace this
 * later (sqlite-vec or external store) without changing the contract.
 */

import type { MindwtrClient } from '../api/mindwtr-client'

export interface RetrieverConfig {
  /** Max past tasks to surface to the classifier */
  topK: number
  /** Min keyword length (filters articles, single chars) */
  minKeywordLength: number
  /** Min query keywords to bother searching (avoid noise) */
  minKeywords: number
}

export const DEFAULT_RETRIEVER_CONFIG: RetrieverConfig = {
  topK: 5,
  minKeywordLength: 4,
  minKeywords: 1,
}

/** Common stopwords (en + ru) — extend as needed. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'would',
  'should', 'could', 'about', 'into', 'just', 'than', 'then', 'them', 'they',
  'their', 'there', 'these', 'those', 'what', 'when', 'where', 'which', 'while',
  'screen', 'capture', 'window', 'title', 'http', 'https', 'localhost',
  'это', 'этот', 'для', 'или', 'нет', 'как', 'что', 'так', 'тоже', 'если',
  'была', 'были', 'есть', 'надо', 'нужно', 'буду', 'будет', 'может',
])

export function extractKeywords(text: string, config = DEFAULT_RETRIEVER_CONFIG): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= config.minKeywordLength && !STOPWORDS.has(t))

  // Dedupe, preserve order
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

interface RetrievedTask {
  id: string
  title: string
  status: string
  contexts: string[]
  tags: string[]
}

export class ContextRetriever {
  constructor(
    private mindwtr: MindwtrClient,
    private config: RetrieverConfig = DEFAULT_RETRIEVER_CONFIG
  ) {}

  /**
   * Returns a formatted multi-line string of similar past tasks, or empty
   * string when nothing relevant found.
   */
  async retrieve(text: string): Promise<string> {
    const keywords = extractKeywords(text, this.config)
    if (keywords.length < this.config.minKeywords) return ''

    const query = keywords.slice(0, 6).join(' ')
    let tasks: RetrievedTask[] = []
    try {
      const result = await this.mindwtr.search(query)
      tasks = (result.tasks ?? []) as RetrievedTask[]
    } catch {
      return ''
    }

    if (tasks.length === 0) return ''

    const top = tasks.slice(0, this.config.topK)
    return formatTasks(top)
  }
}

function formatTasks(tasks: RetrievedTask[]): string {
  const lines = tasks.map((t) => {
    const ctx = t.contexts.length > 0 ? ` ${t.contexts.join(' ')}` : ''
    const tags = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : ''
    return `- (${t.status})${ctx}${tags} ${t.title}`
  })
  return `Past similar items:\n${lines.join('\n')}`
}
