/**
 * Audio recorder — records fixed-length WAV chunks from the default
 * microphone via ffmpeg. macOS uses avfoundation; other platforms TBD.
 *
 * The recorder is a thin wrapper around `Bun.spawn(['ffmpeg', ...])` so the
 * runner can `await record(...)` without managing child processes manually.
 *
 * macOS first-run prompts the user for Microphone permission. The ffmpeg
 * input device is the default system mic (":default" on avfoundation).
 *
 * We write to a temp file (rather than streaming) for two reasons:
 *   1. simpler downstream — Whisper API accepts file uploads natively
 *   2. cleaner failure mode — if ffmpeg crashes mid-chunk we have either
 *      a partial WAV (skipped) or nothing (recorder error)
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'

export interface AudioRecorderConfig {
  /** Path to ffmpeg binary. Default: 'ffmpeg' (relies on $PATH). */
  ffmpegPath: string
  /** Sample rate in Hz. 16000 is recommended for Whisper (mono). */
  sampleRate: number
  /** macOS avfoundation input. ":default" or ":<index>". Linux/Win TBD. */
  inputDevice: string
  /** Working directory for temp WAV files. */
  tmpDir: string
  /** Apply ffmpeg audio filters before writing WAV.
   *  Default chain: highpass→denoise→loudness normalize. Disable with empty string. */
  audioFilter: string
}

export const DEFAULT_AUDIO_FILTER =
  'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11'

export const DEFAULT_AUDIO_RECORDER_CONFIG: AudioRecorderConfig = {
  ffmpegPath: 'ffmpeg',
  sampleRate: 16000,
  inputDevice: ':default',
  tmpDir: tmpdir(),
  audioFilter: DEFAULT_AUDIO_FILTER,
}

export interface RecordedChunk {
  /** PCM/WAV bytes */
  data: Buffer
  /** Path that was used (already deleted by record()), or '' if no temp file. */
  tempPath: string
  /** Actual duration in ms (may differ from requested if recorder cut short) */
  durationMs: number
  sampleRate: number
}

export interface AudioRecorder {
  record(durationMs: number): Promise<RecordedChunk>
}

/** Legacy ffmpeg backend — keep for fallback, but the native backend is
 *  better on macOS multi-mic arrays (built-in MBP mic especially). */
export class FfmpegAudioRecorder implements AudioRecorder {
  private config: AudioRecorderConfig

  constructor(config: Partial<AudioRecorderConfig> = {}) {
    this.config = { ...DEFAULT_AUDIO_RECORDER_CONFIG, ...config }
  }

  /**
   * Record a single fixed-length chunk. Returns the WAV bytes.
   * Throws on ffmpeg failure (caller decides whether to retry / skip).
   */
  async record(durationMs: number): Promise<RecordedChunk> {
    if (durationMs <= 0) throw new Error('durationMs must be positive')
    const tempPath = join(this.config.tmpDir, `gtd-audio-${randomUUID()}.wav`)
    const seconds = (durationMs / 1000).toFixed(3)
    const args = this.buildArgs(tempPath, seconds)

    const start = Date.now()
    await this.runFfmpeg(args)
    const elapsed = Date.now() - start

    try {
      const data = await readFile(tempPath)
      return {
        data,
        tempPath,
        durationMs: elapsed,
        sampleRate: this.config.sampleRate,
      }
    } finally {
      // Best-effort cleanup; ignore "missing" because ffmpeg may have failed
      void unlink(tempPath).catch(() => {})
    }
  }

  /**
   * Build ffmpeg argv. Platform-specific input handling lives here.
   * macOS avfoundation: -f avfoundation -i ":default"
   * Linux pulseaudio:   -f pulse -i default       (TODO when needed)
   * Windows dshow:      -f dshow -i audio=...     (TODO when needed)
   */
  private buildArgs(outputPath: string, seconds: string): string[] {
    const isDarwin = process.platform === 'darwin'
    const inputFormat = isDarwin ? 'avfoundation' : 'pulse'
    const input = isDarwin ? this.config.inputDevice : 'default'

    // Wall-clock timestamps are critical: macOS avfoundation often reports
    // a sample rate (e.g. 96kHz) higher than the device actually delivers,
    // which makes ffmpeg compress the buffer (0.5x duration, 2x perceived
    // playback speed). `-use_wallclock_as_timestamps 1 -fflags +genpts`
    // forces ffmpeg to time samples by real elapsed time, and the
    // `aresample=async=1000` filter smooths any resulting drift.
    const filter = this.config.audioFilter
      ? `aresample=async=1000,${this.config.audioFilter}`
      : 'aresample=async=1000'

    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-use_wallclock_as_timestamps',
      '1',
      '-fflags',
      '+genpts',
      '-f',
      inputFormat,
      '-i',
      input,
      '-ac',
      '1', // mono — Whisper prefers mono
      '-ar',
      String(this.config.sampleRate),
      '-af',
      filter,
      '-t',
      seconds,
      '-y',
      outputPath,
    ]
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        reject(new Error(`ffmpeg spawn failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 500)}`))
        }
      })
    })
  }
}
