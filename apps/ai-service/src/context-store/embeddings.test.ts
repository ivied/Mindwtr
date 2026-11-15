import { describe, it, expect, mock } from 'bun:test'
import { EMBEDDING_DIMS, OpenAIEmbeddings, cosine, embeddingToBytes, shortenEmbedding } from './embeddings'

describe('OpenAIEmbeddings', () => {
  it('posts to /embeddings with bearer token', async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
        }),
        { status: 200 }
      )
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const e = new OpenAIEmbeddings({ apiKey: 'sk-test', baseUrl: 'http://x/v1' })
    const v = await e.embed('hello')
    // Shortened to the stored length and scaled back to unit length.
    expect(v.length).toBe(EMBEDDING_DIMS)
    expect(v[0]).toBeCloseTo(1 / Math.sqrt(EMBEDDING_DIMS), 5)

    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://x/v1/embeddings')
    const headers = calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(calls[0][1].body as string)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toBe('hello')
  })

  it('caches results — second call does not fetch', async () => {
    let calls = 0
    const fetchMock = mock(async () => {
      calls++
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.5), index: 0 }] }),
        { status: 200 }
      )
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const e = new OpenAIEmbeddings({ apiKey: 'sk-test' })
    await e.embed('same text')
    await e.embed('same text')
    expect(calls).toBe(1)
  })

  it('throws on non-2xx', async () => {
    global.fetch = mock(async () => new Response('bad', { status: 500 })) as unknown as typeof fetch
    const e = new OpenAIEmbeddings({ apiKey: 'sk-test' })
    await expect(e.embed('x')).rejects.toThrow('embeddings failed: 500')
  })

  it('throws on dimension mismatch', async () => {
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] }), {
          status: 200,
        })
    ) as unknown as typeof fetch
    const e = new OpenAIEmbeddings({ apiKey: 'sk-test' })
    await expect(e.embed('x')).rejects.toThrow('expected 1536-dim')
  })
})

describe('shortenEmbedding', () => {
  it('keeps the prefix and restores unit length', () => {
    const v = shortenEmbedding([3, 4, 12, 99], 2)
    expect(Array.from(v)).toEqual([Math.fround(0.6), Math.fround(0.8)])
  })

  it('leaves a zero vector alone', () => {
    expect(Array.from(shortenEmbedding([0, 0, 0], 2))).toEqual([0, 0])
  })
})

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    const a = Float32Array.from([1, 2, 3])
    expect(cosine(a, a)).toBeCloseTo(1, 6)
  })

  it('returns 0 for orthogonal', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6)
  })

  it('returns NaN on length mismatch', () => {
    expect(Number.isNaN(cosine(Float32Array.from([1]), Float32Array.from([1, 2])))).toBe(true)
  })
})

describe('embeddingToBytes', () => {
  it('produces 4 bytes per dimension', () => {
    const v = Float32Array.from([1.0, -2.5, 3.14])
    const buf = embeddingToBytes(v)
    expect(buf.length).toBe(12)
  })
})
