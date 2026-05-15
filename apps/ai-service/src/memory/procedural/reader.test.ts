import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../context-store/db'
import { ProceduralStore } from './store'
import { ProceduralReader } from './reader'

let dataDir: string
let memDir: string
let store: ProceduralStore
let dbHandle: ReturnType<typeof openDb>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gtd-proc-data-'))
  memDir = mkdtempSync(join(tmpdir(), 'gtd-proc-mem-'))
  dbHandle = openDb(join(dataDir, 'test.db'))
  store = new ProceduralStore({ db: dbHandle.db, vecAvailable: dbHandle.vecAvailable })
})

afterEach(() => {
  dbHandle.db.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(memDir, { recursive: true, force: true })
})

function writeFile(rel: string, content: string, mtime?: Date): string {
  const abs = join(memDir, rel)
  mkdirSync(join(memDir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  if (mtime) utimesSync(abs, mtime, mtime)
  return abs
}

describe('ProceduralReader', () => {
  it('chunks a MEMORY.md file and persists each section as a row', async () => {
    mkdirSync(join(memDir, 'openclaw'))
    writeFile('openclaw/MEMORY.md', `# MEMORY

## Slack
- ⚠️ ВСЕГДА reply_to_current для ответа в тред.

## Notion
- Каждую задачу — сразу в Notion, даже мелкую.

## DM каналы
- D09RU9JDATY — переписка с Настей, НЕ вмешиваться.
`)
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      log: () => {},
    })
    const stats = await reader.scanOnce()
    expect(stats.upserted).toBe(3)
    expect(store.countChunks()).toBe(3)
  })

  it('is idempotent — re-scanning an unchanged dir does not upsert again', async () => {
    mkdirSync(join(memDir, 'openclaw'))
    writeFile('openclaw/MEMORY.md', `## A\nlong enough body content to clear the minimum threshold\n`)
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      log: () => {},
    })
    const first = await reader.scanOnce()
    expect(first.upserted).toBe(1)
    const second = await reader.scanOnce()
    expect(second.upserted).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(store.countChunks()).toBe(1)
  })

  it('removes rows for sections that disappear from the file', async () => {
    mkdirSync(join(memDir, 'openclaw'))
    writeFile(
      'openclaw/MEMORY.md',
      `## A\nbody A long enough to clear minimum threshold\n\n## B\nbody B long enough to clear minimum threshold\n\n## C\nbody C long enough to clear minimum threshold\n`
    )
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      log: () => {},
    })
    await reader.scanOnce()
    expect(store.countChunks()).toBe(3)

    // Rewrite — drop sections B and C.
    writeFile('openclaw/MEMORY.md', `## A\nbody A long enough to clear minimum threshold\n`)
    await reader.scanOnce()
    expect(store.countChunks()).toBe(1)
  })

  it('removes rows for files that vanish from disk', async () => {
    mkdirSync(join(memDir, 'openclaw'))
    writeFile('openclaw/MEMORY.md', `## A\nbody long enough to keep around\n`)
    writeFile('openclaw/EXTRA.md', `## B\nbody long enough to keep around\n`)
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      log: () => {},
    })
    await reader.scanOnce()
    expect(store.countChunks()).toBe(2)

    rmSync(join(memDir, 'openclaw/EXTRA.md'))
    const stats = await reader.scanOnce()
    expect(stats.removed).toBe(1)
    expect(store.countChunks()).toBe(1)
  })

  it('default pathFilter ignores nested subdirs (journals/)', async () => {
    mkdirSync(join(memDir, 'openclaw/journals'), { recursive: true })
    writeFile('openclaw/MEMORY.md', `## A\nlong body content here that goes beyond thirty chars that goes beyond thirty chars\n`)
    writeFile('openclaw/journals/2026-05-14.md', `## J\nlong journal body\n`)
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      log: () => {},
    })
    await reader.scanOnce()
    expect(store.countChunks()).toBe(1) // only MEMORY.md
  })

  it('pathFilter widens to journals when overridden', async () => {
    mkdirSync(join(memDir, 'openclaw/journals'), { recursive: true })
    writeFile('openclaw/MEMORY.md', `## A\nlong body content here that goes beyond thirty chars that goes beyond thirty chars\n`)
    writeFile('openclaw/journals/2026-05-14.md', `## J\nlong journal body content with more than thirty chars\n`)
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      pathFilter: () => true,
      log: () => {},
    })
    await reader.scanOnce()
    expect(store.countChunks()).toBe(2)
  })

  it('silently skips a missing source dir (does not crash)', async () => {
    const reader = new ProceduralReader({
      store,
      rootDir: memDir,
      sources: [{ subdir: 'nonexistent', source: 'openclaw' }],
      log: () => {},
    })
    const stats = await reader.scanOnce()
    expect(stats.scanned).toBe(0)
    expect(stats.errors).toBe(0)
  })
})
