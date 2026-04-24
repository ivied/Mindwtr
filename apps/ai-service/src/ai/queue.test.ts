import { describe, it, expect, mock } from 'bun:test'
import { ClassificationQueue } from './queue'
import type { Classifier } from './classifier'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassificationResult, ClassifierInput } from './types'

function makeResult(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    category: 'next',
    is_noise: false,
    suggested_contexts: ['@work'],
    suggested_tags: [],
    is_project: false,
    is_delegation: false,
    confidence: 0.9,
    reasoning: 'test',
    ...overrides,
  }
}

function makeInput(): ClassifierInput {
  return {
    text: 'Test task',
    sourceChannel: 'telegram_dm',
    capturedAt: '2026-04-12T18:00:00Z',
  }
}

describe('ClassificationQueue', () => {
  it('processes enqueued job and updates task', async () => {
    const classifier = {
      classify: mock().mockResolvedValue(makeResult()),
    } as unknown as Classifier
    const mindwtr = {
      updateTask: mock().mockResolvedValue({ id: 'task-1' }),
    } as unknown as MindwtrClient

    const queue = new ClassificationQueue(classifier, mindwtr)
    queue.start()

    const onComplete = mock()
    queue.enqueue({
      taskId: 'task-1',
      input: makeInput(),
      onComplete,
    })

    // wait for processing
    await new Promise((r) => setTimeout(r, 700))
    await queue.stop()

    expect(classifier.classify).toHaveBeenCalledTimes(1)
    expect(mindwtr.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'next',
        contexts: ['@work'],
        tags: [],
        metadata: expect.objectContaining({
          ai_category: 'next',
          ai_confidence: 0.9,
        }),
      })
    )
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('keeps task in inbox when confidence is low', async () => {
    const classifier = {
      classify: mock().mockResolvedValue(makeResult({ confidence: 0.4 })),
    } as unknown as Classifier
    const mindwtr = {
      updateTask: mock().mockResolvedValue({ id: 'task-1' }),
    } as unknown as MindwtrClient

    const queue = new ClassificationQueue(classifier, mindwtr)
    queue.start()
    queue.enqueue({ taskId: 'task-1', input: makeInput() })

    await new Promise((r) => setTimeout(r, 700))
    await queue.stop()

    expect(mindwtr.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'inbox' })
    )
  })

  it('adds noise tag and keeps in inbox for noise items', async () => {
    const classifier = {
      classify: mock().mockResolvedValue(makeResult({ is_noise: true, confidence: 0.95 })),
    } as unknown as Classifier
    const mindwtr = {
      updateTask: mock().mockResolvedValue({ id: 'task-1' }),
    } as unknown as MindwtrClient

    const queue = new ClassificationQueue(classifier, mindwtr)
    queue.start()
    queue.enqueue({ taskId: 'task-1', input: makeInput() })

    await new Promise((r) => setTimeout(r, 700))
    await queue.stop()

    const calls = (mindwtr.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls
    const updates = calls[0][1] as { status: string; tags: string[] }
    expect(updates.status).toBe('inbox')
    expect(updates.tags).toContain('noise')
  })

  it('maps two_minute to next status with 2min tag', async () => {
    const classifier = {
      classify: mock().mockResolvedValue(makeResult({ category: 'two_minute' })),
    } as unknown as Classifier
    const mindwtr = {
      updateTask: mock().mockResolvedValue({ id: 'task-1' }),
    } as unknown as MindwtrClient

    const queue = new ClassificationQueue(classifier, mindwtr)
    queue.start()
    queue.enqueue({ taskId: 'task-1', input: makeInput() })

    await new Promise((r) => setTimeout(r, 700))
    await queue.stop()

    const calls = (mindwtr.updateTask as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls
    const updates = calls[0][1] as { status: string; tags: string[] }
    expect(updates.status).toBe('next')
    expect(updates.tags).toContain('2min')
  })

  it('continues processing after a job fails', async () => {
    const classifier = {
      classify: mock()
        .mockRejectedValueOnce(new Error('LLM error'))
        .mockResolvedValueOnce(makeResult()),
    } as unknown as Classifier
    const mindwtr = {
      updateTask: mock().mockResolvedValue({ id: 'task' }),
    } as unknown as MindwtrClient

    const queue = new ClassificationQueue(classifier, mindwtr)
    queue.start()
    queue.enqueue({ taskId: 'task-1', input: makeInput() })
    queue.enqueue({ taskId: 'task-2', input: makeInput() })

    await new Promise((r) => setTimeout(r, 1200))
    await queue.stop()

    expect(classifier.classify).toHaveBeenCalledTimes(2)
    expect(mindwtr.updateTask).toHaveBeenCalledTimes(1)
    expect(mindwtr.updateTask).toHaveBeenCalledWith('task-2', expect.anything())
  })
})
