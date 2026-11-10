import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../context-store/db'
import { MemoryStore } from './store'
import { TaskContextAssembler, entitiesInText, renderTaskContext, slugOf, type KnownEntity } from './task-context'

const HIQ: KnownEntity = { slug: 'hiq-fitness', name: 'HiQ Fitness', type: 'project', aliases: ['hiq', 'HighQFitness', 'HQF', 'хайкю'], mentionCount: 154 }
const GITHUB: KnownEntity = { slug: 'github', name: 'GitHub', type: 'technology', aliases: ['гит', 'PR', 'github.com/HighQFitness/HQF-android-ios/pull/1395'], mentionCount: 341 }
const NASTYA: KnownEntity = { slug: 'nastasya', name: 'Nastasya', type: 'person', aliases: ['Настя'], mentionCount: 40 }
const KNOWN = [HIQ, GITHUB, NASTYA]
const TASK = 'Инвойсы HiQ: сверить часы за октябрь и загрузить инвойс в Remote'
const NOW = new Date('2026-11-10T12:00:00Z')

let dbPath: string
let store: MemoryStore

beforeEach(() => {
  dbPath = join(tmpdir(), `task-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const { db, vecAvailable } = openDb(dbPath)
  store = new MemoryStore({ db, vecAvailable })
})
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
})

const inferred = (slug: string, statement: string, validFrom: string) => store.insertFact({ statement, entitySlug: slug, factType: 'status', validFrom })
const assembler = (searchEvents?: ConstructorParameters<typeof TaskContextAssembler>[0]['searchEvents']) =>
  new TaskContextAssembler({ store, entities: () => KNOWN, searchEvents, now: () => NOW })

describe('which entities a task is about', () => {
  it('finds a project by any of its spellings and ignores lookalikes inside other words', () => {
    expect(entitiesInText(TASK, KNOWN).map((e) => e.slug)).toEqual(['hiq-fitness'])
    expect(entitiesInText('написать Насте про хайкю', KNOWN).map((e) => e.slug)).toEqual(['hiq-fitness', 'nastasya'])
    // "PR" inside "PRoject" and a two-letter alias do not count; a generic tech term needs to be longer.
    expect(entitiesInText('Project review: открыть PR и гит', KNOWN)).toEqual([])
    expect(slugOf('HighQ Fitness')).toBe('highq-fitness')
  })
})

describe('what an agent run is told', () => {
  it('puts what the user confirmed first and keeps it apart from what was inferred', async () => {
    store.insertFact({ statement: 'Инвойсы HiQ выставляются через PayPal, в Remote они не загружаются', entitySlug: 'hiq-fitness', factType: 'rule', validFrom: '2026-11-10T10:00:00Z', origin: 'user' })
    store.insertFact({ statement: 'Платежи клиентам подтверждать у меня', entitySlug: null, factType: 'rule', validFrom: '2026-11-01T10:00:00Z', origin: 'user' })
    store.insertFact({ statement: 'Настя в отпуске до пятницы', entitySlug: 'nastasya', factType: 'rule', validFrom: '2026-11-09T10:00:00Z', origin: 'user' })
    // The same project filed under the slugs its aliases produced.
    inferred('hiq', 'Elizaveta сводит инвойс по HiQ за три недели', '2026-09-22T20:00:00Z')
    inferred('highqfitness', 'В репозитории HQF-android-ios открыт PR по BLE', '2026-11-08T09:00:00Z')
    inferred('hiq-fitness', 'The October invoice for the client is still unpaid', '2026-10-20T09:00:00Z')
    inferred('hiq-fitness', 'Дизайн экрана часов согласован', '2026-11-09T09:00:00Z')
    inferred('hiq-fitness', 'Регрессионное тестирование начато', '2026-11-07T09:00:00Z')
    inferred('hiq', 'Часы по HiQ за сентябрь внесены в трекер', '2026-03-01T09:00:00Z') // older than the window
    inferred('upwork', 'Отчёты Upwork собираются автоматически', '2026-11-09T09:00:00Z')

    const ctx = await assembler(async () => [
      { ts: '2026-11-10T13:51:00Z', source: 'screen', body: '[Google Chrome] @ File Edit View ¥ вЫ 2 т 8' },
      { ts: '2026-11-03T11:51:10Z', source: 'slack_channel', body: 'я спрошу\n в канале hiq' },
    ]).assemble(TASK)
    expect(ctx.entities.map((e) => e.slug)).toEqual(['hiq-fitness'])
    expect(ctx.confirmed.map((f) => f.statement)).toEqual(['Инвойсы HiQ выставляются через PayPal, в Remote они не загружаются'])
    expect(ctx.general.map((f) => f.statement)).toEqual(['Платежи клиентам подтверждать у меня'])
    // Facts about the subject of the task come first — across languages ("инвойс" finds "invoice") —
    // then just a couple of the latest unrelated ones; the stale one is gone.
    expect(ctx.inferred.map((f) => f.statement)).toEqual([
      'The October invoice for the client is still unpaid',
      'Elizaveta сводит инвойс по HiQ за три недели',
      'Дизайн экрана часов согласован',
      'В репозитории HQF-android-ios открыт PR по BLE',
    ])
    expect(ctx.events).toHaveLength(1) // the screen capture is dropped

    const block = renderTaskContext(ctx)
    expect(block.indexOf('Подтверждено пользователем')).toBeLessThan(block.indexOf('Выведено из переписки'))
    expect(block).toContain('- Инвойсы HiQ выставляются через PayPal, в Remote они не загружаются [hiq-fitness]')
    expect(block).toContain('(2026-11-03, slack_channel) я спрошу в канале hiq')
    expect(block).not.toContain('Настя в отпуске')
    expect(block).not.toContain('Upwork')
  })

  it('stays small however much memory holds about an entity', async () => {
    for (let i = 0; i < 300; i++) inferred('hiq-fitness', `Факт номер ${i} про разработку`, new Date(NOW.getTime() - i * 3600_000).toISOString())
    const ctx = await assembler().assemble(TASK)
    expect(ctx.inferred.length).toBeLessThanOrEqual(2) // nothing about invoices: only a taste of recent activity
  })

  it('finds a fact the user saved about something the registry has never heard of', async () => {
    store.insertFact({ statement: 'Счета Limerick оплачиваются через Wise', entitySlug: 'limerick', factType: 'rule', validFrom: '2026-11-10T10:00:00Z', origin: 'user' })
    const ctx = await assembler().assemble('Оплатить счёт Limerick')
    expect(ctx.confirmed.map((f) => f.statement)).toEqual(['Счета Limerick оплачиваются через Wise'])
  })

  it('says nothing when there is nothing, and survives a failing search', async () => {
    const ctx = await assembler(async () => {
      throw new Error('embeddings down')
    }).assemble('Купить молоко')
    expect(renderTaskContext(ctx)).toBe('')
  })
})

describe('facts the user confirmed are not touched by the automatic pipeline', () => {
  it('keeps them when the entity is expired or a newer inferred fact supersedes the group', () => {
    const mine = store.insertFact({ statement: 'HiQ платит через PayPal', entitySlug: 'hiq-fitness', factType: 'status', validFrom: '2026-11-01T00:00:00Z', origin: 'user' })
    inferred('hiq-fitness', 'HiQ ждёт инвойс', '2026-11-02T00:00:00Z')
    store.insertFact({ statement: 'HiQ инвойс отправлен', entitySlug: 'hiq-fitness', factType: 'status', validFrom: '2026-11-03T00:00:00Z' }, true)
    expect(store.expireFactsForEntity('hiq-fitness', '2026-11-04T00:00:00Z')).toBe(1)
    expect(store.allVerifiedFacts().map((f) => f.id)).toEqual([mine.id])
    // Only the user can retire it.
    expect(store.closeFact(mine.id, '2026-11-05T00:00:00Z')).toBe(true)
    expect(store.allVerifiedFacts()).toEqual([])
    expect(store.closeFact(mine.id, '2026-11-05T00:00:00Z')).toBe(false)
  })
})
