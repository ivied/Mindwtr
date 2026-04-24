import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStateStore, channelStateFile } from './state-store'

describe('FileStateStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gtd-state-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when file missing', async () => {
    const store = new FileStateStore(channelStateFile(dir), 'notion')
    expect(await store.getLastSync()).toBeNull()
  })

  it('persists and reads a value', async () => {
    const store = new FileStateStore(channelStateFile(dir), 'notion')
    await store.setLastSync('2026-04-24T10:00:00Z')
    expect(await store.getLastSync()).toBe('2026-04-24T10:00:00Z')
  })

  it('isolates keys in the same file', async () => {
    const path = channelStateFile(dir)
    const a = new FileStateStore(path, 'notion')
    const b = new FileStateStore(path, 'slack')
    await a.setLastSync('2026-04-01T00:00:00Z')
    await b.setLastSync('2026-04-02T00:00:00Z')
    expect(await a.getLastSync()).toBe('2026-04-01T00:00:00Z')
    expect(await b.getLastSync()).toBe('2026-04-02T00:00:00Z')
  })

  it('creates missing parent directories on write', async () => {
    const deepPath = join(dir, 'nested', 'sub', 'state.json')
    const store = new FileStateStore(deepPath, 'k')
    await store.setLastSync('2026-04-24T10:00:00Z')
    expect(await store.getLastSync()).toBe('2026-04-24T10:00:00Z')
  })

  it('returns null for unknown key even if file has other keys', async () => {
    const path = channelStateFile(dir)
    const known = new FileStateStore(path, 'notion')
    await known.setLastSync('2026-04-01T00:00:00Z')
    const unknown = new FileStateStore(path, 'slack')
    expect(await unknown.getLastSync()).toBeNull()
  })
})
