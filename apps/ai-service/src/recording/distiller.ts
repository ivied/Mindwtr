/**
 * RecordingDistiller — turns a stopped recording session into a playbook chunk.
 *
 * Inputs:
 *   - All captures (screen + audio) tagged with this session's id during the
 *     start→stop window. Retrieved via json_extract on source_meta.
 *   - Task title + start/stop times for prompting.
 *
 * Output:
 *   - A markdown file under shared-memory/user/recorded/<slug>-<ts>.md with
 *     metadata in HTML comment (session id, task id, derived_from). The file
 *     becomes a procedural chunk on the next reader tick.
 *
 * Errors are recorded on the session row (status='failed', distillation_error
 * set) so the UI can surface them. Sessions with zero captures land as
 * 'skipped'.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMClient } from '../ai/client'
import type { DB } from '../context-store/db'
import type { ProceduralReader, ProceduralStore } from '../memory/procedural'
import type { RecordingSession, RecordingSessionStore } from './store'

const SYSTEM_PROMPT = `You distill task workflows into reusable playbook rules.
Input: a sequence of screen + voice captures recorded while a person performed
one specific task. Your job is to extract the *reusable workflow* — trigger,
steps, tools, rationale — not a narration of this single instance.

Rules:
- Output one short markdown section starting with "## <imperative title>"
  followed by 4-12 bullet steps, each present-tense imperative.
- Each step should be the action + tool + key reason if obvious.
- Skip incidentals (typos, side-quests, slack tangents). Keep it the spine.
- If the data is too thin to extract a workflow with confidence, output just
  "## (insufficient signal)" + one sentence why.

Never invent steps. If you can't tell what the user did, say "(insufficient signal)".`

interface SessionCapture {
  ts: string
  channel: string
  text: string
  app?: string
  windowTitle?: string
}

export interface RecordingDistillerOptions {
  llm: LLMClient
  model: string
  db: DB
  sessionStore: RecordingSessionStore
  proceduralStore: ProceduralStore
  proceduralReader: ProceduralReader
  sharedMemoryDir: string
  /** Optional fire-and-forget notification when a draft lands. */
  onDraftReady?: (session: RecordingSession, chunkId: string | null) => void
  log?: (msg: string) => void
}

export class RecordingDistiller {
  private readonly userDir: string

  constructor(private readonly opts: RecordingDistillerOptions) {
    this.userDir = join(opts.sharedMemoryDir, 'user', 'recorded')
  }

  /**
   * Find stopped sessions that haven't been distilled yet and process them.
   * Returns count of sessions processed (any terminal status).
   */
  async distillPending(): Promise<number> {
    const sessions = this.opts.sessionStore.listRecent(200)
    const pending = sessions.filter(
      (s) => s.stoppedAt && s.distillationStatus === 'pending'
    )
    let processed = 0
    for (const s of pending) {
      try {
        await this.distill(s)
      } catch (err) {
        this.opts.sessionStore.setDistillationStatus(s.id, 'failed', {
          error: (err as Error).message,
        })
        this.opts.log?.(`[distill] ${s.id.slice(0, 8)} failed: ${(err as Error).message}`)
      }
      processed += 1
    }
    return processed
  }

  async distill(session: RecordingSession): Promise<void> {
    if (!session.stoppedAt) throw new Error('session not stopped yet')
    this.opts.sessionStore.setDistillationStatus(session.id, 'running')

    const captures = this.fetchSessionCaptures(session)
    if (captures.length === 0) {
      this.opts.sessionStore.setDistillationStatus(session.id, 'skipped', {
        error: 'no captures recorded during session',
      })
      this.opts.log?.(`[distill] ${session.id.slice(0, 8)} skipped: no captures`)
      return
    }

    const draft = await this.runLlm(session, captures)
    if (!draft || draft.length < 30) {
      this.opts.sessionStore.setDistillationStatus(session.id, 'failed', {
        error: 'LLM returned empty / too-short draft',
      })
      return
    }

    const slug = slugify(session.taskTitle ?? session.taskId)
    const ts = new Date(session.stoppedAt).toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const fileName = `${slug}-${ts}.md`
    const absPath = join(this.userDir, fileName)
    const file = this.renderFile(session, draft)

    await mkdir(this.userDir, { recursive: true })
    await writeFile(absPath, file, 'utf8')
    await this.opts.proceduralReader.scanOnce()

    // Reader writes the chunk(s) under source='user' (mined/ and openclaw/ are
    // separate); look them up by path. A single distilled playbook can split
    // into several sub-chunks (the chunker sub-splits long bullet lists), so
    // classify EVERY chunk of this file — not just the first match. Otherwise
    // only one sub-chunk goes 'universal' and the rest stay hidden from the
    // Proposer.
    const relPath = `recorded/${fileName}`
    const created = this.opts.proceduralStore
      .listChunks({ source: 'user', limit: 500 })
      .items.filter((r) => r.path === relPath)

    for (const chunk of created) {
      // Recorded playbooks are user-authored intent: make them immediately
      // visible to the Proposer ('universal') and mark the verdict terminal
      // ('user') so the automated classifier never re-hides them.
      this.opts.proceduralStore.classify(chunk.id, 'universal', 'user')
    }

    const primaryChunkId = created[0]?.id ?? null
    this.opts.sessionStore.setDistillationStatus(session.id, 'done', {
      chunkId: primaryChunkId,
    })
    this.opts.log?.(
      `[distill] ${session.id.slice(0, 8)} done → ${fileName} (${captures.length} captures, ${created.length} chunk(s) → universal)`
    )
    this.opts.onDraftReady?.(session, primaryChunkId)
  }

  private fetchSessionCaptures(session: RecordingSession): SessionCapture[] {
    const rows = this.opts.db
      .query<
        { ts: string; channel: string; text: string; meta: string | null },
        [string, string, string]
      >(
        `SELECT
           captured_at AS ts,
           source_channel AS channel,
           text,
           source_meta AS meta
         FROM captures
         WHERE json_extract(source_meta, '$.recording_session_id') = ?
           AND captured_at >= ?
           AND captured_at <= ?
         ORDER BY captured_at ASC`
      )
      .all(session.id, session.startedAt, session.stoppedAt ?? new Date().toISOString())

    return rows.map((r) => {
      let meta: Record<string, unknown> = {}
      try {
        meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}
      } catch {
        // fall through
      }
      return {
        ts: r.ts,
        channel: r.channel,
        text: r.text,
        app: typeof meta.app === 'string' ? meta.app : undefined,
        windowTitle: typeof meta.windowTitle === 'string' ? meta.windowTitle : undefined,
      }
    })
  }

  private async runLlm(
    session: RecordingSession,
    captures: SessionCapture[]
  ): Promise<string> {
    const taskLabel = session.taskTitle ?? session.taskId
    // Trim each capture's text to keep the prompt bounded.
    const transcript = captures
      .map((c) => {
        const tsLabel = c.ts.slice(11, 19)
        const where = c.app ? ` [${c.app}${c.windowTitle ? ` — ${c.windowTitle.slice(0, 60)}` : ''}]` : ''
        const text = c.text.slice(0, 600).replace(/\s+/g, ' ').trim()
        return `${tsLabel}${where} (${c.channel}): ${text}`
      })
      .join('\n')
      .slice(0, 18_000)

    const user = `Task: ${taskLabel}\n\nCaptures (chronological):\n${transcript}\n\nDistill the workflow.`

    const res = await this.opts.llm.chatCompletion({
      model: this.opts.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      max_tokens: 600,
      temperature: 0.2,
    })
    return (res.choices[0]?.message?.content ?? '').trim()
  }

  private renderFile(session: RecordingSession, draft: string): string {
    const md = draft.startsWith('## ') ? draft : `## Recorded workflow\n\n${draft}`
    const meta = `<!--
source: recorded
recording_session_id: ${session.id}
task_id: ${session.taskId}
task_title: ${(session.taskTitle ?? '').replace(/\n/g, ' ')}
recorded_at: ${session.startedAt}
stopped_at: ${session.stoppedAt}
-->\n`
    return `${meta}${md}\n`
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'recording'
  )
}
