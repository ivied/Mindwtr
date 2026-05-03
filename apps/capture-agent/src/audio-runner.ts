/**
 * Audio runner — independent loop that records audio chunks, gates on RMS,
 * transcribes via Whisper, and ships the transcript to AI Service.
 *
 * Runs in parallel to the screen runner — they share neither state nor
 * timing. Pause flag + privacy exclusions are still respected: while paused
 * the loop sleeps; we never record.
 */

import type { AudioRecorder } from './capture/audio-recorder'
import type { WhisperClient } from './capture/whisper'
import type { ActiveWindowProvider } from './capture/active-window'
import { computeEnergy } from './capture/audio-energy'
import { isPaused } from './filter/pause'
import { shouldSkip, type ExclusionRules } from './filter/exclusion'

export interface AudioRunnerDeps {
  recorder: AudioRecorder
  whisper: WhisperClient
  /** When set, audio capture is suppressed if the active app/title is excluded. */
  window: ActiveWindowProvider | null
  rules: ExclusionRules
  pauseFlagPath: string
  /** Send the transcribed text to AI Service. */
  send: (text: string) => Promise<void>
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

  if (deps.window) {
    const win = await deps.window.current()
    if (win && shouldSkip(win, deps.rules)) return 'excluded'
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
    return 'silent'
  }

  let text: string
  try {
    text = await deps.whisper.transcribe(chunk.data)
  } catch (err) {
    deps.log?.(`transcribe-error: ${(err as Error).message}`)
    return 'transcribe-error'
  }

  if (text.length < config.minTranscriptLength) {
    deps.log?.(`short-transcript (${text.length} chars): "${text}"`)
    return 'short-transcript'
  }

  try {
    await deps.send(text)
    deps.log?.(`audio captured ${text.length}ch · "${text.slice(0, 80)}…"`)
  } catch (err) {
    deps.log?.(`send-error: ${(err as Error).message}`)
    return 'send-error'
  }
  return null
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
