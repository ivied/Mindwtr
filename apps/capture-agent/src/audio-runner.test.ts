import { describe, it, expect, mock } from 'bun:test'
import { runAudioOnce, type AudioRunnerDeps } from './audio-runner'
import type { AudioRecorder } from './capture/audio-recorder'
import type { WhisperClient } from './capture/whisper'

/** Build a tiny WAV buffer with given int16 samples (header skipped by computeEnergy). */
function buildAudio(amplitudes: number[]): Buffer {
  const header = Buffer.alloc(44)
  const data = Buffer.alloc(amplitudes.length * 2)
  for (let i = 0; i < amplitudes.length; i++) data.writeInt16LE(amplitudes[i]!, i * 2)
  return Buffer.concat([header, data])
}

function deps(overrides: Partial<AudioRunnerDeps> = {}): AudioRunnerDeps {
  return {
    recorder: {
      record: async () => ({
        data: buildAudio([32767, -32768, 32767, -32768]),
        tempPath: '/tmp/x',
        durationMs: 30,
        sampleRate: 16000,
      }),
    } as unknown as AudioRecorder,
    whisper: {
      transcribe: async () => 'this is a transcript long enough',
    } as unknown as WhisperClient,
    window: null,
    rules: { excludedApps: [], excludedTitles: [] },
    pauseFlagPath: '',
    send: mock(async () => {}),
    log: () => {},
    ...overrides,
  }
}

describe('runAudioOnce', () => {
  it('captures, transcribes, and sends when audio is loud and transcript long enough', async () => {
    const send = mock(async () => {})
    const result = await runAudioOnce(deps({ send }))
    expect(result).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    const calls = (send as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls[0][0]).toBe('this is a transcript long enough')
  })

  it('returns "silent" and skips transcribe for low-energy chunk', async () => {
    const transcribe = mock(async () => 'should not be called')
    const result = await runAudioOnce(
      deps({
        recorder: {
          record: async () => ({
            data: buildAudio([0, 0, 0, 0]),
            tempPath: '/tmp/x',
            durationMs: 30,
            sampleRate: 16000,
          }),
        } as unknown as AudioRecorder,
        whisper: { transcribe } as unknown as WhisperClient,
      })
    )
    expect(result).toBe('silent')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('returns "short-transcript" when Whisper returns near-empty text', async () => {
    const send = mock(async () => {})
    const result = await runAudioOnce(
      deps({
        whisper: { transcribe: async () => 'a' } as unknown as WhisperClient,
        send,
      })
    )
    expect(result).toBe('short-transcript')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns "record-error" when recorder throws', async () => {
    const result = await runAudioOnce(
      deps({
        recorder: {
          record: async () => {
            throw new Error('mic busy')
          },
        } as unknown as AudioRecorder,
      })
    )
    expect(result).toBe('record-error')
  })

  it('returns "transcribe-error" when Whisper throws', async () => {
    const result = await runAudioOnce(
      deps({
        whisper: {
          transcribe: async () => {
            throw new Error('429 rate limit')
          },
        } as unknown as WhisperClient,
      })
    )
    expect(result).toBe('transcribe-error')
  })

  it('returns "send-error" when AI Service is down', async () => {
    const result = await runAudioOnce(
      deps({
        send: async () => {
          throw new Error('connection refused')
        },
      })
    )
    expect(result).toBe('send-error')
  })

  it('returns "paused" when pause flag exists', async () => {
    const tmp = `/tmp/gtd-test-pause-${Date.now()}-audio`
    await Bun.write(tmp, '')
    const send = mock(async () => {})
    const result = await runAudioOnce(deps({ send, pauseFlagPath: tmp }))
    expect(result).toBe('paused')
    expect(send).not.toHaveBeenCalled()
    await Bun.file(tmp).delete?.().catch(() => {})
  })
})
