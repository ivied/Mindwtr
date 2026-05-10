import { describe, it, expect, mock } from 'bun:test'
import { MindwtrInboxTitles } from './inbox-titles'
import type { MindwtrClient } from '../api/mindwtr-client'

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
