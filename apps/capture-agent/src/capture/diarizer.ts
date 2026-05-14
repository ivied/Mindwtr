/**
 * Speaker diarization wrapper — spawns the native gtd-audio-diarize binary
 * (FluidAudio under the hood) and parses its JSON output.
 *
 * Each call takes a WAV file path and an optional voice-profile JSON
 * (produced by gtd-audio-enroll) and returns the list of speaker
 * segments with `is_user` set on the segments matching the enrolled
 * voice. Without a profile, all speakers are anonymous and `is_user`
 * is false everywhere — useful as a fall-back so the rest of the
 * pipeline still runs.
 */

import { spawn } from 'node:child_process'
import { access, readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface DiarizeSegment {
  speakerId: string
  isUser: boolean
  startMs: number
  endMs: number
  durationMs: number
  qualityScore: number
}

export interface DiarizeResult {
  /** Anonymous speaker IDs (or "user" when a known speaker matched). */
  speakersSeen: string[]
  speakerCount: number
  userSpeakerId: string
  segments: DiarizeSegment[]
  /** True when at least one segment was attributed to the enrolled user. */
  userSeen: boolean
  /** Total ms attributed to the enrolled user across the chunk. */
  userSpeechMs: number
  /** Total ms attributed to anyone other than the enrolled user. */
  otherSpeechMs: number
}

export interface DiarizerConfig {
  /** Absolute path to the gtd-audio-diarize binary. */
  binaryPath: string
  /** Absolute path to a voice profile JSON from gtd-audio-enroll. Empty = skip identification. */
  profilePath: string
  /** Default 0.7 — passed to FluidAudio. Lower = more aggressive splitting. */
  clusteringThreshold: number
  /** Default 0.55 — cosine similarity gate for is_user. Higher = stricter. */
  userMatchThreshold: number
}

export class Diarizer {
  constructor(private readonly config: DiarizerConfig) {}

  async ensureAvailable(): Promise<void> {
    try {
      await access(this.config.binaryPath)
    } catch {
      throw new Error(
        `diarizer binary not found at ${this.config.binaryPath} — run audio-helper/build.sh`
      )
    }
  }

  /** Returns the parsed result and the raw JSON string (for sidecar). null on failure. */
  async diarize(
    wavPath: string
  ): Promise<{ result: DiarizeResult; rawJson: string } | null> {
    let outDir: string | null = null
    try {
      outDir = await mkdtemp(join(tmpdir(), 'gtd-diar-'))
      const outPath = join(outDir, 'segments.json')
      const args = [
        '--input',
        wavPath,
        '--output',
        outPath,
        '--clustering-threshold',
        String(this.config.clusteringThreshold),
        '--user-match-threshold',
        String(this.config.userMatchThreshold),
      ]
      if (this.config.profilePath) {
        args.push('--profile', this.config.profilePath)
      }
      await this.runBinary(args)
      const rawJson = await readFile(outPath, 'utf8')
      return { result: parseDiarizeJson(rawJson), rawJson }
    } catch {
      return null
    } finally {
      if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private runBinary(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString()
      })
      child.on('error', (err) => reject(new Error(`diarize spawn failed: ${err.message}`)))
      child.on('close', (code) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(`diarize exit ${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`)
          )
      })
    })
  }
}

export function parseDiarizeJson(raw: string): DiarizeResult {
  const parsed = JSON.parse(raw) as {
    speakers_seen?: string[]
    speaker_count?: number
    user_speaker_id?: string
    segments?: Array<{
      speaker_id: string
      is_user?: boolean
      start_ms: number
      end_ms: number
      duration_ms?: number
      quality_score?: number
    }>
  }
  const segments: DiarizeSegment[] = (parsed.segments ?? []).map((s) => ({
    speakerId: s.speaker_id,
    isUser: Boolean(s.is_user),
    startMs: s.start_ms,
    endMs: s.end_ms,
    durationMs: s.duration_ms ?? s.end_ms - s.start_ms,
    qualityScore: s.quality_score ?? 0,
  }))
  let userSpeechMs = 0
  let otherSpeechMs = 0
  for (const seg of segments) {
    if (seg.isUser) userSpeechMs += seg.durationMs
    else otherSpeechMs += seg.durationMs
  }
  return {
    speakersSeen: parsed.speakers_seen ?? [],
    speakerCount: parsed.speaker_count ?? new Set(segments.map((s) => s.speakerId)).size,
    userSpeakerId: parsed.user_speaker_id ?? '',
    segments,
    userSeen: segments.some((s) => s.isUser),
    userSpeechMs,
    otherSpeechMs,
  }
}
