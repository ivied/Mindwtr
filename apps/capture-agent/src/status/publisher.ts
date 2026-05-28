/**
 * StatusPublisher — writes a single JSON snapshot of the pipeline state
 * so external consumers (macOS widget, status bar tools) can read live
 * health without parsing the wiki MD corpus.
 *
 * The capture-agent process is the source of truth: it sees every screen
 * and audio tick, so it knows exactly when the last useful event happened
 * and whether the helper subprocesses are returning data. Anything else
 * (wiki mtime, ai-service /healthz) is downstream.
 *
 * Writes are atomic (temp file + rename) and debounced (default 500ms)
 * so multi-display ticks that produce 2-3 captures don't thrash the FS.
 */

import { writeFile, rename } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { spawn } from 'node:child_process'

export interface ScreenStatus {
  lastCaptureAt: string
  app: string
  title: string
  sentToInbox: boolean
  ocrLength: number
  displayIndex?: number
  isActiveDisplay?: boolean
}

export interface AudioStatus {
  lastChunkAt: string
  rms: number
  transcript: string
  durationMs: number
  speakerCount?: number
  userSeen?: boolean
  likelyMixedSpeakers?: boolean
}

export interface PipelineSnapshot {
  /** ISO timestamp of the last write. Widget uses this to gauge agent liveness. */
  updatedAt: string
  agent: {
    pid: number
    startedAt: string
    /** "Skipped" reason from the most recent screen tick (paused / excluded /
     *  low-ocr / duplicate / wiki-only / null when capture succeeded). */
    lastScreenSkip: string | null
  }
  screen: ScreenStatus | null
  audio: AudioStatus | null
}

export interface StatusPublisherOptions {
  filePath: string
  /** Min ms between disk writes. Default 500. */
  debounceMs?: number
  /** Path to gtd-widget-reload helper. When set, fire-and-forget invocation
   *  after each successful write tells WidgetKit to refresh — without this
   *  macOS throttles widget updates to every 5-15 minutes. */
  reloadHelperPath?: string
}

export class StatusPublisher {
  private readonly filePath: string
  private readonly debounceMs: number
  private readonly reloadHelperPath: string | undefined
  private readonly state: PipelineSnapshot
  private writeTimer: NodeJS.Timeout | null = null
  private writing = false
  private dirty = false

  constructor(opts: StatusPublisherOptions) {
    this.filePath = opts.filePath
    this.debounceMs = opts.debounceMs ?? 500
    this.reloadHelperPath = opts.reloadHelperPath
    this.state = {
      updatedAt: new Date().toISOString(),
      agent: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        lastScreenSkip: null,
      },
      screen: null,
      audio: null,
    }
  }

  updateScreen(s: ScreenStatus): void {
    this.state.screen = s
    this.state.agent.lastScreenSkip = null
    this.scheduleWrite()
  }

  updateAudio(a: AudioStatus): void {
    this.state.audio = a
    this.scheduleWrite()
  }

  recordScreenSkip(reason: string): void {
    this.state.agent.lastScreenSkip = reason
    this.scheduleWrite()
  }

  /** Called every tick regardless of outcome — keeps updatedAt fresh so the
   *  widget can tell "agent alive but idle" apart from "agent dead". */
  heartbeat(): void {
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    this.dirty = true
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.writing) {
      this.scheduleWrite()
      return
    }
    if (!this.dirty) return
    this.writing = true
    this.dirty = false
    this.state.updatedAt = new Date().toISOString()
    const payload = JSON.stringify(this.state, null, 2)
    // Temp file in the SAME dir as target so rename(2) stays on one device.
    const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.tmp`)
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.filePath)
      this.triggerWidgetReload()
    } catch (err) {
      // Best-effort — never let a widget write failure break the agent.
      console.warn(`[status] write failed: ${(err as Error).message}`)
    } finally {
      this.writing = false
    }
  }

  private triggerWidgetReload(): void {
    if (!this.reloadHelperPath) return
    // Fire-and-forget. Helper exits within ~250ms after pushing the reload
    // XPC to WidgetKit. We don't care about its result; if it fails the
    // widget will still refresh on its own timeline policy eventually.
    try {
      const child = spawn(this.reloadHelperPath, ['PipelineWidget'], {
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      child.on('error', () => {
        // Helper missing or unsigned — silently fall back to WidgetKit's
        // built-in refresh cadence.
      })
    } catch {
      // ignore
    }
  }

  async shutdown(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    await this.flush()
  }
}
