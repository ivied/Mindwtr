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
import { writeFile, readFile, unlink, access } from 'node:fs/promises'
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
  /**
   * Watchdog: hard ceiling (ms) on a single record() before we SIGKILL the
   * helper and reject. macOS sleep/wake or a dead Continuity mic can leave
   * the helper hung forever waiting on samples; this lets the audio loop
   * fail fast and retry instead of silently stalling for hours.
   * 0 = derive as 2× the requested duration + 15 s slack.
   */
  watchdogMs: number
  /**
   * When set, invoke the helper via `open -W -a <bundlePath> --args` so
   * macOS routes through LaunchServices and attributes TCC mic permission
   * to the bundle ID instead of the parent process. Required for
   * launchd-spawned reliability — direct exec of the bundle binary
   * silently fails the mic grant even when the user has explicitly
   * approved the bundle in Privacy & Security.
   *
   * `open` does not pipe stdout, so in this mode the helper writes a
   * WAV file at `--output <path>` and we read it back after open exits.
   *
   * Empty string disables: falls back to direct exec of binaryPath
   * (stdout PCM, fine in Terminal contexts).
   */
  bundlePath: string
}

export const DEFAULT_NATIVE_RECORDER_CONFIG: NativeAudioRecorderConfig = {
  binaryPath: 'gtd-audio-capture',
  tmpDir: tmpdir(),
  noVoiceProcessing: false,
  sampleRate: 16_000,
  watchdogMs: 0,
  bundlePath: '',
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
    const watchdogMs =
      this.config.watchdogMs > 0 ? this.config.watchdogMs : durationMs * 2 + 15_000

    const start = Date.now()
    let wav: Buffer
    let tempPath: string

    if (this.config.bundlePath) {
      // LaunchServices route — required so macOS attributes TCC to the
      // bundle ID (works under launchd). The helper writes a complete
      // WAV file; we read it back after `open -W` returns.
      tempPath = join(this.config.tmpDir, `gtd-audio-${randomUUID()}.wav`)
      const openArgs = [
        '-W',
        '-n',
        '-g',
        '-a',
        this.config.bundlePath,
        '--args',
        '--duration',
        seconds,
        '--output',
        tempPath,
      ]
      if (this.config.noVoiceProcessing) openArgs.push('--no-vp')
      await this.runOpen(openArgs, watchdogMs)
      try {
        wav = await readFile(tempPath)
      } catch (err) {
        throw new Error(
          `native helper produced no WAV at ${tempPath}: ${(err as Error).message}`
        )
      }
    } else {
      // Direct-exec fallback — Terminal smoke tests, etc.
      const args = ['--duration', seconds]
      if (this.config.noVoiceProcessing) args.push('--no-vp')
      const pcm = await this.runHelper(args, watchdogMs)
      wav = wrapPcmAsWav(pcm, {
        sampleRate: this.config.sampleRate,
        channels: 1,
        bitsPerSample: 16,
      })
      tempPath = join(this.config.tmpDir, `gtd-audio-${randomUUID()}.wav`)
      try {
        await writeFile(tempPath, wav)
      } catch {
        // Non-fatal: in-memory data is what callers actually use.
      }
    }

    const elapsed = Date.now() - start
    return {
      data: wav,
      tempPath,
      durationMs: elapsed,
      sampleRate: this.config.sampleRate,
    }
  }

  private runOpen(args: string[], watchdogMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      let settled = false
      const watchdog = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill('SIGKILL') } catch {}
        // `open` returning doesn't kill the launched bundle process;
        // hammer any leftover GTDAudioCapture instances so we don't
        // accumulate ghosts across watchdog firings.
        try { spawn('/usr/bin/pkill', ['-KILL', '-f', 'GTDAudioCapture.app']) } catch {}
        reject(
          new Error(
            `native helper watchdog (open route): no exit within ${watchdogMs}ms — killed`
          )
        )
      }, watchdogMs)
      child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        reject(new Error(`open spawn failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        if (code === 0) resolve()
        else reject(new Error(`open exit ${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`))
      })
    })
  }

  private runHelper(args: string[], watchdogMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      let stderr = ''
      let settled = false

      const watchdog = setTimeout(() => {
        if (settled) return
        settled = true
        // Helper is hung (mic gone after sleep/wake, Continuity dropped,
        // etc.). Hard-kill so the audio loop's retry/backoff kicks in.
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
        reject(
          new Error(
            `native helper watchdog: no exit within ${watchdogMs}ms — killed (likely stuck mic)`
          )
        )
      }, watchdogMs)

      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        reject(new Error(`native helper spawn failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
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
