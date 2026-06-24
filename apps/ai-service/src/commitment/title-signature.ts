/**
 * Normalized title/signature matching for proposals.
 *
 * Extracted from the Writer's dedup logic so other parts of the pipeline
 * (e.g. the suggestion refresher) can match an incoming capture's intended
 * title against existing pending create-proposals using the same rules.
 *
 * The signature is a bag-of-words: lowercase, punctuation-stripped, stopwords
 * dropped, sorted — so word order and filler words don't defeat the match
 * ("Send Alice X" == "Send the X to Alice").
 */

import type { ProposalRecord } from '../proposal-store/types'
import type { ProposalPayload } from '../proposal-store/payloads'

// Stopwords are dropped from title normalization so dedup is robust against
// the LLM emitting "Send Alice X" vs "Send Alice the X" on consecutive ticks.
// Bag-of-words + sort makes word order irrelevant ("X to Alice" == "to Alice X").
const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'with', 'for', 'to', 'in', 'on', 'at',
  'of', 'by', 'from', 'as', 'is', 'are', 'be', 'this', 'that', 'these', 'those',
])
const STOPWORDS_RU = new Set([
  'и', 'или', 'но', 'для', 'на', 'в', 'с', 'к', 'по', 'до', 'от', 'из', 'у', 'о',
  'об', 'про', 'через', 'над', 'под', 'это', 'эти', 'тот', 'та',
])

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS_EN.has(w) && !STOPWORDS_RU.has(w))
    .sort()
    .join(' ')
}

export function buildSignature(
  title: string,
  whoTo: string | null,
  byWhen: string | null
): string {
  return [normalize(title), normalize(whoTo ?? ''), normalize(byWhen ?? '')].join('|')
}

/** Build the same signature shape from a stored Proposal, or null when not a create. */
export function signatureForRecord(p: ProposalRecord): string | null {
  const payload = p.currentPayload as ProposalPayload | null
  if (!payload || payload.kind !== 'create') return null
  const meta = payload.task.metadata as Record<string, unknown> | undefined
  const whoTo = typeof meta?.ai_who_to === 'string' ? meta.ai_who_to : null
  const byWhen = typeof meta?.ai_by_when === 'string' ? meta.ai_by_when : null
  return buildSignature(payload.task.title, whoTo, byWhen)
}
