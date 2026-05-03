import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPaused } from './pause'

describe('isPaused', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gtd-pause-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns true when flag file exists', async () => {
    const flag = join(dir, 'paused')
    await writeFile(flag, '')
    expect(await isPaused(flag)).toBe(true)
  })

  it('returns false when flag file is missing', async () => {
    expect(await isPaused(join(dir, 'missing'))).toBe(false)
  })

  it('returns false when path is empty (feature disabled)', async () => {
    expect(await isPaused('')).toBe(false)
  })
})
