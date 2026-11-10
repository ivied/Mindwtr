/**
 * HTTP routes for agent runs.
 *
 * Two audiences share the /v1/agent-runs prefix (same bearer token):
 *  - the Mindwtr UI: list / detail+events / enqueue / reply / stop / accept
 *  - the host runner: claim / events (heartbeat) / finish
 */

import type { Hono } from 'hono'
import type { CreateTaskParams, Task } from '../api/mindwtr-client'
import type { AgentRunStore } from './store'
import {
  stateOfPending,
  type AccessSpec,
  type AgentRunRecord,
  type AgentRunsMemory,
  type FinishInput,
  type PendingRequest,
  type RunEventInput,
  type RunReply,
  type RunReplyKind,
  type RunResult,
  type TaskChanges,
} from './types'

/** The slice of MindwtrClient the routes need (kept narrow for tests). */
export interface AgentRunsMindwtr {
  getTask(id: string): Promise<Task>
  listTasks(params: { status?: string; limit?: number }): Promise<Task[]>
  updateTask(id: string, updates: Partial<CreateTaskParams>): Promise<Task>
  completeTask(id: string): Promise<Task>
  search(query: string): Promise<{ tasks: Task[]; projects: unknown[] }>
}

export interface AgentRunsHttpDeps {
  store: AgentRunStore
  mindwtr: AgentRunsMindwtr
  /** Fresh runs stop being handed out once today's spend reaches this. 0 = no cap. */
  dailyBudgetUsd: number
  /**
   * Fresh runs also stop once agents used this many percent of the weekly
   * subscription quota today (the runner measures it per turn). 0 = no cap.
   */
  dailyQuotaPct?: number
  /** Running runs silent for longer than this are parked as `stopped`. */
  staleAfterMs?: number
  /**
   * When set, the runner endpoints (claim / events / finish / revoked) also
   * require it in \`x-runner-token\`. The UI token is baked into the web bundle,
   * so without this anyone holding the bundle could claim a run and receive the
   * secrets entered for it.
   */
  runnerToken?: string
  /** Memory: facts for a task, and the facts the user confirmed. */
  memory?: AgentRunsMemory
  /** Public address of this server; browser sign-ins are sent back to `<publicUrl>/oauth/callback`. */
  publicUrl?: string
  now?: () => Date
  log?: (msg: string) => void
}

const REPLY_KINDS: ReadonlySet<string> = new Set(['answer', 'approve', 'reject', 'message', 'resume'])
const EVENT_KINDS: ReadonlySet<string> = new Set(['say', 'tool', 'tool_result', 'user', 'done', 'error'])
const FINISH_STATES: ReadonlySet<string> = new Set(['question', 'confirm', 'done', 'stopped', 'error'])
const APPLICABLE_STATUSES: ReadonlySet<string> = new Set([
  'inbox',
  'next',
  'waiting',
  'someday',
  'reference',
  'done',
])
const MAX_EVENT_BYTES = 16_000
const ACCESS_KINDS: ReadonlySet<string> = new Set(['mcp', 'cli', 'http', 'ssh', 'other'])
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/
const ACCESS_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const HOST = /^[a-z0-9.-]+(:\d+)?$/i
/** Names the agents' own plumbing uses — a "secret" must not be able to replace them. */
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|AI_SERVICE_|MINDWTR_|AGENT_RUNNER_|ANTHROPIC_|CLAUDE_)/

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 40)
}

export function sanitizeAccess(raw: unknown): AccessSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = slugify(str(r.name, 80))
  if (!ACCESS_NAME.test(name)) return null
  const kind = str(r.kind)
  return {
    name,
    kind: (ACCESS_KINDS.has(kind) ? kind : 'other') as AccessSpec['kind'],
    scope: r.scope === 'write' ? 'write' : 'read',
    hosts: strList(r.hosts, 12, 200).map((h) => h.trim().toLowerCase()).filter((h) => HOST.test(h)),
    envVars: strList(r.envVars, 12, 64).filter((v) => ENV_NAME.test(v) && !RESERVED_ENV.test(v)),
    mcpServer: /^[A-Za-z0-9._-]{1,60}$/.test(str(r.mcpServer)) ? str(r.mcpServer) : '',
    skill: /^[A-Za-z0-9._-]{1,60}$/.test(str(r.skill)) ? str(r.skill) : '',
    notes: str(r.notes, 1000).trim(),
  }
}

const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Screenshots attached to a reply: `[{ name, mime, data: base64 }]`. */
export function parseImages(
  v: unknown
): { images: Array<{ name: string; mime: string; data: Uint8Array }> } | { error: string } {
  if (v === undefined || v === null) return { images: [] }
  if (!Array.isArray(v)) return { error: 'images must be an array' }
  if (v.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images` }
  const images: Array<{ name: string; mime: string; data: Uint8Array }> = []
  for (const item of v as Array<Record<string, unknown>>) {
    const mime = typeof item?.mime === 'string' ? item.mime : ''
    if (!IMAGE_MIMES.has(mime)) return { error: 'images must be png, jpeg, webp or gif' }
    const raw = typeof item.data === 'string' ? item.data : ''
    if (!raw || raw.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return { error: 'image is empty or larger than 8 MB' }
    const data = new Uint8Array(Buffer.from(raw, 'base64'))
    if (!data.length || data.length > MAX_IMAGE_BYTES) return { error: 'image is empty or larger than 8 MB' }
    const name = (typeof item.name === 'string' ? item.name : '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'screenshot'
    images.push({ name, mime, data })
  }
  return { images }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const strList = (v: unknown, maxItems = 12, maxLen = 400): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, maxItems)
        .map((x) => x.slice(0, maxLen))
    : []

export function sanitizeChanges(raw: unknown): TaskChanges {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: TaskChanges = {}
  if (str(r.title, 300).trim()) out.title = str(r.title, 300).trim()
  if (APPLICABLE_STATUSES.has(str(r.status))) out.status = str(r.status)
  const contexts = strList(r.contexts)
  if (contexts.length) out.contexts = contexts
  const addTags = strList(r.addTags)
  if (addTags.length) out.addTags = addTags
  if (str(r.project, 200).trim()) out.project = str(r.project, 200).trim()
  if (str(r.descriptionAppend, 6000).trim()) out.descriptionAppend = str(r.descriptionAppend, 6000).trim()
  return out
}

export function sanitizeResult(raw: unknown): RunResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const summary = str(r.summary, 4000).trim()
  if (!summary) return null
  const access = sanitizeAccess(r.access)
  const lessons = (Array.isArray(r.lessons) ? r.lessons : [])
    .map((l) => {
      const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
      return { statement: str(o.statement, 500).trim(), entity: str(o.entity, 80).trim() }
    })
    .filter((l) => l.statement.length >= 8)
    .slice(0, 5)
  return {
    summary,
    evidence: strList(r.evidence),
    changes: sanitizeChanges(r.changes),
    ...(access ? { access } : {}),
    ...(lessons.length ? { lessons } : {}),
  }
}

export function sanitizePending(raw: unknown): PendingRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'question') {
    const question = str(r.question, 2000).trim()
    return question ? { kind: 'question', question, options: strList(r.options, 6, 200) } : null
  }
  if (r.kind === 'confirm') {
    const action = str(r.action, 400).trim()
    if (!action) return null
    return { kind: 'confirm', action, target: str(r.target, 400).trim(), draft: str(r.draft, 8000) }
  }
  if (r.kind === 'access') {
    const service = str(r.service, 120).trim()
    if (!service) return null
    return {
      kind: 'access',
      service,
      purpose: str(r.purpose, 1000).trim(),
      scope: r.scope === 'write' ? 'write' : 'read',
      provisionRunId: null,
    }
  }
  if (r.kind === 'oauth') {
    const name = str(r.name, 40).trim()
    const url = str(r.url, 4000)
    const state = str(r.state, 200)
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name) || !/^https:\/\//.test(url) || !/^[A-Za-z0-9_-]{16,200}$/.test(state)) return null
    return { kind: 'oauth', name, label: str(r.label, 200).trim() || name, url, state, hint: str(r.hint, 1000).trim(), local: r.local === true }
  }
  if (r.kind === 'secret') {
    const name = str(r.name, 64).trim()
    if (!ENV_NAME.test(name) || RESERVED_ENV.test(name)) return null
    return {
      kind: 'secret',
      name,
      label: str(r.label, 200).trim() || name,
      hint: str(r.hint, 1000).trim(),
      url: /^https:\/\//.test(str(r.url, 500)) ? str(r.url, 500) : '',
    }
  }
  return null
}

/** Build the Mindwtr patch for an accepted result. Pure — tested directly. */
export function buildTaskPatch(
  task: Pick<Task, 'tags' | 'description'>,
  result: RunResult,
  projectId: string | null
): { patch: Partial<CreateTaskParams>; complete: boolean } {
  const c = result.changes
  const patch: Partial<CreateTaskParams> = {}
  if (c.title) patch.title = c.title
  if (c.contexts) patch.contexts = c.contexts
  if (c.addTags) patch.tags = [...new Set([...(task.tags ?? []), ...c.addTags])]
  if (projectId) patch.projectId = projectId
  const complete = c.status === 'done'
  if (c.status && !complete) patch.status = c.status

  const lines = [`## Результат агента`, result.summary]
  if (result.evidence.length) lines.push('', ...result.evidence.map((e) => `- ${e}`))
  if (c.descriptionAppend) lines.push('', c.descriptionAppend)
  const prev = (task.description ?? '').trim()
  patch.description = (prev ? prev + '\n\n' : '') + lines.join('\n')
  return { patch, complete }
}

function startOfLocalDay(now: Date): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function mountAgentRunsRoutes(app: Hono, deps: AgentRunsHttpDeps): void {
  const { store, mindwtr } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((m: string) => console.log(`[agent-runs] ${m}`))
  const staleAfterMs = deps.staleAfterMs ?? 3 * 60_000

  const spentToday = () => store.spentSince(startOfLocalDay(now()))
  const dailyQuotaPct = deps.dailyQuotaPct ?? 0
  const quotaToday = () => store.quotaSince(startOfLocalDay(now()))
  /** Why fresh runs are not handed out right now, if they are not. */
  const holdReason = (): 'quota' | 'budget' | null =>
    dailyQuotaPct > 0 && quotaToday() >= dailyQuotaPct
      ? 'quota'
      : deps.dailyBudgetUsd > 0 && spentToday() >= deps.dailyBudgetUsd
        ? 'budget'
        : null
  const view = (run: AgentRunRecord) => run

  const runnerOnly = (c: { req: { header(name: string): string | undefined } }): boolean =>
    !deps.runnerToken || c.req.header('x-runner-token') === deps.runnerToken

  const provisionBrief = (service: string, scope: string, purpose: string, note = ''): string =>
    [
      `Сервис: ${service}`,
      `Уровень доступа, который одобрил пользователь: ${scope === 'write' ? 'чтение и запись' : 'только чтение'}`,
      purpose ? `Зачем нужен: ${purpose}` : '',
      note ? `Комментарий пользователя: ${note}` : '',
    ]
      .filter(Boolean)
      .join('\n')

  /** A provisioning run ended: tell every task run that was waiting for it. */
  const wakeParent = (child: AgentRunRecord, access: AccessSpec | null, why = ''): void => {
    for (const parent of store.list()) {
      if (parent.state !== 'confirm' || parent.pending?.kind !== 'access') continue
      if (parent.pending.provisionRunId !== child.id) continue
      store.reply(
        parent.id,
        access
          ? {
              kind: 'answer',
              text: `Доступ «${access.name}» подключён (${access.scope === 'write' ? 'чтение и запись' : 'только чтение'}). ${access.notes}`.trim(),
            }
          : { kind: 'reject', text: `Доступ не подключён${why ? `: ${why}` : ''}. Продолжай без него.` }
      )
    }
  }

  /** A sign-in came back: hand the code to the run that is waiting for exactly this `state`. */
  const acceptSignIn = (
    params: URLSearchParams,
    runId?: string
  ): { status: 'unknown' } | { status: 'accepted' | 'refused'; label: string } => {
    const state = params.get('state') ?? ''
    const run = state
      ? store
          .list()
          .find((r) => r.state === 'question' && r.pending?.kind === 'oauth' && r.pending.state === state && (!runId || r.id === runId))
      : undefined
    if (!run || run.pending?.kind !== 'oauth') return { status: 'unknown' }
    const { name, label } = run.pending
    const code = params.get('code') ?? ''
    if (!code) {
      const why = (params.get('error_description') ?? params.get('error') ?? 'сервис не вернул код').slice(0, 300)
      store.reply(run.id, { kind: 'answer', text: `Вход в «${label}» не выполнен: ${why}` })
      return { status: 'refused', label }
    }
    store.putSecret(run.id, `oauth-code:${name}`, code.slice(0, 4000))
    store.reply(run.id, { kind: 'answer', text: `Пользователь вошёл в «${label}» через браузер.` })
    log(`sign-in accepted for ${run.id.slice(0, 8)} (${name})`)
    return { status: 'accepted', label }
  }

  // What the user told the agents to treat as true. Lives in memory as
  // confirmed facts; this is the user's window onto them.
  app.get('/v1/agent-knowledge', (c) => c.json({ items: deps.memory?.list() ?? [], available: !!deps.memory }))

  app.get('/v1/agent-knowledge/preview', async (c) => {
    if (!deps.memory) return c.json({ error: 'memory is not available' }, 503)
    return c.json({ context: await deps.memory.taskContext(str(c.req.query('q'), 4000)) })
  })

  app.post('/v1/agent-knowledge', async (c) => {
    if (!deps.memory) return c.json({ error: 'memory is not available' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { statement?: unknown; entity?: unknown }
    const statement = str(body.statement, 500).trim()
    if (statement.length < 8) return c.json({ error: 'слишком короткое утверждение' }, 400)
    return c.json({ item: deps.memory.save(statement, str(body.entity, 80).trim()) })
  })

  app.delete('/v1/agent-knowledge/:id', (c) => {
    if (!deps.memory) return c.json({ error: 'memory is not available' }, 503)
    const removed = deps.memory.remove(Number(c.req.param('id')))
    return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // Where a service sends the browser after a sign-in the runner started.
  // Public on purpose (the browser has no token): the unguessable \`state\` is
  // what ties the request to a run that is waiting for exactly this sign-in.
  app.get('/oauth/callback', (c) => {
    const page = (title: string, body: string, status: 200 | 400 | 404 = 200) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
          `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#1f2328;background:#fff">` +
          `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`,
        status
      )
    const outcome = acceptSignIn(new URLSearchParams(new URL(c.req.url).search))
    if (outcome.status === 'unknown') {
      return page('Вход не найден', 'Этот вход уже использован или устарел. Начните подключение заново в списке агентов.', 404)
    }
    const label = outcome.label.replace(/[<>&"]/g, '')
    if (outcome.status === 'refused') {
      return page('Вход не выполнен', `Сервис «${label}» не подтвердил вход. Агент сообщит подробности в списке решений.`, 400)
    }
    return page('Вход выполнен', `Доступ к «${label}» подключается. Эту вкладку можно закрыть — агент продолжит сам.`)
  })

  // Same thing when the service returned to the runner's computer but the user
  // signed in on another device: they paste the address the browser ended on.
  app.post('/v1/agent-runs/:id/sign-in', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
    let params: URLSearchParams
    try {
      params = new URL(str(body.url, 6000).trim()).searchParams
    } catch {
      return c.json({ error: 'вставьте адрес целиком, начиная с http' }, 400)
    }
    const outcome = acceptSignIn(params, c.req.param('id'))
    if (outcome.status === 'unknown') return c.json({ error: 'в адресе нет кода этого входа — скопируйте адрес из вкладки, открывшейся после входа' }, 400)
    return c.json({ run: view(store.get(c.req.param('id'))!), accepted: outcome.status === 'accepted' })
  })

  app.get('/v1/agent-runs', (c) => {
    store.reapStale(staleAfterMs)
    const includeClosed = c.req.query('all') === '1'
    return c.json({
      items: store.list({ includeClosed }).map(view),
      spentTodayUsd: spentToday(),
      dailyBudgetUsd: deps.dailyBudgetUsd,
      quotaTodayPct: quotaToday(),
      dailyQuotaPct,
      hold: holdReason(),
      runnerSeenAt: store.lastRunnerSeenAt(),
      accesses: store.listAccesses(),
      now: now().toISOString(),
    })
  })

  app.get('/v1/agent-runs/:id', (c) => {
    const run = store.get(c.req.param('id'))
    if (!run) return c.json({ error: 'run not found' }, 404)
    const sinceRaw = Number(c.req.query('since') ?? 0)
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0
    return c.json({ run: view(run), events: store.listEvents(run.id, since), now: now().toISOString() })
  })

  // Enqueue one task ({ taskId }) or every inbox task without an active run ({ inbox: true }).
  app.post('/v1/agent-runs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { taskId?: unknown; inbox?: unknown; provision?: unknown }
    if (body.provision && typeof body.provision === 'object') {
      const p = body.provision as { service?: unknown; scope?: unknown; note?: unknown }
      const service = str(p.service, 120).trim()
      if (!service) return c.json({ error: 'provision.service required' }, 400)
      const scope = p.scope === 'write' ? 'write' : 'read'
      const { run, created } = store.enqueue({
        kind: 'provision',
        taskId: `access:${slugify(service) || 'service'}`,
        taskTitle: `Подключить доступ: ${service}`,
        taskDescription: provisionBrief(service, scope, '', str(p.note, 1000).trim()),
      })
      return c.json({ enqueued: created ? 1 : 0, items: [view(run)] })
    }
    try {
      if (typeof body.taskId === 'string' && body.taskId) {
        const task = await mindwtr.getTask(body.taskId)
        const { run, created } = store.enqueue({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description ?? '',
        })
        return c.json({ enqueued: created ? 1 : 0, items: [view(run)] })
      }
      if (body.inbox === true) {
        const tasks = await mindwtr.listTasks({ status: 'inbox', limit: 200 })
        const items: AgentRunRecord[] = []
        let enqueued = 0
        for (const t of tasks) {
          const { run, created } = store.enqueue({
            taskId: t.id,
            taskTitle: t.title,
            taskDescription: t.description ?? '',
          })
          if (created) enqueued += 1
          items.push(view(run))
        }
        log(`enqueue inbox: ${enqueued} new of ${tasks.length}`)
        return c.json({ enqueued, items })
      }
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502)
    }
    return c.json({ error: 'taskId (string) or inbox:true required' }, 400)
  })

  app.post('/v1/agent-runs/:id/reply', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; text?: unknown; images?: unknown }
    const kind = str(body.kind)
    if (!REPLY_KINDS.has(kind)) return c.json({ error: 'kind must be answer|approve|reject|message|resume' }, 400)
    const text = str(body.text, 8000).trim()
    const id = c.req.param('id')
    if (!store.get(id)) return c.json({ error: 'run not found' }, 404)
    const parsed = parseImages(body.images)
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    if (!text && !parsed.images.length && (kind === 'answer' || kind === 'message')) return c.json({ error: 'text required' }, 400)
    const images = parsed.images.map((img) => store.addAttachment(id, img.name, img.mime, img.data))
    const reply: RunReply = { kind: kind as RunReplyKind, text, ...(images.length ? { images } : {}) }
    const run = store.reply(id, reply)
    if (!run) return c.json({ error: 'run not found' }, 404)
    return c.json({ run: view(run) })
  })

  // A screenshot attached to a reply: the runner saves it for the agent, the UI shows it in the log.
  app.get('/v1/agent-runs/:id/attachments/:attachmentId', (c) => {
    const att = store.getAttachment(c.req.param('id'), c.req.param('attachmentId'))
    if (!att) return c.json({ error: 'attachment not found' }, 404)
    return c.body(new Uint8Array(att.data), 200, { 'Content-Type': att.mime, 'Cache-Control': 'private, max-age=86400' })
  })

  // The user decides on an access a task agent asked for. Granting starts a
  // provisioning run; the task run stays parked until that one ends.
  app.post('/v1/agent-runs/:id/access', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown; scope?: unknown; note?: unknown }
    const run = store.get(c.req.param('id'))
    if (!run) return c.json({ error: 'run not found' }, 404)
    if (run.state !== 'confirm' || run.pending?.kind !== 'access') {
      return c.json({ error: 'run is not waiting for an access decision' }, 409)
    }
    const pending = run.pending
    if (body.decision === 'deny') {
      const updated = store.reply(run.id, {
        kind: 'reject',
        text: `В доступе к «${pending.service}» отказано. ${str(body.note, 1000).trim()}`.trim(),
      })
      return c.json({ run: view(updated!) })
    }
    if (body.decision !== 'grant') return c.json({ error: 'decision must be grant|deny' }, 400)
    if (pending.provisionRunId) return c.json({ run: view(run), provision: store.get(pending.provisionRunId) })
    // The user may narrow what the agent asked for, never widen it silently.
    const scope = body.scope === 'read' || body.scope === 'write' ? body.scope : pending.scope
    const { run: provision } = store.enqueue({
      kind: 'provision',
      parentRunId: run.id,
      taskId: `access:${slugify(pending.service) || 'service'}`,
      taskTitle: `Подключить доступ: ${pending.service}`,
      taskDescription: provisionBrief(pending.service, scope, pending.purpose, str(body.note, 1000).trim()),
    })
    const updated = store.setPending(run.id, { ...pending, scope, provisionRunId: provision.id })
    log(`access "${pending.service}" granted for ${run.id.slice(0, 8)} → provision ${provision.id.slice(0, 8)}`)
    return c.json({ run: view(updated!), provision: view(provision) })
  })

  // The user typed a key the provisioning agent asked for. The value is held
  // only until the runner claims the run and never reaches the event log.
  app.post('/v1/agent-runs/:id/secret', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown }
    const run = store.get(c.req.param('id'))
    if (!run) return c.json({ error: 'run not found' }, 404)
    if (run.state !== 'question' || run.pending?.kind !== 'secret') {
      return c.json({ error: 'run is not waiting for a secret' }, 409)
    }
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    if (!value || value.length > 8000 || /[\r\n]/.test(value)) {
      return c.json({ error: 'value must be a single non-empty line' }, 400)
    }
    const { name } = run.pending
    store.putSecret(run.id, name, value)
    const updated = store.reply(run.id, {
      kind: 'answer',
      text: `Секрет сохранён и доступен в окружении как $${name}.`,
    })
    return c.json({ run: view(updated!) })
  })

  app.post('/v1/agent-accesses/:name/revoke', (c) => {
    const access = store.setAccessStatus(c.req.param('name'), 'active', 'revoking')
    if (!access) return c.json({ error: 'access not found' }, 404)
    log(`access "${access.name}" → ${access.status}`)
    return c.json({ access })
  })

  // Runner: the access was removed from the host.
  app.post('/v1/agent-accesses/:name/revoked', (c) => {
    if (!runnerOnly(c)) return c.json({ error: 'runner token required' }, 403)
    const access = store.setAccessStatus(c.req.param('name'), 'revoking', 'revoked')
    if (!access) return c.json({ error: 'access not found' }, 404)
    return c.json({ access })
  })

  app.post('/v1/agent-runs/:id/stop', (c) => {
    const run = store.requestStop(c.req.param('id'))
    if (!run) return c.json({ error: 'run not found' }, 404)
    return c.json({ run: view(run) })
  })

  // Remove a run from the list whatever it is doing. Nothing is applied to the
  // task; a turn that is still running is told to stop on its next heartbeat.
  app.post('/v1/agent-runs/:id/dismiss', (c) => {
    const id = c.req.param('id')
    const run = store.get(id)
    if (!run) return c.json({ error: 'run not found' }, 404)
    if (run.state === 'closed') return c.json({ run: view(run) })
    // A task that was waiting for this provisioning run must not wait forever.
    if (run.kind === 'provision' && !(run.state === 'done' && run.result?.access)) wakeParent(run, null, 'подключение убрано пользователем')
    log(`dismiss ${id.slice(0, 8)} (was ${run.state})`)
    return c.json({ run: view(store.close(id)!) })
  })

  // Accept the result: apply the proposed task changes, then close the run.
  // { apply: false } closes without touching the task.
  app.post('/v1/agent-runs/:id/accept', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { apply?: unknown; lessons?: unknown }
    const run = store.get(id)
    if (!run) return c.json({ error: 'run not found' }, 404)
    if (run.state === 'running' || run.state === 'queued') {
      return c.json({ error: `run is ${run.state}; stop it first` }, 409)
    }
    let applied = false
    if (run.kind === 'provision') {
      // Nothing to apply to a task. Closing one that never connected the access
      // releases the task run that was waiting for it.
      if (!run.result?.access) wakeParent(run, null, 'настройка закрыта')
      return c.json({ run: view(store.close(id)!), applied: false })
    }
    // Lessons are kept whether or not the task changes are applied: by default
    // all of them, or the ones whose indexes the UI sent back.
    const lessons = run.result?.lessons ?? []
    const keep = Array.isArray(body.lessons) ? new Set(body.lessons.filter((n) => Number.isInteger(n))) : null
    let remembered = 0
    if (deps.memory && run.state === 'done') {
      lessons.forEach((lesson, index) => {
        if (keep && !keep.has(index)) return
        try {
          deps.memory!.save(lesson.statement, lesson.entity)
          remembered++
        } catch (err) {
          log(`lesson not saved for ${id.slice(0, 8)}: ${(err as Error).message}`)
        }
      })
    }
    if (body.apply !== false && run.result) {
      try {
        const task = await mindwtr.getTask(run.taskId)
        let projectId: string | null = null
        if (run.result.changes.project) {
          const want = run.result.changes.project.toLowerCase()
          const found = await mindwtr.search(run.result.changes.project)
          const hit = (found.projects as Array<{ id?: string; title?: string }>).find(
            (p) => typeof p.title === 'string' && p.title.toLowerCase() === want
          )
          projectId = hit?.id ?? null
        }
        const { patch, complete } = buildTaskPatch(task, run.result, projectId)
        await mindwtr.updateTask(run.taskId, patch)
        if (complete) await mindwtr.completeTask(run.taskId)
        applied = true
      } catch (err) {
        return c.json({ error: `не удалось применить изменения: ${(err as Error).message}` }, 502)
      }
    }
    return c.json({ run: view(store.close(id)!), applied, remembered })
  })

  // ── Runner ────────────────────────────────────────────────────────────

  app.post('/v1/agent-runs/claim', async (c) => {
    if (!runnerOnly(c)) return c.json({ error: 'runner token required' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { runner?: unknown; capacity?: unknown }
    const runner = str(body.runner, 80) || 'runner'
    const capRaw = Number(body.capacity)
    const capacity = Number.isFinite(capRaw) ? Math.max(0, Math.min(8, Math.floor(capRaw))) : 0
    store.reapStale(staleAfterMs)
    const overBudget = holdReason() !== null
    const claimed = store.claim(runner, capacity, !overBudget)
    // A task run starts with what memory knows about it; a resumed one already has it.
    if (deps.memory) {
      for (const item of claimed) {
        if (item.run.kind !== 'task' || item.run.sessionId) continue
        try {
          const context = await deps.memory.taskContext(`${item.run.taskTitle}\n${item.run.taskDescription}`)
          if (context) item.context = context
        } catch (err) {
          log(`memory context failed for ${item.run.id.slice(0, 8)}: ${(err as Error).message}`)
        }
      }
    }
    if (claimed.length) log(`claim by ${runner}: ${claimed.map((x) => x.run.id.slice(0, 8)).join(', ')}`)
    return c.json({ items: claimed, overBudget, accesses: store.listAccesses(), publicUrl: deps.publicUrl ?? '' })
  })

  // Append events + heartbeat. Response carries anything the user did mid-turn.
  app.post('/v1/agent-runs/:id/events', async (c) => {
    if (!runnerOnly(c)) return c.json({ error: 'runner token required' }, 403)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as {
      events?: unknown
      sessionId?: unknown
      costUsd?: unknown
      cwd?: unknown
    }
    if (!store.get(id)) return c.json({ error: 'run not found' }, 404)
    const events: RunEventInput[] = []
    for (const e of Array.isArray(body.events) ? body.events.slice(0, 200) : []) {
      const ev = e as { kind?: unknown; payload?: unknown }
      if (typeof ev.kind !== 'string' || !EVENT_KINDS.has(ev.kind)) continue
      const payload = ev.payload && typeof ev.payload === 'object' ? (ev.payload as Record<string, unknown>) : {}
      if (JSON.stringify(payload).length > MAX_EVENT_BYTES) continue
      events.push({ kind: ev.kind as RunEventInput['kind'], payload })
    }
    store.appendEvents(id, events)
    const hb = store.heartbeat(id, {
      sessionId: str(body.sessionId, 100) || null,
      cwd: str(body.cwd, 500) || null,
      costUsd: typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) ? body.costUsd : 0,
    })
    return c.json(hb)
  })

  app.post('/v1/agent-runs/:id/finish', async (c) => {
    if (!runnerOnly(c)) return c.json({ error: 'runner token required' }, 403)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const state = str(body.state)
    if (!FINISH_STATES.has(state)) return c.json({ error: 'bad state' }, 400)
    const before = store.get(id)
    if (!before) return c.json({ error: 'run not found' }, 404)
    const pending = sanitizePending(body.pending)
    if ((state === 'question' || state === 'confirm') && (!pending || stateOfPending(pending) !== state)) {
      return c.json({ error: `a pending request that parks as "${state}" is required` }, 400)
    }
    // Only a provisioning run may ask for secrets or register an access; only a
    // task run may ask for one.
    const provisioning = before.kind === 'provision'
    if ((pending?.kind === 'secret' || pending?.kind === 'oauth') && !provisioning) {
      return c.json({ error: 'secret and sign-in requests are for provisioning runs' }, 400)
    }
    if (pending?.kind === 'access' && provisioning) return c.json({ error: 'a provisioning run cannot request access' }, 400)
    const result = sanitizeResult(body.result)
    if (result?.access && !provisioning) delete result.access
    const wasRunning = before.state === 'running' || store.isLost(id)
    const run = store.finish(id, {
      state: state as FinishInput['state'],
      pending: state === 'question' || state === 'confirm' ? pending : null,
      result,
      sessionId: str(body.sessionId, 100) || null,
      cwd: str(body.cwd, 500) || null,
      costUsd: typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) ? body.costUsd : 0,
      error: str(body.error, 1000) || null,
    })
    if (!run) return c.json({ error: 'run not found' }, 404)
    const quotaPct = Number(body.quotaPct)
    if (wasRunning && Number.isFinite(quotaPct) && quotaPct > 0) store.addQuota(id, Math.min(100, quotaPct), now().toISOString())
    if (wasRunning && provisioning && run.state === 'done') {
      const access = run.result?.access ?? null
      if (access) {
        store.upsertAccess(access, run.id)
        log(`access "${access.name}" registered (${access.kind}, ${access.scope})`)
      }
      wakeParent(run, access, run.result?.summary ?? '')
    }
    log(`finish ${id.slice(0, 8)} → ${run.state}`)
    return c.json({ run: view(run) })
  })
}
