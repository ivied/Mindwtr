/**
 * HTTP endpoint for desktop capture agent (and other external clients).
 * Receives normalized capture items and routes them through the standard sink.
 *
 * Also exposes the Proposals REST surface used by the Mindwtr UI:
 *   GET    /v1/proposals                  — list pending (filters: type, sourceAgent, targetTaskId, limit)
 *   GET    /v1/proposals/:id              — full detail incl. versions, messages, audit
 *   POST   /v1/proposals/:id/approve      — apply → mark approved (or stale on drift)
 *   POST   /v1/proposals/:id/reject       — mark rejected (optional body { reason })
 *   POST   /v1/proposals/:id/comments     — append comment + run Reviser
 *   POST   /v1/proposals/task-changes     — webhook from Mindwtr cloud (edit/delete events)
 */

import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'
import type { CaptureFn } from '../capture/sink'
import type { CapturedItem } from '../capture/normalizer'
import type { ContextStore } from '../context-store/store'
import type { ProposalStore } from '../proposal-store/store'
import type { ProposalApplier } from '../proposal-store/apply'
import type { CommentHandler } from '../proposal-store/comment-handler'
import type {
  TaskChangeProcessor,
  TaskChangeEvent,
  TaskFieldsSnapshot,
} from '../proposal-store/task-change-processor'
import type { ProposalRecord, ProposalType } from '../proposal-store/types'
import type { FieldDiff, ModifyPayload } from '../proposal-store/payloads'
import type { PersonsProvider } from '../wiki/persons-reader'

const MAX_TEXT_LENGTH = 10_000

interface CapturePayload {
  text: string
  sourceChannel?: CapturedItem['sourceChannel']
  type?: CapturedItem['type']
  timestamp?: string
  sourceMeta?: Record<string, unknown>
  extraTags?: string[]
}

export interface ProposalsHttpDeps {
  store: ProposalStore
  applier: ProposalApplier
  commentHandler: CommentHandler
  taskChangeProcessor: TaskChangeProcessor
}

export interface HttpServerConfig {
  port: number
  authToken: string
  capture: CaptureFn
  contextStore: ContextStore | null
  proposals: ProposalsHttpDeps | null
  /** Optional persons registry — when set, exposes GET /v1/persons for UI autocomplete. */
  persons: PersonsProvider | null
  /** Allowed origins for CORS. Default ['http://localhost:5173']. */
  corsOrigins?: string[]
}

export function createHttpServer(config: HttpServerConfig) {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  // CORS must precede bearerAuth: browser preflight OPTIONS arrives without
  // an Authorization header and would otherwise be rejected with 401.
  const corsOrigins = config.corsOrigins ?? ['http://localhost:5173']
  app.use(
    '/v1/*',
    cors({
      origin: corsOrigins,
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86400,
    })
  )

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

  if (config.proposals) {
    mountProposalRoutes(app, config.proposals)
  }

  if (config.persons) {
    mountPersonsRoutes(app, config.persons)
  }

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

function mountProposalRoutes(app: Hono, deps: ProposalsHttpDeps): void {
  app.get('/v1/proposals', (c) => {
    const type = c.req.query('type') as ProposalType | undefined
    const sourceAgent = c.req.query('sourceAgent') ?? undefined
    const targetTaskId = c.req.query('targetTaskId') ?? undefined
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const items = deps.store.listPending({ type, sourceAgent, targetTaskId, limit })
    return c.json({ items })
  })

  app.get('/v1/proposals/:id', (c) => {
    const id = c.req.param('id')
    const detail = deps.store.getDetail(id)
    if (!detail) return c.json({ error: 'not found' }, 404)
    return c.json(detail)
  })

  app.post('/v1/proposals/:id/approve', async (c) => {
    const id = c.req.param('id')
    const proposal = deps.store.get(id)
    if (!proposal) return c.json({ error: 'not found' }, 404)

    // Optional partial approval for type=modify: only apply the listed fields.
    // Body: { includeFields?: string[] }. When present and non-empty, we
    // synthesize a filtered version (author=user, summary='partial approval')
    // and the applier then reads that filtered payload from the store.
    let includeFields: string[] | undefined
    try {
      const body = (await c.req.json()) as { includeFields?: unknown }
      if (Array.isArray(body?.includeFields)) {
        includeFields = body.includeFields.filter(
          (f): f is string => typeof f === 'string' && f.length > 0
        )
      }
    } catch {
      // No body / not JSON — fine, treated as full approval.
    }

    if (includeFields && includeFields.length > 0) {
      const partialErr = applyPartialFilter(deps.store, proposal, includeFields)
      if (partialErr) return c.json({ error: partialErr }, 400)
    }

    const result = await deps.applier.apply(id)
    if (!result.ok) {
      // For stale we already transitioned; for other errors we leave pending.
      const status = result.reason === 'stale' ? 409 : result.reason === 'not_pending' ? 409 : 500
      return c.json(
        {
          ok: false,
          reason: result.reason,
          details: result.details,
          proposal: deps.store.get(id),
        },
        status
      )
    }

    // Apply succeeded → flip to approved with the applied task ids in audit meta.
    deps.store.transition(id, 'approved', 'user', { appliedTaskIds: result.appliedTaskIds })
    return c.json({
      ok: true,
      appliedTaskIds: result.appliedTaskIds,
      proposal: deps.store.get(id),
    })
  })

  app.post('/v1/proposals/:id/reject', async (c) => {
    const id = c.req.param('id')
    const proposal = deps.store.get(id)
    if (!proposal) return c.json({ error: 'not found' }, 404)
    if (proposal.status !== 'pending') {
      return c.json({ error: `proposal is ${proposal.status}, cannot reject` }, 409)
    }

    let reason: string | undefined
    try {
      const body = (await c.req.json()) as { reason?: string }
      reason = typeof body?.reason === 'string' ? body.reason.trim() : undefined
    } catch {
      // No body — that's fine, reject without reason.
    }
    if (reason) {
      deps.store.addMessage({ proposalId: id, role: 'user', text: reason })
    }
    deps.store.transition(id, 'rejected', 'user', reason ? { reason } : undefined)
    return c.json({ ok: true, proposal: deps.store.get(id) })
  })

  app.post('/v1/proposals/:id/comments', async (c) => {
    const id = c.req.param('id')
    const proposal = deps.store.get(id)
    if (!proposal) return c.json({ error: 'not found' }, 404)

    let body: { text?: string }
    try {
      body = (await c.req.json()) as { text?: string }
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const text = (body.text ?? '').trim()
    if (!text) return c.json({ error: 'text is required' }, 400)

    try {
      const result = await deps.commentHandler.handle({ proposalId: id, text })
      return c.json({
        ok: result.ok,
        outcome: result.outcome,
        error: result.error,
        proposal: deps.store.getDetail(id),
      })
    } catch (err) {
      const msg = (err as Error).message
      const status = /resolved|rejected|approved|expired|superseded|stale/.test(msg) ? 409 : 400
      return c.json({ error: msg }, status)
    }
  })

  app.post('/v1/proposals/task-changes', async (c) => {
    let body: TaskChangeWebhookBody
    try {
      body = (await c.req.json()) as TaskChangeWebhookBody
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const event = parseTaskChangeEvent(body)
    if (!event) return c.json({ error: 'invalid event shape' }, 400)
    const outcomes = deps.taskChangeProcessor.process(event)
    return c.json({ ok: true, outcomes })
  })
}

interface TaskChangeWebhookBody {
  kind?: string
  taskId?: string
  fields?: TaskFieldsSnapshot
}

/**
 * Apply a partial-approval filter to a pending modify proposal: filter the
 * payload.diff to only the listed fields and append a new version (author=user)
 * so the applier picks it up. Returns an error string when the proposal is not
 * a modify, the filter selects nothing, or all listed fields are unknown.
 */
function applyPartialFilter(
  store: ProposalStore,
  proposal: ProposalRecord,
  includeFields: string[]
): string | null {
  const payload = proposal.currentPayload as { kind?: string } | null
  if (!payload || payload.kind !== 'modify') {
    return 'partial approval (includeFields) only supported for type=modify'
  }
  const modify = payload as unknown as ModifyPayload
  const fieldSet = new Set(includeFields)
  const filtered = modify.diff.filter((entry: FieldDiff) => fieldSet.has(entry.field))
  if (filtered.length === 0) {
    return 'includeFields matched no diff entries'
  }
  if (filtered.length === modify.diff.length) {
    // Full set selected — no-op (avoid pointless extra version).
    return null
  }
  const filteredPayload: ModifyPayload = {
    ...modify,
    diff: filtered,
  }
  store.addVersion({
    proposalId: proposal.id,
    payload: filteredPayload,
    author: 'user',
    summary: `partial approval: ${filtered.map((d) => d.field).join(', ')}`,
  })
  return null
}

function parseTaskChangeEvent(body: TaskChangeWebhookBody): TaskChangeEvent | null {
  if (typeof body?.taskId !== 'string' || !body.taskId) return null
  if (body.kind === 'delete') {
    return { kind: 'delete', taskId: body.taskId }
  }
  if (body.kind === 'edit') {
    if (typeof body.fields !== 'object' || body.fields === null) return null
    return { kind: 'edit', taskId: body.taskId, fields: body.fields }
  }
  return null
}

function mountPersonsRoutes(app: Hono, provider: PersonsProvider): void {
  // GET /v1/persons?q=foo&limit=20 — used by the desktop AssignedToPicker.
  // Filters case-insensitively against canonical name + aliases. Returns
  // mention_count so callers can show "most-mentioned first" without sorting.
  app.get('/v1/persons', async (c) => {
    const qRaw = c.req.query('q') ?? ''
    const q = qRaw.trim().toLowerCase()
    const limitRaw = Number(c.req.query('limit') ?? 30)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 30

    // Fetch a comfortable superset; the wiki rollup keeps mention_count
    // monotone so newer mentions don't promote rare matches above already
    // canonical ones in the cached list.
    let persons
    try {
      persons = await provider.recentPersons(500)
    } catch (err) {
      return c.json({ error: `persons fetch failed: ${(err as Error).message}` }, 500)
    }

    const filtered = q
      ? persons.filter((p) => {
          if (p.name.toLowerCase().includes(q)) return true
          if (p.slug.toLowerCase().includes(q)) return true
          for (const a of p.aliases) if (a.toLowerCase().includes(q)) return true
          return false
        })
      : persons

    return c.json({ items: filtered.slice(0, limit) })
  })
}
