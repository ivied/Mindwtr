/**
 * Simple in-memory classification queue with background worker.
 * For MVP — single process, no persistence. Will be replaced with Redis/BullMQ later.
 */

import type { Classifier } from './classifier'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassifierInput, ClassificationResult, TaskMetadata } from './types'

export interface ClassificationJob {
  taskId: string
  input: ClassifierInput
  /** Optional callback to notify user after classification */
  onComplete?: (result: ClassificationResult, taskId: string) => Promise<void>
}

export class ClassificationQueue {
  private queue: ClassificationJob[] = []
  private running = false
  private stopping = false

  constructor(
    private classifier: Classifier,
    private mindwtr: MindwtrClient
  ) {}

  enqueue(job: ClassificationJob): void {
    this.queue.push(job)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopping = false
    void this.loop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    while (this.running) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const job = this.queue.shift()
      if (!job) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      try {
        await this.process(job)
      } catch (err) {
        console.error(`[queue] Failed to process job for task ${job.taskId}:`, err)
      }
    }
    this.running = false
  }

  private async process(job: ClassificationJob): Promise<void> {
    const result = await this.classifier.classify(job.input)
    await this.applyClassification(job.taskId, job.input, result)
    if (job.onComplete) {
      await job.onComplete(result, job.taskId)
    }
  }

  private async applyClassification(
    taskId: string,
    input: ClassifierInput,
    result: ClassificationResult
  ): Promise<void> {
    const metadata: TaskMetadata = {
      ai_category: result.category,
      ai_confidence: result.confidence,
      ai_reasoning: result.reasoning,
      ai_is_noise: result.is_noise,
      ai_noise_reason: result.noise_reason,
      ai_is_project: result.is_project,
      ai_project_name: result.project_name,
      ai_is_delegation: result.is_delegation,
      ai_delegate_to: result.delegate_to,
      ai_classified_at: new Date().toISOString(),
      source_channel: input.sourceChannel,
    }

    const contexts = [...result.suggested_contexts]
    const tags = [...result.suggested_tags]

    if (result.is_noise) tags.push('noise')
    if (result.is_project) tags.push('project-candidate')
    if (result.category === 'two_minute') tags.push('2min')
    if (result.is_delegation) tags.push('delegated')

    // Status transition logic: only move out of inbox if confident
    const status = this.deriveStatus(result)

    await this.mindwtr.updateTask(taskId, {
      status,
      contexts,
      tags,
      metadata: metadata as unknown as Record<string, unknown>,
    })
  }

  private deriveStatus(result: ClassificationResult): string {
    const CONFIDENCE_THRESHOLD = 0.7
    if (result.confidence < CONFIDENCE_THRESHOLD) return 'inbox'
    if (result.is_noise) return 'inbox'

    switch (result.category) {
      case 'next':
      case 'two_minute':
        return 'next'
      case 'waiting':
        return 'waiting'
      case 'someday':
        return 'someday'
      case 'reference':
        return 'reference'
      default:
        return 'inbox'
    }
  }
}
