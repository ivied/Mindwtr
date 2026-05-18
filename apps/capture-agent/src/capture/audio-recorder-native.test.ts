import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAudioRecorder } from './audio-recorder-native'

async function makeFakeBinary(body: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-helper-'))
  const path = join(dir, 'gtd-audio-capture')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return { dir, path }
}

describe('NativeAudioRecorder watchdog', () => {
  it('SIGKILLs and rejects when the helper hangs past the watchdog', async () => {
    // Helper that never exits — simulates a stuck mic after sleep/wake.
    const { dir, path } = await makeFakeBinary('sleep 999')
    try {
      const rec = new NativeAudioRecorder({ binaryPath: path, watchdogMs: 300 })
      const t0 = Date.now()
      await expect(rec.record(30_000)).rejects.toThrow(/watchdog/)
      // Should reject promptly at ~watchdogMs, not hang for the full sleep.
      expect(Date.now() - t0).toBeLessThan(3_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns normally when the helper exits before the watchdog', async () => {
    // Emit a few PCM bytes on stdout and exit 0.
    const { dir, path } = await makeFakeBinary('printf "abcd"; exit 0')
    try {
      const rec = new NativeAudioRecorder({ binaryPath: path, watchdogMs: 5_000 })
      const chunk = await rec.record(1_000)
      // WAV = 44-byte header + 4 payload bytes.
      expect(chunk.data.length).toBe(48)
      expect(chunk.sampleRate).toBe(16_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('derives a duration-based watchdog when watchdogMs = 0', async () => {
    // 2×duration + 15s slack → for 100ms duration that's ~15.2s; a helper
    // that exits immediately must still resolve well under that.
    const { dir, path } = await makeFakeBinary('printf "xy"; exit 0')
    try {
      const rec = new NativeAudioRecorder({ binaryPath: path, watchdogMs: 0 })
      const chunk = await rec.record(100)
      expect(chunk.data.length).toBe(44 + 2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
