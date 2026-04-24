import { describe, it, expect, mock } from 'bun:test'
import { createCaptureSink } from './sink'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassificationQueue } from '../ai/queue'
import type { CapturedItem } from './normalizer'

function makeItem(overrides: Partial<CapturedItem> = {}): CapturedItem {
  return {
    text: 'Do something',
    sourceChannel: 'telegram_dm',
    type: 'text',
    timestamp: '2026-04-24T10:00:00Z',
    ...overrides,
  }
}

describe('createCaptureSink', () => {
  it('creates task in inbox via mindwtr client', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'Do something' }),
    } as unknown as MindwtrClient

    const capture = createCaptureSink(mindwtr, null)
    await capture(makeItem())

    const calls = (mindwtr.createTask as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls
    expect(calls[0][0]).toMatchObject({ title: 'Do something', status: 'inbox' })
  })

  it('enqueues classification when queue is provided', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const queue = {
      enqueue: mock(),
    } as unknown as ClassificationQueue

    const capture = createCaptureSink(mindwtr, queue)
    await capture(makeItem({ sourceChannel: 'slack_dm' }))

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    const calls = (queue.enqueue as unknown as { mock: { calls: [{ taskId: string; input: { sourceChannel: string } }][] } }).mock.calls
    expect(calls[0][0].taskId).toBe('t1')
    expect(calls[0][0].input.sourceChannel).toBe('slack_dm')
  })

  it('skips queue when null', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient

    const capture = createCaptureSink(mindwtr, null)
    await capture(makeItem())
    // no throw = success
    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)
  })

  it('invokes onTaskCreated callback', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'Hello' }),
    } as unknown as MindwtrClient
    const onTaskCreated = mock()

    const capture = createCaptureSink(mindwtr, null)
    await capture(makeItem(), { onTaskCreated })

    expect(onTaskCreated).toHaveBeenCalledTimes(1)
    const calls = (onTaskCreated as unknown as { mock: { calls: [string, string][] } }).mock.calls
    expect(calls[0][0]).toBe('t1')
    expect(calls[0][1]).toBe('Hello')
  })

  it('passes extraTags to createTask', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient

    const capture = createCaptureSink(mindwtr, null)
    await capture(makeItem(), { extraTags: ['forwarded'] })

    const calls = (mindwtr.createTask as unknown as { mock: { calls: [{ tags?: string[] }][] } }).mock.calls
    expect(calls[0][0].tags).toEqual(['forwarded'])
  })
})
