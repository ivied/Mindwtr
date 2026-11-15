/**
 * AgentRunStore — durable state + event log for agent runs (see ./types).
 *
 * Lives in the shared context.db. Every transition is a single UPDATE guarded
 * by the expected state, so a late runner callback can't clobber a state the
 * user already moved on from.
 */

import { randomUUID } from 'node:crypto'
import type { DB } from '../context-store/db'
import {
  WAITING_STATES,
  type AccessRecord,
  type AccessSpec,
  type AgentRunEvent,
  type AgentRunRecord,
  type AgentRunState,
  type ClaimedRun,
  type FinishInput,
  type PendingConfirm,
  type PendingRequest,
  type RunEventInput,
  type RunImageRef,
  type RunReply,
  type RunKind,
  type RunResult,
} from './types'

export const AGENT_RUNS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_title TEXT NOT NULL,
  task_description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  pending TEXT,
  result TEXT,
  reply TEXT,
  mid_messages TEXT NOT NULL DEFAULT '[]',
  stop_requested INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  turn_started_at TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  heartbeat_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_state ON agent_runs(state);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_run_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Secrets in transit: entered in the UI, deleted the moment the runner claims the run.
CREATE TABLE IF NOT EXISTS agent_run_secrets (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE IF NOT EXISTS agent_accesses (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  hosts TEXT NOT NULL DEFAULT '[]',
  env_vars TEXT NOT NULL DEFAULT '[]',
  mcp_server TEXT NOT NULL DEFAULT '',
  skill TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run_attachments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_quota_usage (
  ts TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pct REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_quota_usage_ts ON agent_quota_usage (ts);
`

/** Columns added after the first release; applied to databases created before them. */
const RUN_COLUMNS_ADDED: Array<[string, string]> = [
  ['kind', "TEXT NOT NULL DEFAULT 'task'"],
  ['parent_run_id', 'TEXT'],
  // The confirmation the user approved for the turn in flight (see approvedConfirm).
  ['approved', 'TEXT'],
]

interface AccessRow {
  name: string
  kind: string
  scope: string
  hosts: string
  env_vars: string
  mcp_server: string
  skill: string
  notes: string
  status: string
  run_id: string | null
  created_at: string
  updated_at: string
}

interface RunRow {
  id: string
  kind: string
  parent_run_id: string | null
  task_id: string
  task_title: string
  task_description: string
  state: string
  session_id: string | null
  cwd: string | null
  pending: string | null
  result: string | null
  approved?: string | null
  reply: string | null
  mid_messages: string
  stop_requested: number
  cost_usd: number
  duration_ms: number
  turn_started_at: string | null
  step_count: number
  claimed_by: string | null
  heartbeat_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface EventRow {
  run_id: string
  seq: number
  ts: string
  kind: string
  payload: string
}

/** Event kinds that count as a visible step in the UI. */
const STEP_KINDS = new Set(['say', 'tool', 'user', 'done', 'error'])

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toRecord(r: RunRow): AgentRunRecord {
  return {
    id: r.id,
    kind: r.kind === 'provision' ? 'provision' : 'task',
    parentRunId: r.parent_run_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    taskDescription: r.task_description,
    state: r.state as AgentRunState,
    sessionId: r.session_id,
    cwd: r.cwd,
    pending: parseJson<PendingRequest | null>(r.pending, null),
    result: parseJson<RunResult | null>(r.result, null),
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    turnStartedAt: r.turn_started_at,
    stepCount: r.step_count,
    claimedBy: r.claimed_by,
    heartbeatAt: r.heartbeat_at,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface EnqueueInput {
  taskId: string
  taskTitle: string
  taskDescription?: string
  kind?: RunKind
  parentRunId?: string | null
}

function toAccess(r: AccessRow): AccessRecord {
  return {
    name: r.name,
    kind: r.kind as AccessRecord['kind'],
    scope: r.scope === 'write' ? 'write' : 'read',
    hosts: parseJson<string[]>(r.hosts, []),
    envVars: parseJson<string[]>(r.env_vars, []),
    mcpServer: r.mcp_server,
    skill: r.skill,
    notes: r.notes,
    status: r.status as AccessRecord['status'],
    runId: r.run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface HeartbeatResult {
  /** The user pressed stop — the runner should interrupt the turn. */
  stop: boolean
  /** Messages the user sent while the turn was running. */
  messages: RunReply[]
}

export class AgentRunStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date()
  ) {
    db.exec(AGENT_RUNS_SCHEMA_SQL)
    const have = new Set(
      db.query<{ name: string }, []>('PRAGMA table_info(agent_runs)').all().map((c) => c.name)
    )
    for (const [column, ddl] of RUN_COLUMNS_ADDED) {
      if (!have.has(column)) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${column} ${ddl}`)
    }
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private row(id: string): RunRow | null {
    return this.db.query<RunRow, [string]>('SELECT * FROM agent_runs WHERE id = ?').get(id) ?? null
  }

  get(id: string): AgentRunRecord | null {
    const r = this.row(id)
    return r ? toRecord(r) : null
  }

  /** The run still in play for a task (anything not closed), newest first. */
  activeForTask(taskId: string): AgentRunRecord | null {
    const r = this.db
      .query<RunRow, [string]>(
        "SELECT * FROM agent_runs WHERE task_id = ? AND state != 'closed' ORDER BY created_at DESC LIMIT 1"
      )
      .get(taskId)
    return r ? toRecord(r) : null
  }

  /** Queue a run for a task. Idempotent: an existing active run is returned as-is. */
  enqueue(input: EnqueueInput): { run: AgentRunRecord; created: boolean } {
    const existing = this.activeForTask(input.taskId)
    if (existing) return { run: existing, created: false }
    const id = randomUUID()
    const ts = this.iso()
    this.db.run(
      `INSERT INTO agent_runs (id, kind, parent_run_id, task_id, task_title, task_description, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [id, input.kind ?? 'task', input.parentRunId ?? null, input.taskId, input.taskTitle, input.taskDescription ?? '', ts, ts]
    )
    return { run: this.get(id)!, created: true }
  }

  list(opts: { includeClosed?: boolean; limit?: number } = {}): AgentRunRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
    const where = opts.includeClosed ? '' : "WHERE state != 'closed'"
    return this.db
      .query<RunRow, [number]>(`SELECT * FROM agent_runs ${where} ORDER BY created_at ASC LIMIT ?`)
      .all(limit)
      .map(toRecord)
  }

  listEvents(runId: string, sinceSeq = 0): AgentRunEvent[] {
    return this.db
      .query<EventRow, [string, number]>(
        'SELECT * FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC'
      )
      .all(runId, sinceSeq)
      .map((e) => ({
        runId: e.run_id,
        seq: e.seq,
        ts: e.ts,
        kind: e.kind as AgentRunEvent['kind'],
        payload: parseJson<Record<string, unknown>>(e.payload, {}),
      }))
  }

  appendEvents(runId: string, events: RunEventInput[]): number {
    if (events.length === 0) return 0
    const ts = this.iso()
    const tx = this.db.transaction(() => {
      const last =
        this.db
          .query<{ m: number | null }, [string]>(
            'SELECT MAX(seq) AS m FROM agent_run_events WHERE run_id = ?'
          )
          .get(runId)?.m ?? 0
      let seq = last
      let steps = 0
      for (const e of events) {
        seq += 1
        if (STEP_KINDS.has(e.kind)) steps += 1
        this.db.run(
          'INSERT INTO agent_run_events (run_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)',
          [runId, seq, ts, e.kind, JSON.stringify(e.payload ?? {})]
        )
      }
      this.db.run(
        'UPDATE agent_runs SET step_count = step_count + ?, updated_at = ? WHERE id = ?',
        [steps, ts, runId]
      )
    })
    tx()
    return events.length
  }

  /** Sum of cost for runs touched since `sinceIso` — the daily budget meter. */
  spentSince(sinceIso: string): number {
    const r = this.db
      .query<{ s: number | null }, [string]>(
        'SELECT SUM(cost_usd) AS s FROM agent_runs WHERE updated_at >= ?'
      )
      .get(sinceIso)
    return r?.s ?? 0
  }

  /** Keep a screenshot the user attached to a reply. */
  addAttachment(runId: string, name: string, mime: string, data: Uint8Array): RunImageRef {
    const id = crypto.randomUUID()
    this.db
      .query('INSERT INTO agent_run_attachments (id, run_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, runId, name, mime, data, this.iso())
    return { id, name, mime }
  }

  getAttachment(runId: string, id: string): { name: string; mime: string; data: Uint8Array } | null {
    return (
      this.db
        .query<{ name: string; mime: string; data: Uint8Array }, [string, string]>(
          'SELECT name, mime, data FROM agent_run_attachments WHERE id = ? AND run_id = ?'
        )
        .get(id, runId) ?? null
    )
  }

  /** Share of the weekly subscription quota a turn used, as measured by the runner. */
  addQuota(runId: string, pct: number, tsIso: string): void {
    this.db.query('INSERT INTO agent_quota_usage (ts, run_id, pct) VALUES (?, ?, ?)').run(tsIso, runId, pct)
  }

  /** Percent of the weekly quota agents used since `sinceIso`. */
  quotaSince(sinceIso: string): number {
    const r = this.db
      .query<{ s: number | null }, [string]>('SELECT SUM(pct) AS s FROM agent_quota_usage WHERE ts >= ?')
      .get(sinceIso)
    return r?.s ?? 0
  }

  /** Latest heartbeat from any runner — lets the UI say "runner offline". */
  lastRunnerSeenAt(): string | null {
    const r = this.db
      .query<{ v: string | null }, []>("SELECT value AS v FROM agent_run_meta WHERE key = 'runner_seen_at'")
      .get()
    return r?.v ?? null
  }

  /** Small settings that belong to the agents and must survive restarts. */
  getMeta(key: string): string | null {
    return this.db.query<{ v: string }, [string]>('SELECT value AS v FROM agent_run_meta WHERE key = ?').get(key)?.v ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      `INSERT INTO agent_run_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    )
  }

  touchRunner(): void {
    this.db.run(
      `INSERT INTO agent_run_meta (key, value) VALUES ('runner_seen_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [this.iso()]
    )
  }

  /**
   * Hand queued runs to a runner. Resumes (runs that already have a session)
   * go first — the user is waiting on those. `allowFresh=false` (daily budget
   * exhausted) holds back runs that have never started.
   */
  claim(runner: string, capacity: number, allowFresh = true): ClaimedRun[] {
    this.touchRunner()
    if (capacity <= 0) return []
    const out: ClaimedRun[] = []
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query<RunRow, []>(
          `SELECT * FROM agent_runs WHERE state = 'queued'
           ORDER BY (session_id IS NULL) ASC, updated_at ASC`
        )
        .all()
      for (const r of rows) {
        if (out.length >= capacity) break
        if (!r.session_id && !allowFresh) continue
        const ts = this.iso()
        this.db.run(
          `UPDATE agent_runs SET state = 'running', claimed_by = ?, heartbeat_at = ?, turn_started_at = ?,
             reply = NULL, pending = NULL, stop_requested = 0, mid_messages = '[]', error = NULL, updated_at = ?
           WHERE id = ? AND state = 'queued'`,
          [runner, ts, ts, ts, r.id]
        )
        const secrets = this.db
          .query<{ name: string; value: string }, [string]>(
            'SELECT name, value FROM agent_run_secrets WHERE run_id = ?'
          )
          .all(r.id)
        this.db.run('DELETE FROM agent_run_secrets WHERE run_id = ?', [r.id])
        out.push({ run: this.get(r.id)!, reply: parseJson<RunReply | null>(r.reply, null), secrets })
      }
    })
    tx()
    return out
  }

  /** Runner progress ping; returns anything the user did mid-turn. */
  heartbeat(
    runId: string,
    patch: { sessionId?: string | null; costUsd?: number; cwd?: string | null } = {}
  ): HeartbeatResult {
    this.touchRunner()
    const r = this.row(runId)
    if (!r) return { stop: true, messages: [] }
    // The run was taken away from this turn (the user stopped it, a resume was
    // queued, …) — tell the runner to drop it. A run the reaper parked only
    // because this server could not be reached comes back to life instead.
    if (r.state !== 'running' && !this.revive(r)) return { stop: true, messages: [] }
    const ts = this.iso()
    const messages = parseJson<RunReply[]>(r.mid_messages, [])
    this.db.run(
      `UPDATE agent_runs SET heartbeat_at = ?, session_id = COALESCE(?, session_id), cwd = COALESCE(?, cwd),
         cost_usd = MAX(cost_usd, ?), mid_messages = '[]', updated_at = ?
       WHERE id = ?`,
      [ts, patch.sessionId ?? null, patch.cwd ?? null, patch.costUsd ?? 0, ts, runId]
    )
    return { stop: r.stop_requested === 1, messages }
  }

  /** True when the run was parked by the reaper and nothing has happened to it since. */
  isLost(runId: string): boolean {
    const r = this.row(runId)
    return !!r && r.state === 'stopped' && r.error === 'runner lost'
  }

  /**
   * The reaper parks a run whose runner went silent. If the silence was on our
   * side (server down or starved) the turn is still alive on the host: put the
   * run back to `running` when its runner shows up again.
   */
  private revive(r: RunRow): boolean {
    if (r.state !== 'stopped' || r.error !== 'runner lost') return false
    const ts = this.iso()
    this.db.run(
      `UPDATE agent_runs SET state = 'running', error = NULL, heartbeat_at = ?, turn_started_at = ?, updated_at = ?
       WHERE id = ? AND state = 'stopped' AND error = 'runner lost'`,
      [ts, ts, ts, r.id]
    )
    this.appendEvents(r.id, [{ kind: 'say', payload: { text: 'Связь с раннером восстановилась — агент продолжает работу.' } }])
    return true
  }

  /** Runner reports the end of a turn. No-op unless the run is still running. */
  finish(runId: string, input: FinishInput): AgentRunRecord | null {
    let r = this.row(runId)
    if (!r) return null
    // A turn that kept working while the server was unreachable still gets to report.
    if (input.error !== 'runner lost' && this.revive(r)) r = this.row(runId)!
    if (r.state !== 'running') return toRecord(r)
    const now = this.now()
    const ts = now.toISOString()
    const turnMs = r.turn_started_at ? Math.max(0, now.getTime() - Date.parse(r.turn_started_at)) : 0
    this.db.run(
      `UPDATE agent_runs SET state = ?, pending = ?, result = COALESCE(?, result),
         session_id = COALESCE(?, session_id), cwd = COALESCE(?, cwd), cost_usd = MAX(cost_usd, ?),
         duration_ms = duration_ms + ?, turn_started_at = NULL, stop_requested = 0, approved = NULL,
         error = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
      [
        input.state,
        input.pending ? JSON.stringify(input.pending) : null,
        input.result ? JSON.stringify(input.result) : null,
        input.sessionId ?? null,
        input.cwd ?? null,
        input.costUsd ?? 0,
        turnMs,
        input.error ?? null,
        ts,
        runId,
      ]
    )
    return this.get(runId)
  }

  /**
   * The user answered / approved / rejected / wrote a message.
   *  - parked run  → logged, re-queued; the runner resumes the session with it
   *  - running run → handed to the live turn on its next heartbeat
   *  - queued run  → folded into the reply already waiting
   */
  reply(runId: string, reply: RunReply): AgentRunRecord | null {
    const r = this.row(runId)
    if (!r || r.state === 'closed') return r ? toRecord(r) : null
    const ts = this.iso()
    const text = reply.text.trim()
    const images = reply.images ?? []
    if (text || images.length) {
      this.appendEvents(runId, [{ kind: 'user', payload: { text, reply: reply.kind, ...(images.length ? { images } : {}) } }])
    }

    if (r.state === 'running') {
      const mid = parseJson<RunReply[]>(r.mid_messages, [])
      mid.push(reply)
      this.db.run('UPDATE agent_runs SET mid_messages = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(mid),
        ts,
        runId,
      ])
    } else if (r.state === 'queued') {
      const prev = parseJson<RunReply | null>(r.reply, null)
      const merged: RunReply = prev
        ? {
            kind: prev.kind,
            text: [prev.text, reply.text].filter(Boolean).join('\n'),
            images: [...(prev.images ?? []), ...(reply.images ?? [])],
          }
        : reply
      this.db.run('UPDATE agent_runs SET reply = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(merged),
        ts,
        runId,
      ])
    } else if (WAITING_STATES.has(r.state as AgentRunState)) {
      // Approving a confirmation is remembered for the turn it starts, word for
      // word as the user saw it; any other reply approves nothing.
      const pending = parseJson<PendingRequest | null>(r.pending, null)
      const approved = reply.kind === 'approve' && r.state === 'confirm' && pending?.kind === 'confirm' ? r.pending : null
      this.db.run(
        `UPDATE agent_runs SET state = 'queued', reply = ?, approved = ?, updated_at = ? WHERE id = ? AND state = ?`,
        [JSON.stringify(reply), approved, ts, runId, r.state]
      )
    }
    return this.get(runId)
  }

  /**
   * What the user approved for the turn now running, or null. Server-side
   * actions that must not happen without consent (sending a Telegram message)
   * check against this instead of trusting the agent. It lasts one turn.
   */
  approvedConfirm(runId: string): PendingConfirm | null {
    const r = this.row(runId)
    if (!r || r.state !== 'running') return null
    const p = parseJson<PendingRequest | null>(r.approved ?? null, null)
    return p?.kind === 'confirm' ? p : null
  }

  /** Use the approval up: one confirmation covers one action. False when it is already gone. */
  takeApproval(runId: string): boolean {
    const res = this.db.run(
      "UPDATE agent_runs SET approved = NULL WHERE id = ? AND state = 'running' AND approved IS NOT NULL",
      [runId]
    )
    return res.changes > 0
  }

  /** Give a taken approval back when the action it covered did not happen. */
  restoreApproval(runId: string, confirm: PendingConfirm): void {
    this.db.run("UPDATE agent_runs SET approved = ? WHERE id = ? AND state = 'running' AND approved IS NULL", [
      JSON.stringify(confirm),
      runId,
    ])
  }

  /** Stop: a running turn is interrupted on its next heartbeat; a queued run parks at once. */
  requestStop(runId: string): AgentRunRecord | null {
    const r = this.row(runId)
    if (!r) return null
    const ts = this.iso()
    if (r.state === 'running') {
      this.db.run('UPDATE agent_runs SET stop_requested = 1, updated_at = ? WHERE id = ?', [ts, runId])
    } else if (r.state === 'queued') {
      this.db.run("UPDATE agent_runs SET state = 'stopped', updated_at = ? WHERE id = ?", [ts, runId])
    }
    return this.get(runId)
  }

  /** Hold a secret until the runner claims the run. */
  putSecret(runId: string, name: string, value: string): void {
    this.db.run(
      `INSERT INTO agent_run_secrets (run_id, name, value) VALUES (?, ?, ?)
       ON CONFLICT(run_id, name) DO UPDATE SET value = excluded.value`,
      [runId, name, value]
    )
  }

  /** Rewrite the pending request of a parked run (e.g. link the provisioning run). */
  setPending(runId: string, pending: PendingRequest): AgentRunRecord | null {
    this.db.run('UPDATE agent_runs SET pending = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(pending),
      this.iso(),
      runId,
    ])
    return this.get(runId)
  }

  // ── Access registry ───────────────────────────────────────────────────────

  listAccesses(opts: { includeRevoked?: boolean } = {}): AccessRecord[] {
    const where = opts.includeRevoked ? '' : "WHERE status != 'revoked'"
    return this.db
      .query<AccessRow, []>(`SELECT * FROM agent_accesses ${where} ORDER BY created_at ASC`)
      .all()
      .map(toAccess)
  }

  getAccess(name: string): AccessRecord | null {
    const r = this.db.query<AccessRow, [string]>('SELECT * FROM agent_accesses WHERE name = ?').get(name)
    return r ? toAccess(r) : null
  }

  /** Register (or re-register) an access a provisioning run connected. */
  upsertAccess(spec: AccessSpec, runId: string | null): AccessRecord {
    const ts = this.iso()
    this.db.run(
      `INSERT INTO agent_accesses (name, kind, scope, hosts, env_vars, mcp_server, skill, notes, status, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, hosts = excluded.hosts,
         env_vars = excluded.env_vars, mcp_server = excluded.mcp_server, skill = excluded.skill,
         notes = excluded.notes, status = 'active', run_id = excluded.run_id, updated_at = excluded.updated_at`,
      [
        spec.name,
        spec.kind,
        spec.scope,
        JSON.stringify(spec.hosts),
        JSON.stringify(spec.envVars),
        spec.mcpServer,
        spec.skill,
        spec.notes,
        runId,
        ts,
        ts,
      ]
    )
    return this.getAccess(spec.name)!
  }

  /**
   * Make sure an access that ships with the service is in the registry. A new
   * one is added as active and an active one gets the current description; one
   * the user revoked stays revoked.
   */
  seedAccess(spec: AccessSpec): AccessRecord {
    const existing = this.getAccess(spec.name)
    if (!existing) return this.upsertAccess(spec, null)
    if (existing.status !== 'active') return existing
    // Keep the scope the user chose (they may have narrowed it to read).
    return this.upsertAccess({ ...spec, scope: existing.scope }, existing.runId)
  }

  /** active → revoking (the runner removes it from the host) → revoked. */
  setAccessStatus(name: string, from: AccessRecord['status'], to: AccessRecord['status']): AccessRecord | null {
    this.db.run('UPDATE agent_accesses SET status = ?, updated_at = ? WHERE name = ? AND status = ?', [
      to,
      this.iso(),
      name,
      from,
    ])
    return this.getAccess(name)
  }

  close(runId: string): AgentRunRecord | null {
    this.db.run("UPDATE agent_runs SET state = 'closed', pending = NULL, updated_at = ? WHERE id = ?", [
      this.iso(),
      runId,
    ])
    return this.get(runId)
  }

  /**
   * Park runs whose runner went silent (crash, reboot). They keep their
   * session, so the user can resume them from the UI.
   */
  reapStale(maxSilenceMs: number): string[] {
    const cutoff = new Date(this.now().getTime() - maxSilenceMs).toISOString()
    const rows = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM agent_runs WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)"
      )
      .all(cutoff)
    for (const { id } of rows) {
      this.appendEvents(id, [
        { kind: 'error', payload: { text: 'Раннер перестал отвечать. Прогон можно продолжить.' } },
      ])
      this.finish(id, { state: 'stopped', error: 'runner lost' })
    }
    return rows.map((r) => r.id)
  }
}
