import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCaptureSink } from './sink'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { EnricherPipeline } from '../commitment/enricher-pipeline'
import { ContextStore } from '../context-store/store'
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

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-sink-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createCaptureSink', () => {
  it('push channel: writes to Context Store + creates Mindwtr inbox task', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'Do something' }),
    } as unknown as MindwtrClient
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, contextStore: store })
    await capture(makeItem({ sourceChannel: 'telegram_dm' }))

    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)
    expect(store.size()).toBe(1)
    store.close()
  })

  it('pull channel (screen_capture): writes to Context Store but NOT to Mindwtr', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, contextStore: store })
    await capture(makeItem({ sourceChannel: 'screen_capture' }))

    expect(mindwtr.createTask).not.toHaveBeenCalled()
    expect(store.size()).toBe(1)
    store.close()
  })

  it('L2 dedup: duplicate push capture skips Mindwtr task creation', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, contextStore: store })
    await capture(makeItem())
    await capture(makeItem())

    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)
    expect(store.size()).toBe(1)
    store.close()
  })

  it('contextOnly option skips Mindwtr even for push channels', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, contextStore: store })
    await capture(makeItem(), { contextOnly: true })

    expect(mindwtr.createTask).not.toHaveBeenCalled()
    expect(store.size()).toBe(1)
    store.close()
  })

  it('null contextStore: still creates Mindwtr task for push (legacy behavior)', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'Hi' }),
    } as unknown as MindwtrClient
    const capture = createCaptureSink({ mindwtr, contextStore: null })
    await capture(makeItem())
    expect(mindwtr.createTask).toHaveBeenCalledTimes(1)
  })

  it('null contextStore + pull channel: no-op (nothing stored, nothing inbox)', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const capture = createCaptureSink({ mindwtr, contextStore: null })
    await capture(makeItem({ sourceChannel: 'screen_capture' }))
    expect(mindwtr.createTask).not.toHaveBeenCalled()
  })

  it('runs EnricherPipeline only for push channels', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const enricherPipeline = {
      run: mock(async () => ({ kind: 'proposed', proposalId: 'p1', type: 'modify' })),
    } as unknown as EnricherPipeline
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, enricherPipeline, contextStore: store })
    await capture(makeItem({ sourceChannel: 'telegram_dm' }))
    await capture(makeItem({ text: 'OCR text', sourceChannel: 'screen_capture' }))

    // Allow fire-and-forget microtask to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(enricherPipeline.run).toHaveBeenCalledTimes(1)
    const calls = (enricherPipeline.run as unknown as { mock: { calls: [{ taskId: string; sourceChannel: string }][] } }).mock.calls
    expect(calls[0][0].taskId).toBe('t1')
    expect(calls[0][0].sourceChannel).toBe('telegram_dm')
    store.close()
  })

  it('passes extraTags to createTask and forwards them as taskTags to the enricher', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const enricherPipeline = {
      run: mock(async () => ({ kind: 'proposed', proposalId: 'p1', type: 'modify' })),
    } as unknown as EnricherPipeline
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, enricherPipeline, contextStore: store })
    await capture(makeItem(), { extraTags: ['forwarded'] })

    const taskCalls = (mindwtr.createTask as unknown as { mock: { calls: [{ tags?: string[] }][] } }).mock.calls
    expect(taskCalls[0][0].tags).toEqual(['forwarded'])

    await new Promise((r) => setTimeout(r, 0))
    const enrichCalls = (enricherPipeline.run as unknown as { mock: { calls: [{ taskTags: string[] }][] } }).mock.calls
    expect(enrichCalls[0][0].taskTags).toEqual(['forwarded'])
    store.close()
  })

  it('invokes onTaskCreated callback for push channels', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 'tid', title: 'Hello' }),
    } as unknown as MindwtrClient
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })
    const onTaskCreated = mock()

    const capture = createCaptureSink({ mindwtr, contextStore: store })
    await capture(makeItem(), { onTaskCreated })
    expect(onTaskCreated).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('does not crash when enricher pipeline rejects', async () => {
    const mindwtr = {
      createTask: mock().mockResolvedValue({ id: 't1', title: 'X' }),
    } as unknown as MindwtrClient
    const enricherPipeline = {
      run: mock(async () => {
        throw new Error('enricher boom')
      }),
    } as unknown as EnricherPipeline
    const store = ContextStore.open({ dbPath: join(dir, 'cs.db') })

    const capture = createCaptureSink({ mindwtr, enricherPipeline, contextStore: store })
    await expect(capture(makeItem())).resolves.toBeUndefined()

    // Fire-and-forget rejection — let microtask resolve so logger runs.
    await new Promise((r) => setTimeout(r, 0))
    store.close()
  })
})
