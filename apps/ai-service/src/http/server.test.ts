import { describe, it, expect, mock } from 'bun:test'
import { createHttpServer } from './server'
import type { CaptureFn } from '../capture/sink'

function setup(captureImpl: CaptureFn) {
  const server = createHttpServer({
    port: 0,
    authToken: 'test-token',
    capture: captureImpl,
    contextStore: null,
    proposals: null,
    persons: null,
  })
  return server.handler
}

describe('HTTP capture server', () => {
  it('responds 200 on /health without auth', async () => {
    const handler = setup(async () => {})
    const res = await handler(new Request('http://x/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('rejects /v1/capture without auth header', async () => {
    const handler = setup(async () => {})
    const res = await handler(
      new Request('http://x/v1/capture', { method: 'POST', body: '{}' })
    )
    expect(res.status).toBe(401)
  })

  it('rejects /v1/capture with wrong token', async () => {
    const handler = setup(async () => {})
    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      })
    )
    expect(res.status).toBe(401)
  })

  it('accepts capture with valid token and forwards to sink', async () => {
    const capture = mock(async () => {}) as unknown as CaptureFn
    const handler = setup(capture)

    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Snapshot OCR text',
          sourceChannel: 'screen_capture',
          sourceMeta: { app: 'Safari', windowTitle: 'BBC News' },
          extraTags: ['ocr'],
        }),
      })
    )

    expect(res.status).toBe(200)
    expect(capture).toHaveBeenCalledTimes(1)
    const calls = (capture as unknown as { mock: { calls: [Record<string, unknown>, Record<string, unknown>][] } }).mock.calls
    expect(calls[0][0]).toMatchObject({
      text: 'Snapshot OCR text',
      sourceChannel: 'screen_capture',
      type: 'text',
    })
    expect(calls[0][1]).toMatchObject({ extraTags: ['ocr'] })
  })

  it('rejects empty text', async () => {
    const handler = setup(async () => {})
    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('rejects oversized text', async () => {
    const handler = setup(async () => {})
    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(20_000) }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON body', async () => {
    const handler = setup(async () => {})
    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: '{not json',
      })
    )
    expect(res.status).toBe(400)
  })

  it('returns 500 when sink throws', async () => {
    const failing = mock(async () => {
      throw new Error('boom')
    }) as unknown as CaptureFn
    const handler = setup(failing)

    const res = await handler(
      new Request('http://x/v1/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
    )
    expect(res.status).toBe(500)
  })
})
