/**
 * Proposal Store — CRUD over proposals + versions + messages + audit.
 *
 * Backed by the shared context.db (same SQLite file as captures). Designed for
 * transactional consistency with capture-related writes (e.g. proposal creation
 * referencing a capture id).
 */

import { randomUUID } from 'node:crypto'
import type { DB } from '../context-store/db'
import type {
  AddMessageInput,
  AddVersionInput,
  AuditEvent,
  AuditInput,
  CreateProposalInput,
  ListPendingFilter,
  ProposalActor,
  ProposalAuditRecord,
  ProposalAuthor,
  ProposalDetail,
  ProposalMessageRecord,
  ProposalRecord,
  ProposalStatus,
  ProposalType,
  ProposalVersionRecord,
  MessageRole,
} from './types'

interface ProposalRow {
  id: string
  type: string
  target_task_ids: string
  source_capture_id: string | null
  source_agent: string
  status: string
  current_payload: string
  current_version: number
  origin_snapshot: string | null
  created_at: string
  resolved_at: string | null
  resolved_by: string | null
}

interface VersionRow {
  proposal_id: string
  version: number
  payload: string
  author: string
  summary: string | null
  created_at: string
}

interface MessageRow {
  id: string
  proposal_id: string
  role: string
  text: string
  ref_version: number | null
  created_at: string
}

interface AuditRow {
  id: string
  proposal_id: string
  event: string
  event_meta: string | null
  actor: string
  ts: string
}

const RESOLVED_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  'approved',
  'rejected',
  'superseded',
  'stale',
  'expired',
])

export class ProposalStore {
  constructor(private db: DB) {}

  /** Create a proposal in `pending` status with version 1. Records 'created' audit event. */
  create(input: CreateProposalInput): ProposalRecord {
    const id = randomUUID()
    const now = new Date().toISOString()
    const author: ProposalAuthor = input.author ?? 'agent'
    const payloadJson = JSON.stringify(input.payload)
    const targetIdsJson = JSON.stringify(input.targetTaskIds)
    const snapshotJson =
      input.originSnapshot !== undefined ? JSON.stringify(input.originSnapshot) : null

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO proposals
         (id, type, target_task_ids, source_capture_id, source_agent, status,
          current_payload, current_version, origin_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
        [
          id,
          input.type,
          targetIdsJson,
          input.sourceCaptureId ?? null,
          input.sourceAgent,
          payloadJson,
          snapshotJson,
          now,
        ]
      )
      this.db.run(
        `INSERT INTO proposal_versions (proposal_id, version, payload, author, summary, created_at)
         VALUES (?, 1, ?, ?, ?, ?)`,
        [id, payloadJson, author, input.summary ?? null, now]
      )
      this.insertAudit(id, 'created', author, { type: input.type, summary: input.summary }, now)
    })()

    return {
      id,
      type: input.type,
      targetTaskIds: input.targetTaskIds,
      sourceCaptureId: input.sourceCaptureId ?? null,
      sourceAgent: input.sourceAgent,
      status: 'pending',
      currentPayload: input.payload,
      currentVersion: 1,
      originSnapshot: input.originSnapshot ?? null,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    }
  }

  /** Append a new version. Bumps current_version and updates current_payload. */
  addVersion(input: AddVersionInput): ProposalVersionRecord {
    const proposal = this.requireProposal(input.proposalId)
    if (RESOLVED_STATUSES.has(proposal.status)) {
      throw new Error(
        `Cannot add version to ${proposal.status} proposal ${input.proposalId}`
      )
    }
    const now = new Date().toISOString()
    const nextVersion = proposal.currentVersion + 1
    const payloadJson = JSON.stringify(input.payload)

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO proposal_versions (proposal_id, version, payload, author, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.proposalId, nextVersion, payloadJson, input.author, input.summary ?? null, now]
      )
      this.db.run(
        `UPDATE proposals SET current_payload = ?, current_version = ? WHERE id = ?`,
        [payloadJson, nextVersion, input.proposalId]
      )
      this.insertAudit(input.proposalId, 'revised', input.author, {
        version: nextVersion,
        summary: input.summary,
      }, now)
    })()

    return {
      proposalId: input.proposalId,
      version: nextVersion,
      payload: input.payload,
      author: input.author,
      summary: input.summary ?? null,
      createdAt: now,
    }
  }

  /** Append a comment from user or agent. Records 'commented' audit event. */
  addMessage(input: AddMessageInput): ProposalMessageRecord {
    const proposal = this.requireProposal(input.proposalId)
    if (RESOLVED_STATUSES.has(proposal.status)) {
      throw new Error(
        `Cannot comment on ${proposal.status} proposal ${input.proposalId}`
      )
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const refVersion = input.refVersion ?? proposal.currentVersion

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO proposal_messages (id, proposal_id, role, text, ref_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.proposalId, input.role, input.text, refVersion, now]
      )
      this.insertAudit(input.proposalId, 'commented', input.role, { messageId: id, refVersion }, now)
    })()

    return {
      id,
      proposalId: input.proposalId,
      role: input.role,
      text: input.text,
      refVersion,
      createdAt: now,
    }
  }

  /**
   * Atomically transition status with an audit row. resolved_at/by are set when
   * moving to a terminal status. No-op when already in target status (still
   * records audit so we keep the trail).
   */
  transition(
    proposalId: string,
    nextStatus: ProposalStatus,
    actor: ProposalActor,
    meta?: Record<string, unknown>,
    resolvedBy?: string
  ): void {
    const proposal = this.requireProposal(proposalId)
    if (proposal.status === nextStatus) return

    const now = new Date().toISOString()
    const event = statusToEvent(nextStatus)
    const isResolved = RESOLVED_STATUSES.has(nextStatus)

    this.db.transaction(() => {
      if (isResolved) {
        this.db.run(
          `UPDATE proposals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`,
          [nextStatus, now, resolvedBy ?? null, proposalId]
        )
      } else {
        this.db.run(
          `UPDATE proposals SET status = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?`,
          [nextStatus, proposalId]
        )
      }
      this.insertAudit(proposalId, event, actor, meta, now)
    })()
  }

  /** Append a free-form audit event without changing state (e.g. 'applied', 'apply_failed'). */
  audit(input: AuditInput): ProposalAuditRecord {
    const id = randomUUID()
    const ts = new Date().toISOString()
    this.insertAuditWithId(
      id,
      input.proposalId,
      input.event,
      input.actor,
      input.meta,
      ts
    )
    return {
      id,
      proposalId: input.proposalId,
      event: input.event,
      eventMeta: input.meta ?? null,
      actor: input.actor,
      ts,
    }
  }

  get(proposalId: string): ProposalRecord | null {
    const row = this.db
      .query<ProposalRow, [string]>(
        `SELECT id, type, target_task_ids, source_capture_id, source_agent, status,
                current_payload, current_version, origin_snapshot, created_at,
                resolved_at, resolved_by
         FROM proposals WHERE id = ?`
      )
      .get(proposalId)
    return row ? proposalRowToRecord(row) : null
  }

  /** Full aggregate including versions (asc), messages (asc), audit (asc). */
  getDetail(proposalId: string): ProposalDetail | null {
    const proposal = this.get(proposalId)
    if (!proposal) return null
    return {
      ...proposal,
      versions: this.versions(proposalId),
      messages: this.messages(proposalId),
      audit: this.auditLog(proposalId),
    }
  }

  versions(proposalId: string): ProposalVersionRecord[] {
    return this.db
      .query<VersionRow, [string]>(
        `SELECT proposal_id, version, payload, author, summary, created_at
         FROM proposal_versions WHERE proposal_id = ? ORDER BY version ASC`
      )
      .all(proposalId)
      .map(versionRowToRecord)
  }

  messages(proposalId: string): ProposalMessageRecord[] {
    // Order by rowid: monotonic insertion order, robust against same-ms timestamps.
    return this.db
      .query<MessageRow, [string]>(
        `SELECT id, proposal_id, role, text, ref_version, created_at
         FROM proposal_messages WHERE proposal_id = ? ORDER BY rowid ASC`
      )
      .all(proposalId)
      .map(messageRowToRecord)
  }

  auditLog(proposalId: string): ProposalAuditRecord[] {
    // Order by rowid: monotonic insertion order, robust against same-ms timestamps.
    return this.db
      .query<AuditRow, [string]>(
        `SELECT id, proposal_id, event, event_meta, actor, ts
         FROM proposal_audit WHERE proposal_id = ? ORDER BY rowid ASC`
      )
      .all(proposalId)
      .map(auditRowToRecord)
  }

  /**
   * Recent proposals for the given agent (any status) created within the
   * lookback window. Used by Writer for dedup against TG-loop / OCR-spam
   * sequences that produce near-identical proposals on consecutive ticks.
   */
  listRecentByAgent(sourceAgent: string, withinMs: number, limit = 50): ProposalRecord[] {
    const cutoff = new Date(Date.now() - withinMs).toISOString()
    return this.db
      .query<ProposalRow, [string, string, number]>(
        `SELECT id, type, target_task_ids, source_capture_id, source_agent, status,
                current_payload, current_version, origin_snapshot, created_at,
                resolved_at, resolved_by
         FROM proposals
         WHERE source_agent = ? AND created_at > ?
         ORDER BY rowid DESC
         LIMIT ?`
      )
      .all(sourceAgent, cutoff, limit)
      .map(proposalRowToRecord)
  }

  /** List pending proposals matching filter, newest first. */
  listPending(filter: ListPendingFilter = {}): ProposalRecord[] {
    const where: string[] = [`status = 'pending'`]
    const params: (string | number)[] = []

    if (filter.sourceAgent) {
      where.push(`source_agent = ?`)
      params.push(filter.sourceAgent)
    }
    if (filter.type) {
      where.push(`type = ?`)
      params.push(filter.type)
    }
    if (filter.targetTaskId) {
      // target_task_ids is a JSON array; check membership via json_each
      where.push(
        `EXISTS (SELECT 1 FROM json_each(target_task_ids) WHERE json_each.value = ?)`
      )
      params.push(filter.targetTaskId)
    }

    const limit = filter.limit ?? 100
    // Order by rowid DESC (newest insert first) — robust against same-ms created_at.
    const sql = `SELECT id, type, target_task_ids, source_capture_id, source_agent, status,
                        current_payload, current_version, origin_snapshot, created_at,
                        resolved_at, resolved_by
                 FROM proposals
                 WHERE ${where.join(' AND ')}
                 ORDER BY rowid DESC
                 LIMIT ?`
    params.push(limit)

    return this.db
      .query<ProposalRow, (string | number)[]>(sql)
      .all(...params)
      .map(proposalRowToRecord)
  }

  // --- internal ---

  private requireProposal(id: string): ProposalRecord {
    const p = this.get(id)
    if (!p) throw new Error(`Proposal not found: ${id}`)
    return p
  }

  private insertAudit(
    proposalId: string,
    event: AuditEvent,
    actor: ProposalActor | MessageRole | ProposalAuthor,
    meta: Record<string, unknown> | undefined,
    ts: string
  ): void {
    this.insertAuditWithId(randomUUID(), proposalId, event, actor, meta, ts)
  }

  private insertAuditWithId(
    id: string,
    proposalId: string,
    event: AuditEvent,
    actor: ProposalActor | MessageRole | ProposalAuthor,
    meta: Record<string, unknown> | undefined,
    ts: string
  ): void {
    this.db.run(
      `INSERT INTO proposal_audit (id, proposal_id, event, event_meta, actor, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, proposalId, event, meta ? JSON.stringify(meta) : null, actor, ts]
    )
  }
}

function statusToEvent(status: ProposalStatus): AuditEvent {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'superseded':
      return 'superseded'
    case 'stale':
      return 'stale'
    case 'expired':
      return 'expired'
    case 'pending':
      // Re-opening to pending isn't a planned flow, but if it ever happens
      // we still want an audit row — log as 'revised' since it implies edit.
      return 'revised'
  }
}

function proposalRowToRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    type: row.type as ProposalType,
    targetTaskIds: parseJsonArray(row.target_task_ids),
    sourceCaptureId: row.source_capture_id,
    sourceAgent: row.source_agent,
    status: row.status as ProposalStatus,
    currentPayload: parseJson(row.current_payload),
    currentVersion: row.current_version,
    originSnapshot: row.origin_snapshot ? parseJson(row.origin_snapshot) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  }
}

function versionRowToRecord(row: VersionRow): ProposalVersionRecord {
  return {
    proposalId: row.proposal_id,
    version: row.version,
    payload: parseJson(row.payload),
    author: row.author as ProposalAuthor,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

function messageRowToRecord(row: MessageRow): ProposalMessageRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    role: row.role as MessageRole,
    text: row.text,
    refVersion: row.ref_version,
    createdAt: row.created_at,
  }
}

function auditRowToRecord(row: AuditRow): ProposalAuditRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    event: row.event as AuditEvent,
    eventMeta: row.event_meta ? (parseJson(row.event_meta) as Record<string, unknown>) : null,
    actor: row.actor as ProposalActor,
    ts: row.ts,
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function parseJsonArray(raw: string): string[] {
  const parsed = parseJson(raw)
  return Array.isArray(parsed) ? (parsed as string[]) : []
}
