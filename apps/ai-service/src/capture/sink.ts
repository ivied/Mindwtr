/**
 * Shared capture sink — single ingestion path for ALL captures.
 *
 * Push/pull semantics (FR55):
 *   - Push channels (TG/Slack/Notion DM): write to Context Store + create
 *     Mindwtr inbox task + run AI classification
 *   - Pull/passive channels (screen_capture, future audio): write to
 *     Context Store ONLY. Inbox proposals come later via Commitment
 *     Detector (Phase 4b). For now they just accumulate in Context Store.
 *
 * Dedup is owned by ContextStore.insert() — it returns inserted=false when L2/L3
 * matches, in which case we skip downstream side effects (no inbox task, no LLM).
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassificationQueue } from '../ai/queue'
import type { ClassificationResult } from '../ai/types'
import type { ContextStore } from '../context-store/store'
import type { CapturedItem } from './normalizer'
import { toTaskSuggestion } from './normalizer'

const PULL_CHANNELS = new Set<CapturedItem['sourceChannel']>([
  'screen_capture',
])

function isPull(item: CapturedItem): boolean {
  return PULL_CHANNELS.has(item.sourceChannel)
}

export interface CaptureOptions {
  extraTags?: string[]
  onTaskCreated?: (taskId: string, title: string) => Promise<void>
  onClassified?: (taskId: string, result: ClassificationResult) => Promise<void>
  /** When true, skip inbox creation even for push (used for backfill / replay). */
  contextOnly?: boolean
}

export interface CaptureSinkDeps {
  mindwtr: MindwtrClient
  queue: ClassificationQueue | null
  contextStore: ContextStore | null
}

export function createCaptureSink(deps: CaptureSinkDeps) {
  return async function capture(item: CapturedItem, options: CaptureOptions = {}): Promise<void> {
    // 1. Always write to Context Store first (when configured).
    //    Dedup happens here. inserted=false → skip everything downstream.
    if (deps.contextStore) {
      const result = await deps.contextStore.insert(item)
      if (!result.inserted) return
    }

    // 2. Pull channels stop here in Phase 4a. Inbox proposals come from
    //    Commitment Detector in Phase 4b. Push channels continue to inbox.
    if (isPull(item) || options.contextOnly) return

    // 3. Push channel: create inbox task + classify
    const suggestion = toTaskSuggestion(item)
    const task = await deps.mindwtr.createTask({
      title: suggestion.title,
      status: 'inbox',
      description: suggestion.description,
      tags: options.extraTags,
    })

    if (options.onTaskCreated) {
      await options.onTaskCreated(task.id, task.title)
    }

    if (deps.queue) {
      deps.queue.enqueue({
        taskId: task.id,
        input: {
          text: item.text,
          sourceChannel: item.sourceChannel,
          capturedAt: item.timestamp,
        },
        onComplete: options.onClassified
          ? async (result) => options.onClassified!(task.id, result)
          : undefined,
      })
    }
  }
}

export type CaptureFn = ReturnType<typeof createCaptureSink>
