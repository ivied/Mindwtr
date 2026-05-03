import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { MindwtrClient } from './mindwtr-client'

const mockFetch = mock()
global.fetch = mockFetch as unknown as typeof fetch

describe('MindwtrClient', () => {
  let client: MindwtrClient

  beforeEach(() => {
    mockFetch.mockReset()
    client = new MindwtrClient({
      baseUrl: 'http://localhost:8787',
      authToken: 'test-token',
    })
  })

  describe('createTask', () => {
    it('sends POST with correct body and auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '1', title: 'Test', status: 'inbox' }),
      })

      const task = await client.createTask({ title: 'Test', status: 'inbox' })

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ title: 'Test', props: { status: 'inbox' } }),
      })
      expect(task.title).toBe('Test')
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      })

      await expect(client.createTask({ title: '' })).rejects.toThrow('createTask failed: 400')
    })
  })

  describe('listTasks', () => {
    it('sends GET with query params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tasks: [{ id: '1', title: 'Task 1' }] }),
      })

      const tasks = await client.listTasks({ status: 'inbox', limit: 10 })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/v1/tasks?status=inbox&limit=10',
        expect.objectContaining({ headers: expect.any(Object) })
      )
      expect(tasks).toHaveLength(1)
    })

    it('works with no params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      })

      const tasks = await client.listTasks()
      expect(tasks).toHaveLength(0)
    })
  })

  describe('completeTask', () => {
    it('sends POST to complete endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '1', status: 'done' }),
      })

      const task = await client.completeTask('1')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/v1/tasks/1/complete',
        expect.objectContaining({ method: 'POST' })
      )
      expect(task.status).toBe('done')
    })
  })

  describe('healthCheck', () => {
    it('returns true when healthy', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      expect(await client.healthCheck()).toBe(true)
    })

    it('returns false on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
      expect(await client.healthCheck()).toBe(false)
    })
  })

  describe('search', () => {
    it('encodes query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tasks: [], projects: [] }),
      })

      await client.search('buy milk')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/v1/search?q=buy%20milk',
        expect.any(Object)
      )
    })
  })
})
