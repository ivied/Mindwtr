/**
 * Embeddings provider abstraction + OpenAI implementation.
 *
 * - Default model: text-embedding-3-small (1536 dim) — cheap and good
 * - In-memory LRU cache by content hash so we never embed the same text twice
 *   in the same process. Persistent dedup is the responsibility of the caller
 *   (skip embed if a row with that content_hash already exists).
 */

export interface EmbeddingsProvider {
  readonly dimension: number
  embed(text: string): Promise<Float32Array>
}

export interface OpenAIEmbeddingsConfig {
  apiKey: string
  model?: string
  /** Defaults to https://api.openai.com/v1 */
  baseUrl?: string
  /** Max in-memory cache entries (LRU-style by Map insertion order) */
  cacheCapacity?: number
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
}

export class OpenAIEmbeddings implements EmbeddingsProvider {
  readonly dimension: number
  private model: string
  private baseUrl: string
  private headers: Record<string, string>
  private cache: Map<string, Float32Array>
  private cacheCapacity: number

  constructor(config: OpenAIEmbeddingsConfig) {
    this.model = config.model ?? 'text-embedding-3-small'
    this.dimension = MODEL_DIMENSIONS[this.model] ?? 1536
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    }
    this.cache = new Map()
    this.cacheCapacity = config.cacheCapacity ?? 1000
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text)
    if (cached) return cached

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ model: this.model, input: text }),
    })
    if (!res.ok) {
      throw new Error(`embeddings failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse
    const vec = json.data?.[0]?.embedding
    if (!vec || vec.length !== this.dimension) {
      throw new Error(
        `embeddings: expected ${this.dimension}-dim vector, got ${vec?.length ?? 'none'}`
      )
    }
    const arr = Float32Array.from(vec)
    this.putCache(text, arr)
    return arr
  }

  private putCache(key: string, value: Float32Array): void {
    if (this.cache.size >= this.cacheCapacity) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, value)
  }
}

/**
 * Cosine similarity for two embedding vectors. Returns NaN on length mismatch.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return NaN
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Encode Float32Array as raw little-endian bytes for sqlite-vec storage.
 */
export function embeddingToBytes(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}
