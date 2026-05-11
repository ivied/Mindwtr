/**
 * Native audio recorder — spawns the Swift `gtd-audio-capture` helper that
 * uses AVAudioEngine to pull all mic channels, manually averages to mono,
 * resamples to 16 kHz Int16 PCM, and streams to stdout.
 *
 * Why this beats the ffmpeg backend on macOS:
 *   - macOS exposes the built-in MBP mic as a multi-channel array (7-9
 *     channels of beam-forming taps). ffmpeg → avfoundation grabs one
 *     channel — noisy and quiet. The Swift helper averages all channels,
 *     which acts as a poor-man's beam-form and dramatically cleans up the
 *     signal on the built-in mic.
 *   - AVAudioConverter handles 1→1 channel resampling cleanly (it silently
 *     produces zeros when reducing channels from a deinterleaved source,
 *     hence the manual downmix in the Swift code).
 *
 * The helper also enables AVAudio's VoiceProcessingIO (noise suppression /
 * AGC / echo cancellation), but VP only fully engages on signed binaries
 * with the audio-input entitlement. Unsigned, it's a no-op — the manual
 * downmix is what's doing the work today.
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink, access } from 'node:fs/promises'
import { wrapPcmAsWav } from './wav-wrap'
import type { AudioRecorder, RecordedChunk } from './audio-recorder'

export interface NativeAudioRecorderConfig {
  /** Absolute path to the compiled gtd-audio-capture binary. */
  binaryPath: string
  /** Working dir for the temp WAV that we write before reading back. */
  tmpDir: string
  /** Skip AVAudio VoiceProcessing setup (debug / fallback). */
  noVoiceProcessing: boolean
  /** Always 16000 here — Whisper-friendly. Exposed for future flex. */
  sampleRate: number
}

export const DEFAULT_NATIVE_RECORDER_CONFIG: NativeAudioRecorderConfig = {
  binaryPath: 'gtd-audio-capture',
  tmpDir: tmpdir(),
  noVoiceProcessing: false,
  sampleRate: 16_000,
}

export class NativeAudioRecorder implements AudioRecorder {
  private config: NativeAudioRecorderConfig

  constructor(config: Partial<NativeAudioRecorderConfig> = {}) {
    this.config = { ...DEFAULT_NATIVE_RECORDER_CONFIG, ...config }
  }

  /**
   * Check the helper binary exists & is executable. Call this at startup
   * so we fail loudly instead of on the first record() call.
   */
  async ensureAvailable(): Promise<void> {
    try {
      await access(this.config.binaryPath)
    } catch {
      throw new Error(
        `native audio helper not found at ${this.config.binaryPath} — run audio-helper/build.sh`
      )
    }
  }

  async record(durationMs: number): Promise<RecordedChunk> {
    if (durationMs <= 0) throw new Error('durationMs must be positive')
    const seconds = (durationMs / 1000).toFixed(3)
    const args = ['--duration', seconds]
    if (this.config.noVoiceProcessing) args.push('--no-vp')

    const start = Date.now()
    const pcm = await this.runHelper(args)
    const elapsed = Date.now() - start

    const wav = wrapPcmAsWav(pcm, {
      sampleRate: this.config.sampleRate,
      channels: 1,
      bitsPerSample: 16,
    })

    // Keep API parity with ffmpeg backend: temp WAV file path returned,
    // already cleaned up. Whisper consumes chunk.data directly so this is
    // belt-and-suspenders.
    const tempPath = join(this.config.tmpDir, `gtd-audio-${randomUUID()}.wav`)
    try {
      await writeFile(tempPath, wav)
    } catch {
      // Non-fatal: in-memory data is what callers actually use.
    }
    void unlink(tempPath).catch(() => {})

    return {
      data: wav,
      tempPath,
      durationMs: elapsed,
      sampleRate: this.config.sampleRate,
    }
  }

  private runHelper(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        reject(new Error(`native helper spawn failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks))
        } else {
          reject(
            new Error(
              `native helper exit ${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`
            )
          )
        }
      })
    })
  }
}
