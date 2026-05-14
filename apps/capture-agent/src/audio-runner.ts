/**
 * Audio runner — independent loop that records audio chunks, gates on RMS,
 * transcribes via Whisper, and ships the transcript to AI Service.
 *
 * Runs in parallel to the screen runner — they share neither state nor
 * timing. Pause flag + privacy exclusions are still respected: while paused
 * the loop sleeps; we never record.
 */

import type { AudioRecorder, RecordedChunk } from './capture/audio-recorder'
import type { WhisperClient } from './capture/whisper'
import type { ActiveWindowProvider } from './capture/active-window'
import { computeEnergy } from './capture/audio-energy'
import { isPaused } from './filter/pause'
import { shouldSkip, type ExclusionRules } from './filter/exclusion'
import type { ActiveWindowInfo } from './types'
import type { DiarizeResult, Diarizer } from './capture/diarizer'
import { unlink } from 'node:fs/promises'

export interface AudioArchiveContext {
  text: string
  ts: Date
  window: ActiveWindowInfo | null
  durationMs: number
  rms: number
  diarize: DiarizeResult | null
}

export interface AudioRunnerDeps {
  recorder: AudioRecorder
  whisper: WhisperClient
  /** When set, audio capture is suppressed if the active app/title is excluded. */
  window: ActiveWindowProvider | null
  rules: ExclusionRules
  pauseFlagPath: string
  /** Optional speaker diarizer — called between transcribe and send. */
  diarizer?: Diarizer | null
  /** Send the transcribed text to AI Service. */
  send: (text: string, ctx: AudioArchiveContext) => Promise<void>
  /** Optional fail-open hook called between transcribe and send. */
  archive?: (ctx: AudioArchiveContext) => Promise<void>
  log?: (msg: string) => void
}

export interface AudioRunnerConfig {
  /** Length of each audio chunk in ms. Default 30s. */
  chunkMs: number
  /** Minimum RMS to consider chunk "spoken". Default 0.005. */
  energyThreshold: number
  /** Minimum transcript length to ship. Filters Whisper hallucination on near-silent audio. */
  minTranscriptLength: number
}

export const DEFAULT_AUDIO_RUNNER_CONFIG: AudioRunnerConfig = {
  chunkMs: 30_000,
  energyThreshold: 0.005,
  minTranscriptLength: 8,
}

export type AudioSkipReason =
  | 'paused'
  | 'excluded'
  | 'silent'
  | 'short-transcript'
  | 'record-error'
  | 'transcribe-error'
  | 'send-error'
  | null

export interface AudioLoopController {
  stop: () => Promise<void>
}

/**
 * Run a single capture-transcribe cycle. Returns a skip reason or null on success.
 */
export async function runAudioOnce(
  deps: AudioRunnerDeps,
  config: AudioRunnerConfig = DEFAULT_AUDIO_RUNNER_CONFIG
): Promise<AudioSkipReason> {
  if (await isPaused(deps.pauseFlagPath)) return 'paused'

  let activeWindow: ActiveWindowInfo | null = null
  if (deps.window) {
    activeWindow = await deps.window.current()
    if (activeWindow && shouldSkip(activeWindow, deps.rules)) return 'excluded'
  }

  let chunk
  try {
    chunk = await deps.recorder.record(config.chunkMs)
  } catch (err) {
    deps.log?.(`record-error: ${(err as Error).message}`)
    return 'record-error'
  }

  const energy = computeEnergy(chunk.data, config.energyThreshold)
  if (!energy.hasSignal) {
    deps.log?.(`silent (rms=${energy.rms.toFixed(4)})`)
    await cleanupTemp(chunk, deps.log)
    return 'silent'
  }

  let text: string
  try {
    text = await deps.whisper.transcribe(chunk.data)
  } catch (err) {
    deps.log?.(`transcribe-error: ${(err as Error).message}`)
    await cleanupTemp(chunk, deps.log)
    return 'transcribe-error'
  }

  if (text.length < config.minTranscriptLength) {
    deps.log?.(`short-transcript (${text.length} chars): "${text}"`)
    await cleanupTemp(chunk, deps.log)
    return 'short-transcript'
  }

  let diarize: DiarizeResult | null = null
  if (deps.diarizer && chunk.tempPath) {
    try {
      diarize = await deps.diarizer.diarize(chunk.tempPath)
      if (diarize) {
        deps.log?.(
          `diarize: ${diarize.speakerCount} speaker(s), user=${diarize.userSeen ? `${diarize.userSpeechMs}ms` : 'no'} other=${diarize.otherSpeechMs}ms`
        )
      }
    } catch (err) {
      deps.log?.(`diarize-error (non-fatal): ${(err as Error).message}`)
    }
  }

  const archiveCtx: AudioArchiveContext = {
    text,
    ts: new Date(),
    window: activeWindow,
    durationMs: chunk.durationMs,
    rms: energy.rms,
    diarize,
  }

  if (deps.archive) {
    try {
      await deps.archive(archiveCtx)
    } catch (err) {
      deps.log?.(`archive-error (non-fatal): ${(err as Error).message}`)
    }
  }

  try {
    await deps.send(text, archiveCtx)
    deps.log?.(`audio captured ${text.length}ch · "${text.slice(0, 80)}…"`)
  } catch (err) {
    deps.log?.(`send-error: ${(err as Error).message}`)
    return 'send-error'
  } finally {
    await cleanupTemp(chunk, deps.log)
  }
  return null
}

async function cleanupTemp(chunk: RecordedChunk, log?: (msg: string) => void): Promise<void> {
  if (!chunk.tempPath) return
  try {
    await unlink(chunk.tempPath)
  } catch {
    // best-effort
    log?.(`cleanup: failed to unlink ${chunk.tempPath}`)
  }
}

/**
 * Start the audio loop. Each iteration records a chunk, transcribes it, and
 * sends. There is NO inter-iteration sleep — the recorder itself blocks
 * for chunkMs while capturing, providing natural pacing.
 */
export function startAudioLoop(
  deps: AudioRunnerDeps,
  config: AudioRunnerConfig = DEFAULT_AUDIO_RUNNER_CONFIG
): AudioLoopController {
  let stopped = false

  const tick = async () => {
    while (!stopped) {
      const reason = await runAudioOnce(deps, config).catch((err) => {
        deps.log?.(`audio-runner crashed: ${(err as Error).message}`)
        return 'record-error' as AudioSkipReason
      })
      if (reason && reason !== null) {
        // backoff slightly on errors so we don't tight-loop on a broken mic
        if (reason.endsWith('-error')) await sleep(2000)
      }
    }
  }

  // Fire and forget; the loop runs until stop() flips the flag.
  void tick()

  return {
    async stop() {
      stopped = true
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
