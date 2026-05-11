/**
 * Curator pipeline orchestrator — runs A→B→C→D as one logical pass.
 *
 * Ordering rationale:
 *   A (GC):     reduce noise first so later passes work on a smaller,
 *               cleaner entity set.
 *   B (Merger): collapse duplicates next so synthesis and clustering
 *               see the canonical version of each entity.
 *   C (Synth):  writes per-entity About sections; depends on stable
 *               slugs (post-B) so the LLM doesn't redundantly summarize
 *               the same thing twice under different names.
 *   D (Cluster):builds topic pages from the now-canonical graph and
 *               can reuse the About text for member previews.
 *
 * Phases are skippable via options for partial runs (e.g. nightly
 * full run vs. interval gc-only run).
 */

import { runGarbageCollector, type GarbageCollectorResult } from './garbage-collector'
import { runMerger, type MergerResult } from './merger'
import { runSynthesizer, type SynthesizerResult } from './synthesizer'
import { runClusterer, type ClustererResult } from './clusterer'
import type { LlmClient } from '../llm-client'

export interface CuratorPipelineOptions {
  wikiDir: string
  llm: LlmClient
  /** Which phases to run. Default: all four. */
  phases?: Array<'gc' | 'merge' | 'synth' | 'cluster'>
  /** When true, no files are modified — useful for sanity-checks. */
  dryRun?: boolean
  log?: (msg: string) => void
  now?: () => Date
}

export interface CuratorPipelineResult {
  gc?: GarbageCollectorResult
  merge?: MergerResult
  synth?: SynthesizerResult
  cluster?: ClustererResult
  elapsedMs: number
}

export async function runCuratorPipeline(
  options: CuratorPipelineOptions
): Promise<CuratorPipelineResult> {
  const phases = new Set(options.phases ?? ['gc', 'merge', 'synth', 'cluster'])
  const log = options.log ?? (() => {})
  const startedAt = Date.now()
  const out: CuratorPipelineResult = { elapsedMs: 0 }

  if (phases.has('gc')) {
    log('[curator] phase A: garbage collector')
    out.gc = await runGarbageCollector({
      wikiDir: options.wikiDir,
      dryRun: options.dryRun,
      now: options.now,
      log,
    })
    log(
      `[curator]   scanned=${out.gc.scanned} kept=${out.gc.kept} archived=${out.gc.archived} protected=${out.gc.protected}`
    )
  }

  if (phases.has('merge')) {
    log('[curator] phase B: merger')
    out.merge = await runMerger({
      wikiDir: options.wikiDir,
      dryRun: options.dryRun,
      log,
    })
    log(
      `[curator]   scanned=${out.merge.scanned} groups=${out.merge.groupsFound} merged=${out.merge.merged} losers=${out.merge.losersArchived} refsRewritten=${out.merge.refsRewritten}`
    )
  }

  if (phases.has('synth')) {
    log('[curator] phase C: synthesizer')
    out.synth = await runSynthesizer({
      wikiDir: options.wikiDir,
      llm: options.llm,
      dryRun: options.dryRun,
      now: options.now,
      log,
    })
    log(
      `[curator]   scanned=${out.synth.scanned} eligible=${out.synth.eligible} synthesized=${out.synth.synthesized} errors=${out.synth.errors}`
    )
  }

  if (phases.has('cluster')) {
    log('[curator] phase D: clusterer')
    out.cluster = await runClusterer({
      wikiDir: options.wikiDir,
      dryRun: options.dryRun,
      now: options.now,
      log,
    })
    log(
      `[curator]   scanned=${out.cluster.scanned} clusters=${out.cluster.clustersFound} written=${out.cluster.topicsWritten} removed=${out.cluster.topicsRemoved}`
    )
  }

  out.elapsedMs = Date.now() - startedAt
  log(`[curator] done in ${out.elapsedMs}ms`)
  return out
}
