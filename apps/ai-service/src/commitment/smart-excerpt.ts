/**
 * Smart source excerpt — locate the Proposer's verbatim evidence quote inside
 * the raw capture text and return a ±N-char window around it. Falls back to
 * first-N-chars when no quote is provided or it can't be located (OCR may
 * render the same phrase differently than the LLM quoted back).
 *
 * Used by writer.ts on proposal creation and by backfill scripts that
 * enrich legacy proposals.
 */

/** Fallback window length (no evidence quote found) — first N chars of source. */
export const TRACEBACK_EXCERPT_FALLBACK_LENGTH = 500
/** When evidence quote found in source, include this many chars on each side. */
export const TRACEBACK_EXCERPT_WINDOW_PAD = 200

export function smartExcerpt(source: string, evidenceQuote: string): string {
  if (!source) return ''
  const quote = evidenceQuote?.trim() ?? ''

  if (quote.length >= 8) {
    const idx = locateQuote(source, quote)
    if (idx >= 0) {
      const start = Math.max(0, idx - TRACEBACK_EXCERPT_WINDOW_PAD)
      const end = Math.min(source.length, idx + quote.length + TRACEBACK_EXCERPT_WINDOW_PAD)
      const slice = source.slice(start, end)
      const prefix = start > 0 ? '…' : ''
      const suffix = end < source.length ? '…' : ''
      return `${prefix}${slice}${suffix}`
    }
  }

  if (source.length <= TRACEBACK_EXCERPT_FALLBACK_LENGTH) return source
  return `${source.slice(0, TRACEBACK_EXCERPT_FALLBACK_LENGTH)}…`
}

/**
 * Locate the evidence quote in the source. Tries direct → case-insensitive →
 * whitespace-collapsed. Returns the index in the ORIGINAL source string, or
 * -1 when not found.
 */
export function locateQuote(source: string, quote: string): number {
  const direct = source.indexOf(quote)
  if (direct >= 0) return direct

  const lower = source.toLowerCase().indexOf(quote.toLowerCase())
  if (lower >= 0) return lower

  // Whitespace-collapsed fallback. Map normalized index back to original by
  // walking both strings in lockstep.
  const normalizedSource: string[] = []
  const sourceToOriginal: number[] = []
  let lastWasSpace = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    const isSpace = /\s/.test(ch)
    if (isSpace) {
      if (lastWasSpace) continue
      normalizedSource.push(' ')
      sourceToOriginal.push(i)
      lastWasSpace = true
    } else {
      normalizedSource.push(ch.toLowerCase())
      sourceToOriginal.push(i)
      lastWasSpace = false
    }
  }
  const normSource = normalizedSource.join('')
  const normQuote = quote.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normQuote) return -1
  const idx = normSource.indexOf(normQuote)
  if (idx < 0) return -1
  return sourceToOriginal[idx] ?? -1
}
