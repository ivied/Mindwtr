/**
 * Shared capture sink — single ingestion path for ALL captures.
 *
 * Push/pull semantics (FR55):
 *   - Push channels (TG/Slack/Notion DM): write to Context Store + create
 *     Mindwtr inbox task + fire-and-forget Enricher pipeline (which writes a
 *     modify-or-split Proposal for the user to review in the desktop web UI).
 *   - Pull/passive channels (screen_capture, audio_capture): write to
 *     Context Store ONLY. Inbox proposals come later via Commitment Detector.
 *
 * Dedup is owned by ContextStore.insert() — it returns inserted=false when L2/L3
 * matches, in which case we skip downstream side effects (no inbox task, no LLM).
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ContextStore } from '../context-store/store'
import type { CommitmentPipeline } from '../commitment/pipeline'
import type { EnricherPipeline } from '../commitment/enricher-pipeline'
import type { CaptureRecord } from '../context-store/types'
import type { IngestService } from '../memory'
import type { CapturedItem } from './normalizer'
import { toTaskSuggestion } from './normalizer'

const PULL_CHANNELS = new Set<CapturedItem['sourceChannel']>([
  'screen_capture',
  'audio_capture',
])

function isPull(item: CapturedItem): boolean {
  return PULL_CHANNELS.has(item.sourceChannel)
}

export interface CaptureOptions {
  extraTags?: string[]
  onTaskCreated?: (taskId: string, title: string) => Promise<void>
  /** When true, skip inbox creation even for push (used for backfill / replay). */
  contextOnly?: boolean
}

export interface CaptureSinkDeps {
  mindwtr: MindwtrClient
  contextStore: ContextStore | null
  /** Push-channel enrichment. Fire-and-forget; writes Proposals. */
  enricherPipeline?: EnricherPipeline | null
  /** When set, pull captures fire through this pipeline (async, fire-and-forget). */
  commitmentPipeline?: CommitmentPipeline | null
  /** When set, every persisted capture is also fire-and-forget ingested into
   *  the long-lived memory module (events + LLM-extracted facts). Independent
   *  of the short-TTL Context Store. */
  memoryIngest?: IngestService | null
}

export function createCaptureSink(deps: CaptureSinkDeps) {
  return async function capture(item: CapturedItem, options: CaptureOptions = {}): Promise<void> {
    // 1. Always write to Context Store first (when configured).
    //    Dedup happens here. inserted=false → skip everything downstream.
    let storedRecord: CaptureRecord | null = null
    if (deps.contextStore) {
      const result = await deps.contextStore.insert(item)
      if (!result.inserted) return
      storedRecord = result.capture
    }

    // 1b. Memory module ingest. Fire-and-forget — failure here must not
    //     block the inbox / commitment path. Persists the event (with
    //     embedding) and runs the unified extractor for entities + facts.
    if (deps.memoryIngest && storedRecord) {
      const captured = storedRecord
      const src = item.sourceChannel === 'audio_capture' ? 'audio' : 'screen'
      const meta = (item.sourceMeta ?? {}) as Record<string, unknown>
      const app =
        (typeof meta.app === 'string' ? meta.app : undefined) ?? item.sourceChannel
      const title = typeof meta.title === 'string' ? meta.title : ''
      const url = typeof meta.url === 'string' ? meta.url : undefined
      void deps.memoryIngest
        .live({
          id: captured.id,
          ts: captured.capturedAt,
          source: src,
          app,
          title,
          url,
          body: captured.text,
          meta,
        })
        .catch((err) =>
          console.error(`[sink] memory ingest failed for ${captured.id}:`, err)
        )
    }

    // 2. Pull channels: fire-and-forget Commitment Detector, then stop.
    //    Inbox proposals (when LLM says actionable) are written by the pipeline.
    if (isPull(item) || options.contextOnly) {
      if (isPull(item) && deps.commitmentPipeline && storedRecord) {
        const record = storedRecord
        void deps
          .commitmentPipeline
          .run(record)
          .catch((err) =>
            console.error(`[sink] commitment pipeline failed for ${record.id}:`, err)
          )
      }
      return
    }

    // 3. Push channel: create inbox task + fire-and-forget Enricher.
    const suggestion = toTaskSuggestion(item)
    const initialTags = options.extraTags ?? []
    const task = await deps.mindwtr.createTask({
      title: suggestion.title,
      status: 'inbox',
      description: suggestion.description,
      tags: initialTags,
    })

    if (options.onTaskCreated) {
      await options.onTaskCreated(task.id, task.title)
    }

    if (deps.enricherPipeline) {
      const sourceCaptureId = storedRecord?.id ?? null
      void deps
        .enricherPipeline
        .run({
          taskId: task.id,
          taskTitle: task.title,
          taskTags: initialTags,
          text: item.text,
          sourceChannel: item.sourceChannel,
          sourceMeta: item.sourceMeta ?? null,
          sourceCaptureId,
        })
        .catch((err) =>
          console.error(`[sink] enricher pipeline failed for task ${task.id}:`, err)
        )
    }
  }
}

export type CaptureFn = ReturnType<typeof createCaptureSink>
