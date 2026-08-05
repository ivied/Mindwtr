import { afterEach, describe, expect, it, mock } from 'bun:test'
import { LLMClient } from './client'

const OK_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
}

function mockFetch(handler: (model: string) => { status: number; body: unknown }) {
  const calls: string[] = []
  const fn = mock(async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { model: string }
    calls.push(parsed.model)
    const { status, body } = handler(parsed.model)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    }
  })
  // @ts-expect-error — minimal fetch stub for the test
  globalThis.fetch = fn
  return calls
}

const baseReq = {
  messages: [{ role: 'user' as const, content: 'hi' }],
}

afterEach(() => {
  mock.restore()
})

describe('LLMClient model tiers + fallback', () => {
  it('uses opus by default and sonnet when model is passed', async () => {
    const calls = mockFetch(() => ({ status: 200, body: OK_RESPONSE }))
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'cx/gpt-5.5',
      sonnet: 'cx/gpt-5.4-mini',
    })

    await client.chatCompletion(baseReq)
    await client.chatCompletion({ ...baseReq, model: 'cx/gpt-5.4-mini' })

    expect(calls).toEqual(['cx/gpt-5.5', 'cx/gpt-5.4-mini'])
  })

  it('falls back opus → sonnet when the primary model errors', async () => {
    const calls = mockFetch((model) =>
      model === 'cx/gpt-5.5'
        ? { status: 503, body: 'upstream down' }
        : { status: 200, body: OK_RESPONSE }
    )
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'cx/gpt-5.5',
      sonnet: 'cx/gpt-5.4-mini',
    })

    const res = await client.chatCompletion(baseReq)

    expect(calls).toEqual(['cx/gpt-5.5', 'cx/gpt-5.4-mini'])
    expect(res.choices[0]?.message?.content).toBe('ok')
  })

  it('falls back sonnet → opus when the lightweight model errors', async () => {
    const calls = mockFetch((model) =>
      model === 'cx/gpt-5.4-mini'
        ? { status: 500, body: 'boom' }
        : { status: 200, body: OK_RESPONSE }
    )
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'cx/gpt-5.5',
      sonnet: 'cx/gpt-5.4-mini',
    })

    await client.chatCompletion({ ...baseReq, model: 'cx/gpt-5.4-mini' })

    expect(calls).toEqual(['cx/gpt-5.4-mini', 'cx/gpt-5.5'])
  })

  it('crosses over to the fallback provider when both primary tiers fail', async () => {
    const calls = mockFetch((model) =>
      model.startsWith('ag/')
        ? { status: 429, body: 'quota exhausted' }
        : { status: 200, body: OK_RESPONSE }
    )
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'ag/gemini-3-flash-agent',
      sonnet: 'ag/gemini-3.5-flash-low',
      fallbackOpus: 'cx/gpt-5.5',
      fallbackSonnet: 'cx/gpt-5.4-mini',
    })

    const opusRes = await client.chatCompletion(baseReq)
    expect(calls).toEqual(['ag/gemini-3-flash-agent', 'ag/gemini-3.5-flash-low', 'cx/gpt-5.5'])
    expect(opusRes.choices[0]?.message?.content).toBe('ok')

    calls.length = 0
    await client.chatCompletion({ ...baseReq, model: 'ag/gemini-3.5-flash-low' })
    expect(calls).toEqual([
      'ag/gemini-3.5-flash-low',
      'ag/gemini-3-flash-agent',
      'cx/gpt-5.4-mini',
    ])
  })

  it('throws the last error when the whole chain fails', async () => {
    mockFetch((model) =>
      model.startsWith('ag/')
        ? { status: 429, body: 'quota exhausted' }
        : { status: 503, body: 'fallback down' }
    )
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'ag/gemini-3-flash-agent',
      sonnet: 'ag/gemini-3.5-flash-low',
      fallbackOpus: 'cx/gpt-5.5',
    })

    await expect(client.chatCompletion(baseReq)).rejects.toThrow('LLM request failed: 503')
  })

  it('throws when both tiers fail', async () => {
    mockFetch(() => ({ status: 503, body: 'down' }))
    const client = new LLMClient('http://proxy/v1', 'k', {
      opus: 'cx/gpt-5.5',
      sonnet: 'cx/gpt-5.4-mini',
    })

    await expect(client.chatCompletion(baseReq)).rejects.toThrow('LLM request failed: 503')
  })

  it('single-model construction keeps the legacy no-fallback behavior', async () => {
    const calls = mockFetch(() => ({ status: 503, body: 'down' }))
    const client = new LLMClient('http://proxy/v1', 'k', 'cc/legacy')

    await expect(client.chatCompletion(baseReq)).rejects.toThrow('LLM request failed: 503')
    expect(calls).toEqual(['cc/legacy'])
  })
})
