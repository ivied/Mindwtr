/**
 * Shared capture sink: CapturedItem → Mindwtr inbox + AI classification queue.
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassificationQueue } from '../ai/queue'
import type { ClassificationResult } from '../ai/types'
import type { CapturedItem } from './normalizer'
import { toTaskSuggestion } from './normalizer'

export interface CaptureOptions {
  extraTags?: string[]
  onTaskCreated?: (taskId: string, title: string) => Promise<void>
  onClassified?: (taskId: string, result: ClassificationResult) => Promise<void>
}

export function createCaptureSink(
  mindwtr: MindwtrClient,
  queue: ClassificationQueue | null
) {
  return async function capture(item: CapturedItem, options: CaptureOptions = {}): Promise<void> {
    const suggestion = toTaskSuggestion(item)
    const task = await mindwtr.createTask({
      title: suggestion.title,
      status: 'inbox',
      description: suggestion.description,
      tags: options.extraTags,
    })

    if (options.onTaskCreated) {
      await options.onTaskCreated(task.id, task.title)
    }

    if (queue) {
      queue.enqueue({
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
