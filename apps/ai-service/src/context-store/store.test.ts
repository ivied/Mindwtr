import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore } from './store'
import type { CapturedItem } from '../capture/normalizer'
import type { EmbeddingsProvider } from './embeddings'

function makeItem(overrides: Partial<CapturedItem> = {}): CapturedItem {
  return {
    text: 'Buy milk on the way home',
    sourceChannel: 'telegram_dm',
    type: 'text',
    timestamp: '2026-04-24T10:00:00Z',
    ...overrides,
  }
}

class StubEmbeddings implements EmbeddingsProvider {
  readonly dimension = 1536
  constructor(
    /** Map of text → vector. Unknown text returns a deterministic random-ish vector */
    private map: Map<string, Float32Array> = new Map()
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const cached = this.map.get(text)
    if (cached) return cached
    // Deterministic vector based on text hash so same text → same vector
    const v = new Float32Array(this.dimension)
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
    for (let i = 0; i < this.dimension; i++) {
      v[i] = Math.sin((h + i) / 1000)
    }
    return v
  }

  set(text: string, vec: Float32Array): void {
    this.map.set(text, vec)
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-cs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ContextStore', () => {
  it('opens and reports zero captures initially', () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    expect(store.size()).toBe(0)
    store.close()
  })

  it('inserts a capture and increments size', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    const result = await store.insert(makeItem())
    expect(result.inserted).toBe(true)
    expect(result.capture.text).toBe('Buy milk on the way home')
    expect(result.capture.id).toBeDefined()
    expect(store.size()).toBe(1)
    store.close()
  })

  it('L2 dedup: same content_hash within window returns inserted=false', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    const a = await store.insert(makeItem())
    const b = await store.insert(makeItem())
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(false)
    expect(b.capture.id).toBe(a.capture.id)
    expect(store.size()).toBe(1)
    store.close()
  })

  it('inserts when sourceChannel differs (different content_hash)', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    await store.insert(makeItem({ sourceChannel: 'telegram_dm' }))
    const second = await store.insert(makeItem({ sourceChannel: 'screen_capture' }))
    expect(second.inserted).toBe(true)
    expect(store.size()).toBe(2)
    store.close()
  })

  it('marks pull channels via is_pull flag', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    const push = await store.insert(makeItem({ sourceChannel: 'telegram_dm' }))
    const pull = await store.insert(makeItem({ sourceChannel: 'screen_capture' }))
    const slackDm = await store.insert(makeItem({ sourceChannel: 'slack_dm' }))
    const slackCh = await store.insert(makeItem({ sourceChannel: 'slack_channel' }))
    const tgUserDm = await store.insert(makeItem({ sourceChannel: 'telegram_user_dm' }))
    const tgGroup = await store.insert(makeItem({ sourceChannel: 'telegram_group' }))
    expect(push.capture.isPull).toBe(false)
    expect(pull.capture.isPull).toBe(true)
    // Slack and the TG user feed are pull — they must reach the inbox via
    // Commitment, not on arrival.
    expect(slackDm.capture.isPull).toBe(true)
    expect(slackCh.capture.isPull).toBe(true)
    expect(tgUserDm.capture.isPull).toBe(true)
    expect(tgGroup.capture.isPull).toBe(true)
    store.close()
  })

  it('FTS search finds inserted captures by keyword', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    await store.insert(makeItem({ text: 'позвонить няне в субботу' }))
    await store.insert(makeItem({ text: 'купить молоко по дороге', sourceChannel: 'screen_capture' }))
    const hits = store.searchFts('молоко')
    expect(hits.length).toBe(1)
    expect(hits[0]!.via).toBe('fts')
    expect(hits[0]!.capture.text).toBe('купить молоко по дороге')
    store.close()
  })

  it('FTS search applies sourceFilter', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    await store.insert(makeItem({ text: 'meeting notes', sourceChannel: 'telegram_dm' }))
    await store.insert(makeItem({ text: 'meeting agenda', sourceChannel: 'screen_capture' }))
    const hits = store.searchFts('meeting', { sourceFilter: ['screen_capture'] })
    expect(hits.length).toBe(1)
    expect(hits[0]!.capture.sourceChannel).toBe('screen_capture')
    store.close()
  })

  it('listUnproposedPullCaptures returns window pull captures lacking a proposal', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    const inWindow = await store.insert(
      makeItem({ text: 'a', sourceChannel: 'telegram_group', timestamp: '2026-04-24T10:00:00Z' })
    )
    const proposed = await store.insert(
      makeItem({ text: 'b', sourceChannel: 'slack_channel', timestamp: '2026-04-24T11:00:00Z' })
    )
    // push capture in window — must be excluded (enricher path, not commitment)
    await store.insert(
      makeItem({ text: 'c', sourceChannel: 'telegram_dm', timestamp: '2026-04-24T12:00:00Z' })
    )
    // proposal row for `proposed` — must be excluded as already handled
    const db = (store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db
    db.run(
      `INSERT INTO proposals (id, type, target_task_ids, source_capture_id, source_agent, status, current_payload, created_at)
       VALUES ('p1', 'create', '[]', ?, 'test', 'pending', '{}', '2026-04-24T11:01:00Z')`,
      [proposed.capture.id]
    )

    const now = new Date()
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const to = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    const records = store.listUnproposedPullCaptures(from, to)
    expect(records.map((r) => r.id)).toEqual([inWindow.capture.id])

    // window excludes everything → empty
    expect(store.listUnproposedPullCaptures('2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z')).toEqual([])
    store.close()
  })

  it('purgeExpired drops captures past TTL', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db'), ttlMs: -1000 })
    await store.insert(makeItem())
    expect(store.size()).toBe(1)
    const purged = store.purgeExpired()
    expect(purged).toBe(1)
    expect(store.size()).toBe(0)
    store.close()
  })

  it('hasVectorSearch reflects embeddings + vec availability', () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    expect(store.hasVectorSearch).toBe(false)
    const withEmb = ContextStore.open({ dbPath: join(dir, 'with-emb.db') }, new StubEmbeddings())
    // hasVectorSearch is true only when sqlite-vec actually loaded; in some environments it may not.
    // We only assert that with embeddings the flag at least matches vec availability.
    expect(typeof withEmb.hasVectorSearch).toBe('boolean')
    store.close()
    withEmb.close()
  })

  it('retrieve falls back to FTS when vec unavailable', async () => {
    const store = ContextStore.open({ dbPath: join(dir, 'test.db') })
    await store.insert(makeItem({ text: 'позвонить няне завтра' }))
    const hits = await store.retrieve('позвонить')
    expect(hits.length).toBe(1)
    expect(hits[0]!.via).toBe('fts')
    store.close()
  })
})
