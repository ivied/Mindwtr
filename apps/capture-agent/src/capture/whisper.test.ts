import { describe, it, expect, mock } from 'bun:test'
import { WhisperClient } from './whisper'

describe('WhisperClient', () => {
  it('posts multipart form to audio/transcriptions with bearer token', async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ text: 'Hello world' }), { status: 200 })
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const client = new WhisperClient({ apiKey: 'sk-test', baseUrl: 'http://x/v1' })
    const text = await client.transcribe(Buffer.from([1, 2, 3, 4]))
    expect(text).toBe('Hello world')

    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://x/v1/audio/transcriptions')
    expect(calls[0][1].method).toBe('POST')
    const headers = calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(calls[0][1].body).toBeInstanceOf(FormData)
  })

  it('passes language hint when provided', async () => {
    let captured: FormData | null = null
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      captured = init.body as FormData
      return new Response(JSON.stringify({ text: 'привет' }), { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const client = new WhisperClient({ apiKey: 'sk-test', language: 'ru' })
    await client.transcribe(Buffer.from([1, 2, 3]))
    expect(captured).not.toBeNull()
    expect(captured!.get('language')).toBe('ru')
    expect(captured!.get('model')).toBe('whisper-1')
  })

  it('omits language when blank', async () => {
    let captured: FormData | null = null
    global.fetch = mock(async (_url: string, init: RequestInit) => {
      captured = init.body as FormData
      return new Response(JSON.stringify({ text: '' }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new WhisperClient({ apiKey: 'sk-test', language: '' })
    await client.transcribe(Buffer.from([1, 2, 3]))
    expect(captured!.get('language')).toBeNull()
  })

  it('throws on non-2xx response', async () => {
    global.fetch = mock(
      async () => new Response('rate limited', { status: 429 })
    ) as unknown as typeof fetch
    const client = new WhisperClient({ apiKey: 'sk-test' })
    await expect(client.transcribe(Buffer.from([1]))).rejects.toThrow(
      'Whisper transcribe failed: 429'
    )
  })

  it('returns empty string when api returns missing text field', async () => {
    global.fetch = mock(
      async () => new Response(JSON.stringify({}), { status: 200 })
    ) as unknown as typeof fetch
    const client = new WhisperClient({ apiKey: 'sk-test' })
    expect(await client.transcribe(Buffer.from([1]))).toBe('')
  })
})
