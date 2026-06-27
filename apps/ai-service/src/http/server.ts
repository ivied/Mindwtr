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

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { getThreadRegistry } from '../threads/registry'
import type { RecordingSessionStore } from '../recording/store'
import type { HealthReport } from '../status/health'
import type { FocusContextAssembler, MemoryStore, HybridRetriever, IngestService } from '../memory'
import type { ProceduralStore, AppliesTo } from '../memory/procedural'

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
  /**
   * Optional hook fired when the cloud webhook reports a task created
   * outside ai-service (manual quick-add, sync from another device, etc.).
   * Used by index.ts to spin up the Enricher pipeline so the user sees an
   * AI suggestion on the manually-added card. Fire-and-forget; the webhook
   * handler returns immediately.
   */
  onTaskCreated?: (taskId: string, fields: TaskFieldsSnapshot) => void
  /**
   * Optional: notify Telegram when an @ai-agent task transitions into
   * ai-stage:review (OpenClaw finished) or ai-stage:error (it failed).
   * Called from the task-changes webhook on every edit; dedup is the
   * notifier's problem.
   */
  onTaskEdited?: (taskId: string, fields: TaskFieldsSnapshot) => void | Promise<void>
  /**
   * Optional (FR89): on approve/reject, push a reliability signal to the
   * procedural memory for whatever playbook chunks the Proposer cited.
   * positive = AI was useful (approved / already-done), negative = AI was
   * wrong (plain reject). not-applicable is skipped (neither chunk's
   * fault). Phase 1b.1 only accumulates the score; retrieval is unchanged.
   */
  proceduralFeedback?: {
    applyResolutionFeedback(
      proposalId: string,
      signal: 'positive' | 'negative'
    ): number
  }
}

export interface MemoryHttpDeps {
  store: MemoryStore
  retriever: HybridRetriever
  focusContext: FocusContextAssembler
  /** Live ingest service — exposed via POST /v1/memory/ingest for ad-hoc testing. */
  ingest: IngestService | null
}

export interface ProceduralHttpDeps {
  store: ProceduralStore
  /** Optional — enables hand-written-rule CRUD under shared-memory/user/. */
  userCrud?: {
    /** Absolute path to shared-memory root (the dir that contains user/). */
    sharedMemoryDir: string
    /** Force a sync re-scan after a file mutation. */
    scanNow: () => Promise<void>
  }
}

export interface HttpServerConfig {
  port: number
  authToken: string
  capture: CaptureFn
  contextStore: ContextStore | null
  proposals: ProposalsHttpDeps | null
  /** Optional persons registry — when set, exposes GET /v1/persons for UI autocomplete. */
  persons: PersonsProvider | null
  /** Optional memory module deps — when set, exposes GET /v1/memory/* routes. */
  memory?: MemoryHttpDeps | null
  /** Optional procedural memory — when set, exposes GET/POST /v1/procedural/* (FR88 review API). */
  procedural?: ProceduralHttpDeps | null
  /** Optional recording-session store — exposes /v1/recordings/* (Phase 2). */
  recordings?: {
    store: RecordingSessionStore
    /** Optional: fired (fire-and-forget) after stop so distillation begins immediately. */
    onStopped?: (sessionId: string) => void
  } | null
  /** Allowed origins for CORS. Default ['http://localhost:5173']. */
  corsOrigins?: string[]
  /** Optional real component checks; when unset /health returns static ok. */
  healthMonitor?: { check(): Promise<HealthReport> } | null
  /**
   * Optional Slack session-credential receiver — when set, exposes
   * POST /v1/slack/session for the browser extension to push xoxc+d tokens.
   */
  slackSession?: {
    upsert(token: string, cookie: string): Promise<{ teamId: string; teamName: string }>
  } | null
  /** Optional control-plane config (Phase 3 capture pause). When set, exposes
   *  GET/POST /v1/agent-config and feeds capturePaused into the dashboard. */
  agentConfig?: {
    get(): { capturePaused: boolean; updatedAt: string | null }
    setCapturePaused(paused: boolean): { capturePaused: boolean; updatedAt: string | null }
  } | null
}

export function createHttpServer(config: HttpServerConfig) {
  const app = new Hono()

  app.get('/health', async (c) => {
    if (!config.healthMonitor) return c.json({ ok: true })
    const report = await config.healthMonitor.check()
    return c.json(report, report.ok ? 200 : 503)
  })

  // CORS must precede bearerAuth: browser preflight OPTIONS arrives without
  // an Authorization header and would otherwise be rejected with 401.
  const corsOrigins = config.corsOrigins ?? ['http://localhost:5173']
  app.use(
    '/v1/*',
    cors({
      // Allow the configured web origins, plus any chrome-extension:// origin
      // (the Slack token-pusher extension's id isn't known ahead of time; the
      // bearer token is the real guard).
      origin: (origin) => {
        if (!origin) return corsOrigins[0] ?? null
        if (corsOrigins.includes(origin)) return origin
        if (origin.startsWith('chrome-extension://')) return origin
        return null
      },
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    })
  )

  app.use('/v1/*', bearerAuth({ token: config.authToken }))

  // Control Center dashboard aggregator (Phase 2). One read-only call that
  // bundles health + memory + procedural + recording + per-source arrivals so
  // the web view doesn't fan out. Registered AFTER cors + bearerAuth so it
  // inherits both. Every section is null-safe; a missing dep yields null.
  app.get('/v1/status/dashboard', async (c) => {
    const health = config.healthMonitor ? await config.healthMonitor.check() : null

    const mem = config.memory?.store ?? null
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)
    const memory = mem
      ? {
          events: mem.countEvents(),
          facts: mem.countFacts(),
          activeFacts: mem.allActiveFacts(1000).length,
          eventsToday: mem.countEventsSince(startOfDay.toISOString()),
          latestEventAt: mem.latestEventIngestedAt(),
        }
      : null

    let procedural: { total: number; visible: number } | null = null
    if (config.procedural?.store) {
      const all = config.procedural.store.listChunks({ limit: 500 })
      let visible = 0
      for (const r of all.items) if (r.appliesTo === 'universal' || r.appliesTo === 'mindwtr-only') visible++
      procedural = { total: all.total, visible }
    }

    const active = config.recordings?.store.getActive() ?? null
    const recording = { active: Boolean(active), taskTitle: active?.taskTitle ?? null }

    // per-source arrivals in the last 10 minutes → drives the honest flow.
    let sources: Record<string, { recent: number; lastAt: string | null }> | null = null
    if (mem) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const rows = mem.recentCountsBySource(since)
      const bucket = (s: string): 'screen' | 'audio' | 'chat' | 'notes' | null => {
        if (s === 'screen') return 'screen'
        if (s === 'audio') return 'audio'
        if (s.startsWith('slack') || s.startsWith('telegram')) return 'chat'
        if (s.startsWith('notion')) return 'notes'
        return null
      }
      const agg: Record<string, { recent: number; lastAt: string | null }> = {
        screen: { recent: 0, lastAt: null }, audio: { recent: 0, lastAt: null },
        chat: { recent: 0, lastAt: null }, notes: { recent: 0, lastAt: null },
      }
      for (const r of rows) {
        const b = bucket(r.source); if (!b) continue
        agg[b].recent += r.count
        if (!agg[b].lastAt || r.lastAt > agg[b].lastAt!) agg[b].lastAt = r.lastAt
      }
      sources = agg
    }

    return c.json({
      ok: health?.ok ?? true,
      components: health?.components ?? null,
      capturePaused: config.agentConfig?.get().capturePaused ?? false,
      memory,
      procedural,
      recording,
      sources,
      checkedAt: new Date().toISOString(),
    })
  })

  // Source pulse — how many events PER bucket arrived since the client's
  // cursor (?since=ISO). The Control Center polls this fast (~3s) and emits
  // one particle per real arrival, so the flow is literal, not rate-scaled.
  // First call (no since) returns zeros + a fresh cursor to start from.
  app.get('/v1/status/source-pulse', (c) => {
    const now = new Date().toISOString()
    const since = c.req.query('since')
    const buckets: Record<'screen' | 'audio' | 'chat' | 'notes', number> = {
      screen: 0, audio: 0, chat: 0, notes: 0,
    }
    const mem = config.memory?.store ?? null
    if (mem && since) {
      for (const r of mem.recentCountsBySource(since)) {
        const s = r.source
        if (s === 'screen') buckets.screen += r.count
        else if (s === 'audio') buckets.audio += r.count
        else if (s.startsWith('slack') || s.startsWith('telegram')) buckets.chat += r.count
        else if (s.startsWith('notion')) buckets.notes += r.count
      }
    }
    return c.json({ now, sources: buckets })
  })

  // Control-plane: capture pause switch (Phase 3). capture-agent polls GET;
  // the Control Center toggles via POST { capturePaused }.
  if (config.agentConfig) {
    const ac = config.agentConfig
    app.get('/v1/agent-config', (c) => c.json(ac.get()))
    app.post('/v1/agent-config', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { capturePaused?: unknown }
      if (typeof body.capturePaused !== 'boolean') {
        return c.json({ error: 'capturePaused (boolean) required' }, 400)
      }
      return c.json(ac.setCapturePaused(body.capturePaused))
    })
  }

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

  if (config.memory) {
    mountMemoryRoutes(app, config.memory)
  }

  if (config.procedural) {
    mountProceduralRoutes(app, config.procedural)
  }

  if (config.recordings) {
    mountRecordingRoutes(app, config.recordings)
  }

  if (config.slackSession) {
    const slackSession = config.slackSession
    // POST /v1/slack/session { token: 'xoxc-...', cookie: 'xoxd-...' }
    // Browser extension pushes a freshly-lifted session credential. We resolve
    // identity (auth.test) and register/refresh the workspace in the poller.
    app.post('/v1/slack/session', async (c) => {
      let body: { token?: unknown; cookie?: unknown }
      try {
        body = (await c.req.json()) as typeof body
      } catch {
        return c.json({ error: 'invalid JSON' }, 400)
      }
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
      if (!token.startsWith('xoxc-')) return c.json({ error: 'token must be xoxc-' }, 400)
      if (!cookie.startsWith('xoxd-')) return c.json({ error: 'cookie must be xoxd-' }, 400)
      try {
        const { teamId, teamName } = await slackSession.upsert(token, cookie)
        return c.json({ ok: true, teamId, teamName })
      } catch (err) {
        const e = err as { data?: { error?: string } }
        const reason = e?.data?.error ?? (err as Error).message
        // invalid_auth → the credential is dead; tell the extension so it can
        // surface "re-login" instead of silently retrying.
        const status = reason === 'invalid_auth' ? 401 : 502
        return c.json({ error: `slack auth failed: ${reason}` }, status)
      }
    })
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
    // FR89: approval = the playbook chunks that informed this proposal
    // were useful. Best-effort, never blocks the response.
    try {
      deps.proceduralFeedback?.applyResolutionFeedback(id, 'positive')
    } catch (err) {
      console.warn('[http] procedural feedback (approve) failed:', (err as Error).message)
    }
    return c.json({
      ok: true,
      appliedTaskIds: result.appliedTaskIds,
      ...(result.projectId ? { projectId: result.projectId } : {}),
      ...(result.projectTitle ? { projectTitle: result.projectTitle } : {}),
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

    // Body shape:
    //   { reason?: string, kind?: 'rejected' | 'already-done' | 'not-applicable' }
    // kind distinguishes "AI was wrong" (default `rejected`) from "AI was right
    // but I already did it" (`already-done`) and "AI was right but the task
    // doesn't apply anymore" (`not-applicable`). All three flip status to
    // 'rejected' but the audit meta carries the nuance for telemetry —
    // already-done counts as a TRUE positive in the false-positive vs
    // delayed-action breakdown.
    let reason: string | undefined
    let kind: 'rejected' | 'already-done' | 'not-applicable' = 'rejected'
    try {
      const body = (await c.req.json()) as {
        reason?: string
        kind?: string
      }
      reason = typeof body?.reason === 'string' ? body.reason.trim() : undefined
      if (body?.kind === 'already-done' || body?.kind === 'not-applicable') {
        kind = body.kind
      }
    } catch {
      // No body — that's fine, reject without reason.
    }
    if (reason) {
      deps.store.addMessage({ proposalId: id, role: 'user', text: reason })
    }
    const meta: Record<string, unknown> = { kind }
    if (reason) meta.reason = reason
    deps.store.transition(id, 'rejected', 'user', meta)
    // FR89: 'rejected' = AI was wrong → negative for cited chunks.
    // 'already-done' = AI was right (true positive) → positive.
    // 'not-applicable' = situation changed, neither chunk's fault → skip.
    try {
      if (kind === 'rejected') {
        deps.proceduralFeedback?.applyResolutionFeedback(id, 'negative')
      } else if (kind === 'already-done') {
        deps.proceduralFeedback?.applyResolutionFeedback(id, 'positive')
      }
    } catch (err) {
      console.warn('[http] procedural feedback (reject) failed:', (err as Error).message)
    }
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
    // create events: dispatch to the Enricher hook. TaskChangeProcessor itself
    // returns [] for create — it only handles supersession/staling on edit/delete.
    if (event.kind === 'create' && deps.onTaskCreated) {
      try {
        deps.onTaskCreated(event.taskId, event.fields)
      } catch (err) {
        console.error('[task-changes] onTaskCreated hook threw:', (err as Error).message)
      }
    }
    // edit events: notify on @ai-agent stage transitions (review / error).
    if (event.kind === 'edit' && deps.onTaskEdited) {
      Promise.resolve(deps.onTaskEdited(event.taskId, event.fields)).catch((err) =>
        console.error('[task-changes] onTaskEdited hook threw:', (err as Error).message)
      )
    }
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
  if (body.kind === 'create') {
    if (typeof body.fields !== 'object' || body.fields === null) return null
    return { kind: 'create', taskId: body.taskId, fields: body.fields }
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

  // Live Claude Code threads on the Mac — the routing-target picker's source.
  // Single source of truth (scanned from ~/.claude/projects); desktop fetches
  // this instead of carrying a static copy.
  app.get('/v1/threads', (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase()
    const limitRaw = Number(c.req.query('limit') ?? 120)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 120
    let threads
    try {
      threads = getThreadRegistry()
    } catch (err) {
      return c.json({ error: `thread scan failed: ${(err as Error).message}` }, 500)
    }
    const filtered = q
      ? threads.filter(
          (t) =>
            t.alias.toLowerCase().includes(q) ||
            t.repoLabel.toLowerCase().includes(q) ||
            t.summary.toLowerCase().includes(q)
        )
      : threads
    return c.json({ items: filtered.slice(0, limit) })
  })
}

function mountMemoryRoutes(app: Hono, deps: MemoryHttpDeps): void {
  app.get('/v1/memory/stats', (c) => {
    return c.json({
      events: deps.store.countEvents(),
      facts: deps.store.countFacts(),
      activeFacts: deps.store.allActiveFacts(1000).length,
      recentDailySummaries: deps.store.recentDailySummaries(30).length,
      vecAvailable: deps.store.vecAvailable,
    })
  })

  app.get('/v1/memory/search', async (c) => {
    const query = c.req.query('q')
    if (!query) return c.json({ error: 'q is required' }, 400)
    const limit = Number(c.req.query('limit') ?? 10)
    const withinDays = c.req.query('days') ? Number(c.req.query('days')) : undefined
    const entitySlugs = c.req.query('entities')?.split(',').map((s) => s.trim()).filter(Boolean)

    try {
      const hits = await deps.retriever.retrieve({ query, limit, withinDays, entitySlugs })
      return c.json({
        query,
        hits: hits.map((h) => ({
          id: h.id,
          ts: h.ts,
          source: h.source,
          app: h.app,
          title: h.title,
          excerpt: h.body.slice(0, 240),
          score: h.score,
          ranks: h.ranks,
        })),
      })
    } catch (err) {
      console.error('[http] memory search failed:', err)
      return c.json({ error: 'search failed' }, 500)
    }
  })

  app.get('/v1/memory/focus-context', async (c) => {
    const query = c.req.query('q')
    if (!query) return c.json({ error: 'q is required' }, 400)
    const eventLimit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const withinDays = c.req.query('days') ? Number(c.req.query('days')) : undefined
    const entitySlugs = c.req.query('entities')?.split(',').map((s) => s.trim()).filter(Boolean)
    const withBriefing = c.req.query('briefing') === '1'

    try {
      const ctx = await deps.focusContext.assemble({
        query,
        eventLimit,
        withinDays,
        entitySlugs,
        withBriefing,
      })
      return c.json({
        query,
        activeFacts: ctx.activeFacts,
        recentEvents: ctx.recentEvents.map((e) => ({
          id: e.id,
          ts: e.ts,
          source: e.source,
          app: e.app,
          title: e.title,
          excerpt: e.body.slice(0, 320),
          score: e.score,
          ranks: e.ranks,
        })),
        relatedEntities: ctx.relatedEntities,
        briefing: ctx.briefing,
      })
    } catch (err) {
      console.error('[http] focus-context failed:', err)
      return c.json({ error: 'focus-context failed' }, 500)
    }
  })

  app.post('/v1/memory/ingest', async (c) => {
    if (!deps.ingest) return c.json({ error: 'ingest not configured' }, 503)
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const required = ['id', 'ts', 'source', 'app', 'title', 'body']
    for (const k of required) {
      if (typeof body[k] !== 'string') return c.json({ error: `missing ${k}` }, 400)
    }
    try {
      const res = await deps.ingest.live({
        id: body.id as string,
        ts: body.ts as string,
        source: body.source as 'screen' | 'audio',
        app: body.app as string,
        title: body.title as string,
        url: typeof body.url === 'string' ? body.url : undefined,
        body: body.body as string,
        meta: (body.meta as Record<string, unknown> | undefined) ?? undefined,
        capturePath: typeof body.capturePath === 'string' ? body.capturePath : undefined,
      })
      return c.json({
        inserted: res.inserted,
        duplicate: res.duplicate,
        entityCount: res.extraction?.entities.length ?? 0,
        factCount: res.extraction?.facts.length ?? 0,
        factIdsInserted: res.factIdsInserted,
      })
    } catch (err) {
      console.error('[http] memory ingest failed:', err)
      return c.json({ error: 'ingest failed' }, 500)
    }
  })
}

const VALID_APPLIES: AppliesTo[] = [
  'universal',
  'openclaw-only',
  'mindwtr-only',
  'archived',
  'needs-review',
]
// What a human reviewer is allowed to set. 'needs-review' is excluded —
// a reviewer either decides or leaves the row untouched; sending it back
// to needs-review would just re-trigger automated classification.
const USER_SETTABLE_APPLIES: AppliesTo[] = [
  'universal',
  'openclaw-only',
  'mindwtr-only',
  'archived',
]

function mountProceduralRoutes(app: Hono, deps: ProceduralHttpDeps): void {
  // Distribution snapshot — drives the review dashboard + telemetry.
  app.get('/v1/procedural/stats', (c) => {
    const all = deps.store.listChunks({ limit: 500 })
    const byApplies: Record<string, number> = {}
    const byClassifier: Record<string, number> = {}
    for (const r of all.items) {
      byApplies[r.appliesTo] = (byApplies[r.appliesTo] ?? 0) + 1
      const cb = r.classifiedBy ?? 'null'
      byClassifier[cb] = (byClassifier[cb] ?? 0) + 1
    }
    return c.json({
      total: all.total,
      byApplies,
      byClassifier,
      reliability: deps.store.reliabilitySummary(),
    })
  })

  // Paged review listing. ?applies=universal,openclaw-only &source= &limit= &offset=
  app.get('/v1/procedural/chunks', (c) => {
    const appliesParam = c.req.query('applies')
    const applies = appliesParam
      ? (appliesParam
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is AppliesTo =>
            (VALID_APPLIES as string[]).includes(s)
          ))
      : undefined
    const source = c.req.query('source') || undefined
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined

    const { total, items } = deps.store.listChunks({ applies, source, limit, offset })
    return c.json({
      total,
      items: items.map((r) => ({
        id: r.id,
        source: r.source,
        path: r.path,
        sectionIndex: r.sectionIndex,
        sectionTitle: r.sectionTitle,
        excerpt: r.text.replace(/\s+/g, ' ').trim().slice(0, 280),
        // Full body — only used by the edit dialog for source='user' rows.
        // Trade-off: ~30KB extra payload across the whole list, negligible.
        text: r.text,
        appliesTo: r.appliesTo,
        classifiedBy: r.classifiedBy,
        classifiedAt: r.classifiedAt,
        reliabilityScore: r.reliabilityScore,
      })),
    })
  })

  // Human override. Body: { appliesTo }. Sets classified_by='user' which
  // is terminal — heuristic back-pass + LLM batch both skip user verdicts.
  app.post('/v1/procedural/chunks/:id/classify', async (c) => {
    const id = c.req.param('id')
    let body: { appliesTo?: unknown }
    try {
      body = (await c.req.json()) as { appliesTo?: unknown }
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const appliesTo = body.appliesTo
    if (
      typeof appliesTo !== 'string' ||
      !(USER_SETTABLE_APPLIES as string[]).includes(appliesTo)
    ) {
      return c.json(
        { error: `appliesTo must be one of ${USER_SETTABLE_APPLIES.join(', ')}` },
        400
      )
    }
    const existing = deps.store.getById(id)
    if (!existing) return c.json({ error: 'chunk not found' }, 404)
    deps.store.classify(id, appliesTo as AppliesTo, 'user')
    const updated = deps.store.getById(id)
    return c.json({
      ok: true,
      chunk: updated
        ? {
            id: updated.id,
            sectionTitle: updated.sectionTitle,
            appliesTo: updated.appliesTo,
            classifiedBy: updated.classifiedBy,
            classifiedAt: updated.classifiedAt,
          }
        : null,
    })
  })

  // ---------------- Hand-written-rule CRUD (source='user') ----------------
  // File-as-source-of-truth: every mutation writes shared-memory/user/<slug>.md
  // then forces a re-scan so the returned row reflects what the reader sees.
  // Only chunks with source='user' are editable — openclaw/mined files are
  // owned by sync scripts / the miner agent and would be clobbered.

  if (deps.userCrud) {
    const { sharedMemoryDir, scanNow } = deps.userCrud
    const userDir = join(sharedMemoryDir, 'user')

    const slugify = (title: string): string =>
      title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled'

    const renderFile = (title: string, body: string): string => {
      const cleanBody = body.trim()
      const titleLine = title.trim()
      return `## ${titleLine}\n\n${cleanBody}\n`
    }

    const findFreeSlug = async (base: string): Promise<string> => {
      await mkdir(userDir, { recursive: true })
      const existing = new Set(await readdir(userDir).catch(() => [] as string[]))
      if (!existing.has(`${base}.md`)) return base
      for (let i = 2; i < 1000; i++) {
        const cand = `${base}-${i}`
        if (!existing.has(`${cand}.md`)) return cand
      }
      throw new Error('failed to allocate slug')
    }

    // POST /v1/procedural/chunks  — create a new hand-written rule
    // Body: { title: string, body: string, appliesTo?: 'universal'|'openclaw-only'|'mindwtr-only' }
    app.post('/v1/procedural/chunks', async (c) => {
      let body: { title?: unknown; body?: unknown; appliesTo?: unknown }
      try {
        body = (await c.req.json()) as typeof body
      } catch {
        return c.json({ error: 'invalid JSON' }, 400)
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const ruleBody = typeof body.body === 'string' ? body.body.trim() : ''
      if (!title) return c.json({ error: 'title is required' }, 400)
      if (!ruleBody) return c.json({ error: 'body is required' }, 400)
      const appliesTo =
        typeof body.appliesTo === 'string' &&
        (USER_SETTABLE_APPLIES as string[]).includes(body.appliesTo)
          ? (body.appliesTo as AppliesTo)
          : ('universal' as AppliesTo)

      const baseSlug = slugify(title)
      const slug = await findFreeSlug(baseSlug)
      const relPath = `${slug}.md`
      const absPath = join(userDir, relPath)
      await writeFile(absPath, renderFile(title, ruleBody), 'utf8')
      await scanNow()

      // Reader re-scanned — find the new chunk by (source, path).
      const created = deps.store
        .listChunks({ source: 'user', limit: 500 })
        .items.find((r) => r.path === relPath)
      if (!created) return c.json({ error: 'chunk written but not indexed' }, 500)

      // Stamp the user's intent so the heuristic/LLM passes don't second-guess.
      deps.store.classify(created.id, appliesTo, 'user')
      const final = deps.store.getById(created.id)
      return c.json(
        {
          ok: true,
          chunk: final
            ? {
                id: final.id,
                source: final.source,
                path: final.path,
                sectionTitle: final.sectionTitle,
                excerpt: final.text.replace(/\s+/g, ' ').trim().slice(0, 280),
                appliesTo: final.appliesTo,
                classifiedBy: final.classifiedBy,
              }
            : null,
        },
        201
      )
    })

    // PATCH /v1/procedural/chunks/:id  — edit title and/or body
    // Body: { title?: string, body?: string, appliesTo?: AppliesTo }
    app.patch('/v1/procedural/chunks/:id', async (c) => {
      const id = c.req.param('id')
      const existing = deps.store.getById(id)
      if (!existing) return c.json({ error: 'chunk not found' }, 404)
      if (existing.source !== 'user') {
        return c.json({ error: 'only user-source chunks are editable' }, 403)
      }
      let body: { title?: unknown; body?: unknown; appliesTo?: unknown }
      try {
        body = (await c.req.json()) as typeof body
      } catch {
        return c.json({ error: 'invalid JSON' }, 400)
      }
      const newTitle =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : existing.sectionTitle ?? 'Untitled'
      const newBody =
        typeof body.body === 'string' && body.body.trim()
          ? body.body.trim()
          : // Strip the leading "## title\n\n" preamble to recover the body.
            existing.text.replace(/^##\s+[^\n]+\n+/, '').trim()
      const appliesTo =
        typeof body.appliesTo === 'string' &&
        (USER_SETTABLE_APPLIES as string[]).includes(body.appliesTo)
          ? (body.appliesTo as AppliesTo)
          : existing.appliesTo

      const absPath = join(userDir, existing.path)
      await writeFile(absPath, renderFile(newTitle, newBody), 'utf8')
      await scanNow()

      // Content hash changed → new id. Look up the post-edit row.
      const updated = deps.store
        .listChunks({ source: 'user', limit: 500 })
        .items.find((r) => r.path === existing.path)
      if (!updated) return c.json({ error: 'chunk written but not re-indexed' }, 500)
      deps.store.classify(updated.id, appliesTo, 'user')
      const final = deps.store.getById(updated.id)
      return c.json({
        ok: true,
        chunk: final
          ? {
              id: final.id,
              source: final.source,
              path: final.path,
              sectionTitle: final.sectionTitle,
              excerpt: final.text.replace(/\s+/g, ' ').trim().slice(0, 280),
              appliesTo: final.appliesTo,
              classifiedBy: final.classifiedBy,
            }
          : null,
      })
    })

    // DELETE /v1/procedural/chunks/:id  — unlink the file; reader purges row
    app.delete('/v1/procedural/chunks/:id', async (c) => {
      const id = c.req.param('id')
      const existing = deps.store.getById(id)
      if (!existing) return c.json({ error: 'chunk not found' }, 404)
      if (existing.source !== 'user') {
        return c.json({ error: 'only user-source chunks are deletable' }, 403)
      }
      const absPath = join(userDir, existing.path)
      await unlink(absPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
      await scanNow()
      return c.json({ ok: true })
    })
  }
}

// ----------------------------------------------------------------------------
// Recording sessions (Phase 2)
// ----------------------------------------------------------------------------

function mountRecordingRoutes(
  app: Hono,
  deps: {
    store: RecordingSessionStore
    onStopped?: (sessionId: string) => void
  }
): void {
  // GET /v1/recordings/active — capture-agent polls this every few seconds
  // to decide whether to enter intensified mode. Public-ish: anything that
  // can authenticate can read; we never tag the inverse "off" because no
  // session is the default.
  app.get('/v1/recordings/active', (c) => {
    const session = deps.store.getActive()
    return c.json({ session })
  })

  // GET /v1/recordings — recent list for the review/status UI.
  app.get('/v1/recordings', (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
    return c.json({ items: deps.store.listRecent(limit) })
  })

  // POST /v1/recordings/start { taskId, taskTitle? } — start a session.
  // Refuses if another session is already active (single-active invariant).
  app.post('/v1/recordings/start', async (c) => {
    let body: { taskId?: unknown; taskTitle?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (!taskId) return c.json({ error: 'taskId is required' }, 400)
    const existing = deps.store.getActive()
    if (existing) {
      return c.json(
        {
          error: 'a recording session is already active',
          session: existing,
        },
        409
      )
    }
    const taskTitle =
      typeof body.taskTitle === 'string' ? body.taskTitle.trim() || null : null
    const session = deps.store.start({ taskId, taskTitle })
    return c.json({ ok: true, session }, 201)
  })

  // POST /v1/recordings/:id/stop — stop a session. Returns the session row;
  // distillation worker (separate process) picks it up via status='pending'.
  app.post('/v1/recordings/:id/stop', (c) => {
    const id = c.req.param('id')
    const session = deps.store.stop(id)
    if (!session) return c.json({ error: 'session not found' }, 404)
    deps.onStopped?.(id)
    return c.json({ ok: true, session })
  })
}


