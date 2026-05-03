/**
 * HTTP endpoint for desktop capture agent (and other external clients).
 * Receives normalized capture items and routes them through the standard sink.
 */

import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import type { CaptureFn } from '../capture/sink'
import type { CapturedItem } from '../capture/normalizer'
import type { ContextStore } from '../context-store/store'

const MAX_TEXT_LENGTH = 10_000

interface CapturePayload {
  text: string
  sourceChannel?: CapturedItem['sourceChannel']
  type?: CapturedItem['type']
  timestamp?: string
  sourceMeta?: Record<string, unknown>
  extraTags?: string[]
}

export interface HttpServerConfig {
  port: number
  authToken: string
  capture: CaptureFn
  contextStore: ContextStore | null
}

export function createHttpServer(config: HttpServerConfig) {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/v1/*', bearerAuth({ token: config.authToken }))

  app.post('/v1/capture', async (c) => {
    let payload: CapturePayload
    try {
      payload = await c.req.json<CapturePayload>()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const text = payload.text?.trim()
    if (!text) {
      return c.json({ error: 'text is required' }, 400)
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return c.json({ error: `text exceeds ${MAX_TEXT_LENGTH} chars` }, 400)
    }

    const item: CapturedItem = {
      text,
      sourceChannel: payload.sourceChannel ?? 'screen_capture',
      type: payload.type ?? 'text',
      timestamp: payload.timestamp ?? new Date().toISOString(),
      sourceMeta: payload.sourceMeta,
    }

    try {
      await config.capture(item, { extraTags: payload.extraTags })
      return c.json({ ok: true })
    } catch (err) {
      console.error('[http] Capture failed:', err)
      return c.json({ error: 'Capture failed' }, 500)
    }
  })

  app.get('/v1/context/search', async (c) => {
    if (!config.contextStore) {
      return c.json({ error: 'Context Store not configured' }, 503)
    }
    const query = c.req.query('q')
    if (!query) return c.json({ error: 'q is required' }, 400)
    const topK = Number(c.req.query('topK') ?? 10)

    try {
      const hits = await config.contextStore.retrieve(query, { topK })
      return c.json({
        query,
        topK,
        size: config.contextStore.size(),
        hits: hits.map((h) => ({
          id: h.capture.id,
          text: h.capture.text,
          sourceChannel: h.capture.sourceChannel,
          sourceMeta: h.capture.sourceMeta,
          capturedAt: h.capture.capturedAt,
          score: h.score,
          via: h.via,
        })),
      })
    } catch (err) {
      console.error('[http] context search failed:', err)
      return c.json({ error: 'Search failed' }, 500)
    }
  })

  return {
    serve(): { stop: () => void } {
      const server = Bun.serve({
        port: config.port,
        fetch: app.fetch,
      })
      return {
        stop: () => server.stop(),
      }
    },
    handler: app.fetch,
  }
}
