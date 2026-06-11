import { describe, it, expect, vi } from 'vitest'
import { CommitmentBatcher } from './batcher'
import type { CommitmentPipeline } from './pipeline'
import type { CaptureRecord } from '../context-store/types'

function fakeRecord(id: string): CaptureRecord {
  return { id } as unknown as CaptureRecord
}

function fakePipeline(): { pipeline: CommitmentPipeline; runs: string[] } {
  const runs: string[] = []
  const pipeline = {
    run: vi.fn(async (r: CaptureRecord) => {
      runs.push(r.id)
      return { kind: 'not-actionable', reasoning: 'test' }
    }),
  } as unknown as CommitmentPipeline
  return { pipeline, runs }
}

describe('CommitmentBatcher', () => {
  it('does not run the pipeline until drained', async () => {
    const { pipeline, runs } = fakePipeline()
    const b = new CommitmentBatcher(pipeline, { flushIntervalMs: 10_000, maxPerFlush: 30 })
    b.enqueue(fakeRecord('a'))
    b.enqueue(fakeRecord('b'))
    expect(runs).toHaveLength(0)
    expect(b.pending).toBe(2)
    await b.drain()
    expect(runs).toEqual(['a', 'b'])
    expect(b.pending).toBe(0)
  })

  it('caps each drain at maxPerFlush and leaves the rest queued', async () => {
    const { pipeline, runs } = fakePipeline()
    const b = new CommitmentBatcher(pipeline, { flushIntervalMs: 10_000, maxPerFlush: 2 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) b.enqueue(fakeRecord(id))
    await b.drain()
    expect(runs).toEqual(['a', 'b'])
    expect(b.pending).toBe(3)
    await b.drain()
    expect(runs).toEqual(['a', 'b', 'c', 'd'])
    expect(b.pending).toBe(1)
  })

  it('keeps going when one record throws', async () => {
    const runs: string[] = []
    const pipeline = {
      run: vi.fn(async (r: CaptureRecord) => {
        if (r.id === 'b') throw new Error('boom')
        runs.push(r.id)
        return { kind: 'not-actionable', reasoning: 'test' }
      }),
    } as unknown as CommitmentPipeline
    const b = new CommitmentBatcher(pipeline, { flushIntervalMs: 10_000, maxPerFlush: 30 })
    for (const id of ['a', 'b', 'c']) b.enqueue(fakeRecord(id))
    await b.drain()
    expect(runs).toEqual(['a', 'c'])
  })
})
