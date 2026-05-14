import { describe, it, expect, mock } from 'bun:test'
import { MindwtrInboxTitles } from './inbox-titles'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { ProposalStore } from '../proposal-store/store'
import type { ProposalRecord } from '../proposal-store/types'

function makeClient(titles: string[]): {
  client: MindwtrClient
  listTasks: ReturnType<typeof mock>
} {
  const listTasks = mock(async () =>
    titles.map((title, i) => ({
      id: `t${i}`,
      title,
      status: 'inbox',
      contexts: [],
      tags: [],
      createdAt: '',
      updatedAt: '',
    }))
  )
  const client = { listTasks } as unknown as MindwtrClient
  return { client, listTasks }
}

describe('MindwtrInboxTitles', () => {
  it('fetches and returns inbox titles', async () => {
    const { client, listTasks } = makeClient(['A', 'B', 'C'])
    const provider = new MindwtrInboxTitles({ client })
    const titles = await provider.recentTitles(10)
    expect(titles).toEqual(['A', 'B', 'C'])
    expect(listTasks).toHaveBeenCalledTimes(1)
  })

  it('caches within TTL window — single fetch for repeated calls', async () => {
    const { client, listTasks } = makeClient(['A', 'B'])
    const provider = new MindwtrInboxTitles({ client, ttlMs: 60_000 })
    await provider.recentTitles(50)
    await provider.recentTitles(50)
    await provider.recentTitles(50)
    expect(listTasks).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent calls into one network request', async () => {
    const { client, listTasks } = makeClient(['A'])
    const provider = new MindwtrInboxTitles({ client, ttlMs: 60_000 })
    await Promise.all([
      provider.recentTitles(50),
      provider.recentTitles(50),
      provider.recentTitles(50),
    ])
    expect(listTasks).toHaveBeenCalledTimes(1)
  })

  it('refetches after TTL expires', async () => {
    const { client, listTasks } = makeClient(['A'])
    const provider = new MindwtrInboxTitles({ client, ttlMs: 10 })
    await provider.recentTitles(50)
    await new Promise((r) => setTimeout(r, 30))
    await provider.recentTitles(50)
    expect(listTasks).toHaveBeenCalledTimes(2)
  })

  it('drops empty titles and trims whitespace', async () => {
    const { client } = makeClient([' Real Title ', '', '  ', 'Other'])
    const provider = new MindwtrInboxTitles({ client })
    const titles = await provider.recentTitles(50)
    expect(titles).toEqual(['Real Title', 'Other'])
  })

  it('honors limit param', async () => {
    const { client } = makeClient(['A', 'B', 'C', 'D'])
    const provider = new MindwtrInboxTitles({ client })
    const titles = await provider.recentTitles(2)
    expect(titles).toEqual(['A', 'B'])
  })

  it('invalidate() forces refetch on next call', async () => {
    const { client, listTasks } = makeClient(['A'])
    const provider = new MindwtrInboxTitles({ client, ttlMs: 60_000 })
    await provider.recentTitles(50)
    provider.invalidate()
    await provider.recentTitles(50)
    expect(listTasks).toHaveBeenCalledTimes(2)
  })
})

function makeStore(
  pending: Array<{ title: string }>,
  resolved: Array<{
    title: string
    status: 'approved' | 'rejected'
    resolvedAt: string
    kind?: 'rejected' | 'already-done' | 'not-applicable'
  }>
): ProposalStore {
  const pendingRecords: ProposalRecord[] = pending.map((p, i) => ({
    id: `pending-${i}`,
    type: 'create',
    targetTaskIds: [],
    sourceCaptureId: null,
    sourceAgent: 'commitment-detector',
    status: 'pending',
    currentPayload: { kind: 'create', task: { title: p.title } },
    currentVersion: 1,
    originSnapshot: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  }))
  const resolvedRecords = resolved.map((r, i) => ({
    id: `resolved-${i}`,
    type: 'create' as const,
    targetTaskIds: [],
    sourceCaptureId: null,
    sourceAgent: 'commitment-detector',
    status: r.status,
    currentPayload: { kind: 'create' as const, task: { title: r.title } },
    currentVersion: 1,
    originSnapshot: null,
    createdAt: new Date().toISOString(),
    resolvedAt: r.resolvedAt,
    resolvedBy: 'user',
    resolutionMeta: r.kind ? { kind: r.kind } : null,
  }))
  const store = {
    listPending: mock(() => pendingRecords),
    listRecentlyResolved: mock(() => resolvedRecords),
  } as unknown as ProposalStore
  return store
}

describe('MindwtrInboxTitles.recentItems', () => {
  it('labels inbox-only when no proposal store is wired', async () => {
    const { client } = makeClient(['Pay invoice', 'Reply to Alice'])
    const provider = new MindwtrInboxTitles({ client })
    const items = await provider.recentItems(10)
    expect(items.map((i) => ({ title: i.title, source: i.source }))).toEqual([
      { title: 'Pay invoice', source: 'inbox' },
      { title: 'Reply to Alice', source: 'inbox' },
    ])
  })

  it('merges pending proposals ahead of inbox and labels them', async () => {
    const { client } = makeClient(['Inbox A'])
    const proposalStore = makeStore([{ title: 'Pending B' }], [])
    const provider = new MindwtrInboxTitles({ client, proposalStore })
    const items = await provider.recentItems(10)
    expect(items).toEqual([
      { title: 'Pending B', source: 'pending' },
      { title: 'Inbox A', source: 'inbox' },
    ])
  })

  it('labels resolved items with resolution + ageMs and applies per-kind window', async () => {
    const { client } = makeClient([])
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const proposalStore = makeStore(
      [],
      [
        {
          title: 'Rejected recent',
          status: 'rejected',
          resolvedAt: new Date(now - 1 * day).toISOString(),
          kind: 'rejected',
        },
        {
          title: 'Already done recent',
          status: 'rejected',
          resolvedAt: new Date(now - 1 * day).toISOString(),
          kind: 'already-done',
        },
        {
          title: 'Already done stale',
          status: 'rejected',
          resolvedAt: new Date(now - 5 * day).toISOString(),
          kind: 'already-done',
        },
        {
          title: 'Approved recent',
          status: 'approved',
          resolvedAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
        },
      ]
    )
    const provider = new MindwtrInboxTitles({ client, proposalStore })
    const items = await provider.recentItems(10)
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]))
    expect(byTitle['Rejected recent']).toMatchObject({
      source: 'resolved',
      resolution: 'rejected',
    })
    expect(byTitle['Already done recent']).toMatchObject({
      source: 'resolved',
      resolution: 'already-done',
    })
    // Already-done window is 3d; 5d > window → dropped.
    expect(byTitle['Already done stale']).toBeUndefined()
    expect(byTitle['Approved recent']).toMatchObject({
      source: 'resolved',
      resolution: 'approved',
    })
    expect(byTitle['Rejected recent']!.ageMs).toBeGreaterThan(0)
  })

  it('de-dups across sources (inbox > pending > resolved order)', async () => {
    const { client } = makeClient(['Shared title'])
    const proposalStore = makeStore(
      [{ title: 'Shared title' }],
      [
        {
          title: 'Shared title',
          status: 'rejected',
          resolvedAt: new Date().toISOString(),
          kind: 'rejected',
        },
      ]
    )
    const provider = new MindwtrInboxTitles({ client, proposalStore })
    const items = await provider.recentItems(10)
    expect(items).toHaveLength(1)
    // pending is collected first → wins the dedupe over inbox / resolved.
    expect(items[0]).toMatchObject({ title: 'Shared title', source: 'pending' })
  })
})
