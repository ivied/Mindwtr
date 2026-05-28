/**
 * RecordingSessionStore — task-grounded playbook capture sessions.
 *
 * A session is the bracket between "I'm starting task X" and "I'm done."
 * Captures (screenshots, mic transcripts, window-titles) collected while
 * a session is active get tagged with its id via capture source_meta JSON.
 * After stop, the distillation worker (separate module) reads those
 * tagged captures and emits a playbook chunk under shared-memory/user/recorded/.
 *
 * Only one session can be active at a time per process — enforced at the
 * API layer, not the schema, so the UI can show a clear conflict ("you're
 * already recording task Y").
 */

import { randomUUID } from 'node:crypto'
import type { DB } from '../context-store/db'

export type DistillationStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface RecordingSession {
  id: string
  taskId: string
  taskTitle: string | null
  startedAt: string
  stoppedAt: string | null
  distillationStatus: DistillationStatus
  distilledChunkId: string | null
  distillationError: string | null
}

interface RecordingSessionRow {
  id: string
  task_id: string
  task_title: string | null
  started_at: string
  stopped_at: string | null
  distillation_status: string
  distilled_chunk_id: string | null
  distillation_error: string | null
}

function rowToSession(r: RecordingSessionRow): RecordingSession {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    distillationStatus: r.distillation_status as DistillationStatus,
    distilledChunkId: r.distilled_chunk_id,
    distillationError: r.distillation_error,
  }
}

export class RecordingSessionStore {
  constructor(private readonly db: DB) {}

  start(input: { taskId: string; taskTitle?: string | null }): RecordingSession {
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    this.db
      .query(
        `INSERT INTO recording_sessions
           (id, task_id, task_title, started_at, distillation_status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(id, input.taskId, input.taskTitle ?? null, startedAt)
    return {
      id,
      taskId: input.taskId,
      taskTitle: input.taskTitle ?? null,
      startedAt,
      stoppedAt: null,
      distillationStatus: 'pending',
      distilledChunkId: null,
      distillationError: null,
    }
  }

  /**
   * Set stopped_at on the session. Returns the updated row; null if id
   * doesn't exist or session was already stopped.
   */
  stop(id: string, nowIso = new Date().toISOString()): RecordingSession | null {
    const existing = this.getById(id)
    if (!existing) return null
    if (existing.stoppedAt) return existing
    this.db
      .query('UPDATE recording_sessions SET stopped_at = ? WHERE id = ?')
      .run(nowIso, id)
    return this.getById(id)
  }

  setDistillationStatus(
    id: string,
    status: DistillationStatus,
    extras: { chunkId?: string | null; error?: string | null } = {}
  ): void {
    this.db
      .query(
        `UPDATE recording_sessions
            SET distillation_status = ?,
                distilled_chunk_id = COALESCE(?, distilled_chunk_id),
                distillation_error = ?
          WHERE id = ?`
      )
      .run(status, extras.chunkId ?? null, extras.error ?? null, id)
  }

  getById(id: string): RecordingSession | null {
    const row = this.db
      .query<RecordingSessionRow, [string]>('SELECT * FROM recording_sessions WHERE id = ?')
      .get(id)
    return row ? rowToSession(row) : null
  }

  /** Returns the currently-active session (stopped_at IS NULL) or null. */
  getActive(): RecordingSession | null {
    const row = this.db
      .query<RecordingSessionRow, []>(
        'SELECT * FROM recording_sessions WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1'
      )
      .get()
    return row ? rowToSession(row) : null
  }

  listRecent(limit = 50): RecordingSession[] {
    const rows = this.db
      .query<RecordingSessionRow, [number]>(
        'SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT ?'
      )
      .all(limit)
    return rows.map(rowToSession)
  }
}
