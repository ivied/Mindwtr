import { describe, it, expect, mock } from 'bun:test'
import { AiServiceClient } from './ai-service'
import type { DesktopCapture } from '../types'

function makeCapture(overrides: Partial<DesktopCapture> = {}): DesktopCapture {
  return {
    app: 'Safari',
    windowTitle: 'BBC',
    url: 'https://bbc.com',
    ocrText: 'Headline',
    capturedAt: '2026-04-24T10:00:00Z',
    ...overrides,
  }
}

describe('AiServiceClient.sendCapture', () => {
  it('POSTs with bearer token and payload', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const client = new AiServiceClient({ endpoint: 'http://x:3030', authToken: 'tok' })
    await client.sendCapture(makeCapture())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://x:3030/v1/capture')
    expect(calls[0][1].method).toBe('POST')
    const headers = calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    const body = JSON.parse(calls[0][1].body as string)
    expect(body.sourceChannel).toBe('screen_capture')
    expect(body.text).toContain('[Safari · BBC · https://bbc.com]')
    expect(body.text).toContain('Headline')
    expect(body.sourceMeta).toEqual({
      app: 'Safari',
      windowTitle: 'BBC',
      url: 'https://bbc.com',
    })
    expect(body.extraTags).toEqual(['screen-capture'])
  })

  it('strips trailing slash from endpoint', async () => {
    const fetchMock = mock(async () => new Response('', { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch
    const client = new AiServiceClient({ endpoint: 'http://x:3030/', authToken: 't' })
    await client.sendCapture(makeCapture())
    const calls = (fetchMock as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls[0][0]).toBe('http://x:3030/v1/capture')
  })

  it('throws on non-ok response', async () => {
    global.fetch = mock(async () => new Response('Bad request', { status: 400 })) as unknown as typeof fetch
    const client = new AiServiceClient({ endpoint: 'http://x', authToken: 't' })
    await expect(client.sendCapture(makeCapture())).rejects.toThrow('AI Service capture failed: 400')
  })
})
