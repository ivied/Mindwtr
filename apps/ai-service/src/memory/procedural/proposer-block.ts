/**
 * Renders top-N procedural chunks as a KNOWN_PLAYBOOK block for the
 * Proposer's user-message. Same shape as `MemoryProposerContext` (returns
 * a string or null), so the Pipeline can wire it like any other
 * `ProceduralContextProvider`.
 */

import type { ProceduralRetriever } from './retriever'

export interface ProceduralProposerBlockOptions {
  retriever: ProceduralRetriever
  /** Hard cap on total chars of the assembled block. Default 1200. */
  maxChars?: number
  /** Top-K chunks to include before maxChars truncation. Default 5. */
  topK?: number
  /** Restrict retrieval to a single source. Default 'openclaw'. */
  source?: string
  /** Per-chunk excerpt cap, to keep one rule from eating the budget. Default 400. */
  perChunkChars?: number
}

export interface ProceduralContextProvider {
  getPlaybookContext(captureText: string): Promise<string | null>
}

export class ProceduralProposerBlock implements ProceduralContextProvider {
  private readonly maxChars: number
  private readonly topK: number
  private readonly source: string | undefined
  private readonly perChunkChars: number

  constructor(private readonly opts: ProceduralProposerBlockOptions) {
    this.maxChars = opts.maxChars ?? 1200
    this.topK = opts.topK ?? 5
    this.source = opts.source ?? 'openclaw'
    this.perChunkChars = opts.perChunkChars ?? 400
  }

  async getPlaybookContext(captureText: string): Promise<string | null> {
    const q = captureText.slice(0, 1500)
    let chunks
    try {
      chunks = await this.opts.retriever.retrieve({
        query: q,
        limit: this.topK,
        source: this.source,
      })
    } catch {
      return null
    }
    if (chunks.length === 0) return null

    // FR87: retrieval can return several sub-chunks of the same `##`
    // section (e.g. two surviving universal bullet-groups from an
    // otherwise-OpenClaw section). Render the `[source:path ## heading]`
    // tag once and list the excerpts under it, instead of repeating the
    // tag per fragment.
    const lines: string[] = []
    let budget = this.maxChars
    let lastTag: string | null = null
    for (const c of chunks) {
      const tag = `[${c.source}:${c.path}${c.sectionTitle ? ` ${c.sectionTitle}` : ''}]`
      const excerpt = c.text.replace(/\s+/g, ' ').trim().slice(0, this.perChunkChars)
      const piece = tag === lastTag ? excerpt : `${tag}\n${excerpt}`
      if (piece.length > budget) break
      lines.push(piece)
      budget -= piece.length + 1
      lastTag = tag
    }
    if (lines.length === 0) return null
    return lines.join('\n')
  }
}
