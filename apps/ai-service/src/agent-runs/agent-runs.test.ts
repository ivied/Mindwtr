import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { AgentRunStore } from './store'
import { buildTaskPatch, mountAgentRunsRoutes, sanitizeChanges, type AgentRunsMindwtr } from './routes'
import type { Task } from '../api/mindwtr-client'

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Продлить домен',
    status: 'inbox',
    contexts: [],
    tags: ['old'],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  }
}

let clock: Date
let store: AgentRunStore
const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

beforeEach(() => {
  clock = new Date('2026-11-09T12:00:00Z')
  store = new AgentRunStore(new Database(':memory:'), () => clock)
})

describe('AgentRunStore', () => {
  it('enqueue is idempotent per task until the run is closed', () => {
    const a = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    const b = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.run.id).toBe(a.run.id)
    store.close(a.run.id)
    expect(store.enqueue({ taskId: 't1', taskTitle: 'A' }).created).toBe(true)
  })

  it('claim respects capacity and marks runs running', () => {
    store.enqueue({ taskId: 't1', taskTitle: 'A' })
    tick(10)
    store.enqueue({ taskId: 't2', taskTitle: 'B' })
    const claimed = store.claim('mac', 1)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.run.taskId).toBe('t1')
    expect(claimed[0]!.run.state).toBe('running')
    expect(claimed[0]!.reply).toBeNull()
    expect(store.claim('mac', 0)).toHaveLength(0)
    expect(store.lastRunnerSeenAt()).toBe(clock.toISOString())
  })

  it('question → answer re-queues with the reply and resumes before fresh runs', () => {
    const { run } = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    store.claim('mac', 1)
    tick(5000)
    const parked = store.finish(run.id, {
      state: 'question',
      pending: { kind: 'question', question: 'На сколько лет?', options: ['1', '3'] },
      sessionId: 'sess-1',
      costUsd: 0.2,
    })!
    expect(parked.state).toBe('question')
    expect(parked.durationMs).toBe(5000)
    expect(parked.pending).toEqual({ kind: 'question', question: 'На сколько лет?', options: ['1', '3'] })

    tick(10)
    store.enqueue({ taskId: 't2', taskTitle: 'fresh' })
    tick(10)
    expect(store.reply(run.id, { kind: 'answer', text: '3 года' })!.state).toBe('queued')

    const claimed = store.claim('mac', 1)
    expect(claimed[0]!.run.id).toBe(run.id)
    expect(claimed[0]!.run.sessionId).toBe('sess-1')
    expect(claimed[0]!.run.pending).toBeNull()
    expect(claimed[0]!.reply).toEqual({ kind: 'answer', text: '3 года' })
    expect(store.listEvents(run.id).map((e) => [e.kind, e.payload.text])).toEqual([['user', '3 года']])
  })

  it('holds back fresh runs when the budget is exhausted but still resumes', () => {
    const a = store.enqueue({ taskId: 't1', taskTitle: 'A' }).run
    store.claim('mac', 1)
    store.finish(a.id, { state: 'done', sessionId: 's', result: { summary: 'ok', evidence: [], changes: {} } })
    store.reply(a.id, { kind: 'message', text: 'доделай' })
    store.enqueue({ taskId: 't2', taskTitle: 'fresh' })
    const claimed = store.claim('mac', 5, false)
    expect(claimed.map((c) => c.run.id)).toEqual([a.id])
  })

  it('delivers mid-turn messages and stop through the heartbeat, once', () => {
    const { run } = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    store.claim('mac', 1)
    store.reply(run.id, { kind: 'message', text: 'проверь ещё Slack' })
    store.requestStop(run.id)
    const hb = store.heartbeat(run.id, { sessionId: 'sess-9', costUsd: 0.5 })
    expect(hb).toEqual({ stop: true, messages: [{ kind: 'message', text: 'проверь ещё Slack' }] })
    expect(store.heartbeat(run.id).messages).toEqual([])
    const r = store.get(run.id)!
    expect(r.sessionId).toBe('sess-9')
    expect(r.costUsd).toBe(0.5)
  })

  it('cost never goes down and a late finish cannot overwrite a parked run', () => {
    const { run } = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    store.claim('mac', 1)
    store.heartbeat(run.id, { costUsd: 0.7 })
    store.finish(run.id, { state: 'stopped', costUsd: 0.4 })
    expect(store.get(run.id)!.costUsd).toBe(0.7)
    store.finish(run.id, { state: 'done' })
    expect(store.get(run.id)!.state).toBe('stopped')
    expect(store.heartbeat(run.id).stop).toBe(true)
  })

  it('counts only visible steps and numbers events per run', () => {
    const { run } = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    store.appendEvents(run.id, [
      { kind: 'say', payload: { text: 'смотрю' } },
      { kind: 'tool', payload: { toolUseId: 'x', tool: 'Shell', call: 'ls' } },
      { kind: 'tool_result', payload: { toolUseId: 'x', output: 'a' } },
    ])
    store.appendEvents(run.id, [{ kind: 'done', payload: { text: 'готово' } }])
    expect(store.get(run.id)!.stepCount).toBe(3)
    expect(store.listEvents(run.id).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(store.listEvents(run.id, 3).map((e) => e.kind)).toEqual(['done'])
  })

  it('reaps runs whose runner went silent, keeping them resumable', () => {
    const { run } = store.enqueue({ taskId: 't1', taskTitle: 'A' })
    store.claim('mac', 1)
    store.heartbeat(run.id, { sessionId: 'sess-1' })
    tick(60_000)
    expect(store.reapStale(180_000)).toEqual([])
    tick(200_000)
    expect(store.reapStale(180_000)).toEqual([run.id])
    const r = store.get(run.id)!
    expect(r.state).toBe('stopped')
    expect(r.sessionId).toBe('sess-1')
    expect(store.reply(run.id, { kind: 'resume', text: '' })!.state).toBe('queued')
  })

  it('brings a reaped run back when its runner reconnects, and still accepts its result', () => {
    const a = store.enqueue({ taskId: 't1', taskTitle: 'A' }).run
    const b = store.enqueue({ taskId: 't2', taskTitle: 'B' }).run
    const c = store.enqueue({ taskId: 't3', taskTitle: 'C' }).run
    store.claim('mac', 3)
    tick(200_000) // the server was unreachable for longer than the reaper allows
    expect(store.reapStale(180_000).sort()).toEqual([a.id, b.id, c.id].sort())

    // The turn is still alive on the host: its next heartbeat revives the run.
    expect(store.heartbeat(a.id, { sessionId: 's-a' }).stop).toBe(false)
    expect(store.get(a.id)!.state).toBe('running')
    expect(store.get(a.id)!.error).toBeNull()

    // A turn that ended meanwhile reports its result straight away.
    const done = store.finish(b.id, { state: 'done', result: { summary: 'готово', evidence: [], changes: {} }, costUsd: 0.4 })!
    expect(done.state).toBe('done')
    expect(done.result?.summary).toBe('готово')

    // Once the user took the run over, the old turn is told to stop.
    store.reply(c.id, { kind: 'resume', text: '' })
    expect(store.heartbeat(c.id).stop).toBe(true)
    expect(store.get(c.id)!.state).toBe('queued')
  })
})

describe('result → task patch', () => {
  it('drops unknown statuses and empty fields', () => {
    expect(sanitizeChanges({ status: 'archived', title: '  ', contexts: ['@покупки', 7], addTags: [] })).toEqual({
      contexts: ['@покупки'],
    })
  })

  it('merges tags, appends the report and completes instead of setting status=done', () => {
    const { patch, complete } = buildTaskPatch(
      { tags: ['old'], description: 'было' },
      {
        summary: 'Домен продлён',
        evidence: ['счёт оплачен'],
        changes: { status: 'done', addTags: ['old', 'домен'], descriptionAppend: 'до 2027' },
      },
      'p1'
    )
    expect(complete).toBe(true)
    expect(patch.status).toBeUndefined()
    expect(patch.tags).toEqual(['old', 'домен'])
    expect(patch.projectId).toBe('p1')
    expect(patch.description).toBe('было\n\n## Результат агента\nДомен продлён\n\n- счёт оплачен\n\nдо 2027')
  })
})

describe('routes', () => {
  let app: Hono
  let mindwtr: AgentRunsMindwtr
  const post = (path: string, body: unknown = {}) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  beforeEach(() => {
    mindwtr = {
      getTask: mock(async (id: string) => taskOf({ id })),
      listTasks: mock(async () => [taskOf({ id: 'a' }), taskOf({ id: 'b', title: 'Другая' })]),
      updateTask: mock(async (id: string) => taskOf({ id })),
      completeTask: mock(async (id: string) => taskOf({ id })),
      search: mock(async () => ({ tasks: [], projects: [{ id: 'p7', title: 'Инфра' }] })),
    }
    app = new Hono()
    mountAgentRunsRoutes(app, { store, mindwtr, dailyBudgetUsd: 1, now: () => clock, log: () => {} })
  })

  it('enqueues the whole inbox once', async () => {
    const first = (await (await post('/v1/agent-runs', { inbox: true })).json()) as { enqueued: number }
    const again = (await (await post('/v1/agent-runs', { inbox: true })).json()) as { enqueued: number }
    expect(first.enqueued).toBe(2)
    expect(again.enqueued).toBe(0)
    const list = (await (await app.request('/v1/agent-runs')).json()) as { items: unknown[]; dailyBudgetUsd: number }
    expect(list.items).toHaveLength(2)
    expect(list.dailyBudgetUsd).toBe(1)
  })

  it('runs the full loop: claim → events → confirm → approve → done → accept', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const claim = (await (await post('/v1/agent-runs/claim', { runner: 'mac', capacity: 2 })).json()) as {
      items: Array<{ run: { id: string } }>
    }
    const id = claim.items[0]!.run.id

    const hb = (await (
      await post(`/v1/agent-runs/${id}/events`, {
        events: [{ kind: 'say', payload: { text: 'ищу' } }, { kind: 'bogus', payload: {} }],
        sessionId: 'sess-1',
        costUsd: 0.1,
      })
    ).json()) as { stop: boolean }
    expect(hb.stop).toBe(false)

    expect((await post(`/v1/agent-runs/${id}/finish`, { state: 'confirm' })).status).toBe(400)
    await post(`/v1/agent-runs/${id}/finish`, {
      state: 'confirm',
      pending: { kind: 'confirm', action: 'Отправить в Slack', target: '#deals', draft: 'текст' },
      sessionId: 'sess-1',
    })
    expect((await post(`/v1/agent-runs/${id}/reply`, { kind: 'nope' })).status).toBe(400)
    await post(`/v1/agent-runs/${id}/reply`, { kind: 'approve', text: '' })

    const again = (await (await post('/v1/agent-runs/claim', { runner: 'mac', capacity: 2 })).json()) as {
      items: Array<{ run: { id: string; sessionId: string }; reply: { kind: string } }>
    }
    expect(again.items[0]!.run.sessionId).toBe('sess-1')
    expect(again.items[0]!.reply.kind).toBe('approve')

    await post(`/v1/agent-runs/${id}/finish`, {
      state: 'done',
      result: { summary: 'Отправил', evidence: ['доставлено'], changes: { status: 'waiting', project: 'инфра' } },
      costUsd: 0.4,
    })
    const detail = (await (await app.request(`/v1/agent-runs/${id}?since=0`)).json()) as {
      run: { state: string; costUsd: number }
      events: Array<{ kind: string }>
    }
    expect(detail.run.state).toBe('done')
    expect(detail.run.costUsd).toBe(0.4)
    expect(detail.events.map((e) => e.kind)).toEqual(['say'])

    const acc = (await (await post(`/v1/agent-runs/${id}/accept`)).json()) as { applied: boolean; run: { state: string } }
    expect(acc.applied).toBe(true)
    expect(acc.run.state).toBe('closed')
    const patch = (mindwtr.updateTask as ReturnType<typeof mock>).mock.calls[0]![1] as Record<string, unknown>
    expect(patch.status).toBe('waiting')
    expect(patch.projectId).toBe('p7')
    expect(mindwtr.completeTask).not.toHaveBeenCalled()
  })

  it('refuses to accept a run that is still working', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const id = store.list()[0]!.id
    expect((await post(`/v1/agent-runs/${id}/accept`)).status).toBe(409)
  })

  it('stops handing out fresh runs once the daily budget is spent', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const id = store.list()[0]!.id
    store.claim('mac', 1)
    store.finish(id, { state: 'done', costUsd: 1.5 })
    await post('/v1/agent-runs', { taskId: 't2' })
    const res = (await (await post('/v1/agent-runs/claim', { runner: 'mac', capacity: 2 })).json()) as {
      items: unknown[]
      overBudget: boolean
    }
    expect(res.overBudget).toBe(true)
    expect(res.items).toHaveLength(0)
  })

  it('holds fresh runs once agents used the daily share of the weekly quota, until the next day', async () => {
    const quotaApp = new Hono()
    mountAgentRunsRoutes(quotaApp, { store, mindwtr, dailyBudgetUsd: 0, dailyQuotaPct: 10, now: () => clock, log: () => {} })
    const send = (path: string, body: unknown = {}) =>
      quotaApp.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const claim = async () =>
      (await (await send('/v1/agent-runs/claim', { runner: 'mac', capacity: 1 })).json()) as { items: { run: { id: string } }[]; overBudget: boolean }
    const meter = async () =>
      (await (await quotaApp.request('/v1/agent-runs')).json()) as { quotaTodayPct: number; dailyQuotaPct: number; hold: string | null }

    await send('/v1/agent-runs', { taskId: 't1' })
    const first = (await claim()).items[0]!.run.id
    await send(`/v1/agent-runs/${first}/finish`, { state: 'done', result: { summary: 'ок' }, quotaPct: 6 })
    expect(await meter()).toMatchObject({ quotaTodayPct: 6, dailyQuotaPct: 10, hold: null })

    await send('/v1/agent-runs', { taskId: 't2' })
    const second = (await claim()).items[0]!.run.id
    await send(`/v1/agent-runs/${second}/finish`, { state: 'question', pending: { kind: 'question', question: 'Какой?' }, sessionId: 's2', quotaPct: 5 })
    expect(await meter()).toMatchObject({ quotaTodayPct: 11, hold: 'quota' })

    // A fresh run waits, but an answer to a started one still goes through.
    await send('/v1/agent-runs', { taskId: 't3' })
    expect((await claim()).items).toHaveLength(0)
    await send(`/v1/agent-runs/${second}/reply`, { kind: 'answer', text: 'первый' })
    const resumed = await claim()
    expect(resumed.overBudget).toBe(true)
    expect(resumed.items.map((x) => x.run.id)).toEqual([second])

    clock = new Date(clock.getTime() + 24 * 3600_000)
    expect(await meter()).toMatchObject({ quotaTodayPct: 0, hold: null })
  })

  it('keeps screenshots attached to a reply and hands their ids to the runner', async () => {
    await post('/v1/agent-runs', { taskId: 't1' })
    const id = store.list()[0]!.id
    store.claim('mac', 1)
    store.finish(id, { state: 'question', pending: { kind: 'question', question: 'Что на экране?', options: [] }, sessionId: 's1', costUsd: 0 })

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')
    expect((await post(`/v1/agent-runs/${id}/reply`, { kind: 'answer', text: '', images: [{ name: 'x.svg', mime: 'image/svg+xml', data: png }] })).status).toBe(400)
    expect((await post(`/v1/agent-runs/${id}/reply`, { kind: 'answer', text: '' })).status).toBe(400)
    // An image alone is a valid answer.
    const ok = await post(`/v1/agent-runs/${id}/reply`, { kind: 'answer', text: '', images: [{ name: 'Снимок экрана.png', mime: 'image/png', data: png }] })
    expect(ok.status).toBe(200)

    const claimed = store.claim('mac', 1)[0]!
    expect(claimed.reply?.images).toHaveLength(1)
    const ref = claimed.reply!.images![0]!
    expect(ref).toMatchObject({ name: 'Снимок экрана.png', mime: 'image/png' })

    const res = await app.request(`/v1/agent-runs/${id}/attachments/${ref.id}`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    expect((await app.request(`/v1/agent-runs/other/attachments/${ref.id}`)).status).toBe(404)

    const detail = (await (await app.request(`/v1/agent-runs/${id}`)).json()) as { events: { kind: string; payload: { images?: unknown[] } }[] }
    expect(detail.events.find((e) => e.kind === 'user')?.payload.images).toHaveLength(1)
  })

  it('starts a task run with what memory knows and keeps what the user confirmed', async () => {
    const saved: Array<{ id: number; statement: string; entity: string | null; createdAt: string }> = []
    const asked: string[] = []
    const memApp = new Hono()
    mountAgentRunsRoutes(memApp, {
      store,
      mindwtr,
      dailyBudgetUsd: 0,
      now: () => clock,
      log: () => {},
      memory: {
        taskContext: async (text) => {
          asked.push(text)
          return '# Что известно из памяти\n- Инвойсы HiQ идут через PayPal'
        },
        list: () => saved,
        save: (statement, entity) => {
          const item = { id: saved.length + 1, statement, entity: entity || null, createdAt: clock.toISOString() }
          saved.push(item)
          return item
        },
        remove: (id) => {
          const at = saved.findIndex((x) => x.id === id)
          if (at < 0) return false
          saved.splice(at, 1)
          return true
        },
      },
    })
    const send = (path: string, body: unknown = {}, method = 'POST') =>
      memApp.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    const claim = async () =>
      (await (await send('/v1/agent-runs/claim', { runner: 'mac', capacity: 1 })).json()) as { items: Array<{ run: { id: string }; context?: string }> }

    await send('/v1/agent-runs', { taskId: 't1' })
    const first = (await claim()).items[0]!
    expect(first.context).toContain('Инвойсы HiQ идут через PayPal')
    expect(asked[0]).toContain('Продлить домен') // built from the task's own text

    // The agent asks; a resumed turn already carries the context in its session.
    await send(`/v1/agent-runs/${first.run.id}/finish`, { state: 'question', pending: { kind: 'question', question: 'Куда?' }, sessionId: 's1' })
    await send(`/v1/agent-runs/${first.run.id}/reply`, { kind: 'answer', text: 'В PayPal' })
    expect((await claim()).items[0]!.context).toBeUndefined()

    await send(`/v1/agent-runs/${first.run.id}/finish`, {
      state: 'done',
      result: {
        summary: 'Готово',
        lessons: [
          { statement: 'Инвойсы HiQ выставляются через PayPal', entity: 'HiQ' },
          { statement: 'Домены продлеваем на год', entity: '' },
          { statement: 'коротко' }, // too short to be a fact
        ],
      },
    })
    const done = store.get(first.run.id)!
    expect(done.result?.lessons).toHaveLength(2)

    // The user unticked the second one before accepting.
    const accepted = (await (await send(`/v1/agent-runs/${first.run.id}/accept`, { apply: false, lessons: [0] })).json()) as { remembered: number }
    expect(accepted.remembered).toBe(1)
    expect(saved).toEqual([{ id: 1, statement: 'Инвойсы HiQ выставляются через PayPal', entity: 'HiQ', createdAt: clock.toISOString() }])

    // Facts can also be added and removed by hand.
    expect((await send('/v1/agent-knowledge', { statement: 'мало' })).status).toBe(400)
    await send('/v1/agent-knowledge', { statement: 'Remote используется только для TuMeke', entity: 'Remote' })
    const listed = (await (await memApp.request('/v1/agent-knowledge')).json()) as { items: unknown[]; available: boolean }
    expect(listed).toMatchObject({ available: true })
    expect(listed.items).toHaveLength(2)
    expect((await send('/v1/agent-knowledge/2', {}, 'DELETE')).status).toBe(200)
    expect((await send('/v1/agent-knowledge/2', {}, 'DELETE')).status).toBe(404)
  })

  it('removes a run from any state without touching the task, and stops a turn that is still going', async () => {
    const ids: Record<string, string> = {}
    for (const [name, taskId] of [['queued', 't1'], ['running', 't2']] as const) {
      await post('/v1/agent-runs', { taskId })
      ids[name] = store.list().find((r) => r.taskId === taskId)!.id
    }
    store.claim('mac', 1) // t1 is taken first…
    const running = store.list().find((r) => r.state === 'running')!.id
    const queued = store.list().find((r) => r.state === 'queued')!.id

    expect(((await (await post(`/v1/agent-runs/${running}/dismiss`)).json()) as { run: { state: string } }).run.state).toBe('closed')
    expect(store.heartbeat(running).stop).toBe(true) // the live turn is told to stop
    expect((await post(`/v1/agent-runs/${queued}/dismiss`)).status).toBe(200)
    expect(store.claim('mac', 2)).toHaveLength(0) // nothing left to hand out
    expect(store.list()).toHaveLength(0)
    expect(mindwtr.updateTask).not.toHaveBeenCalled()
    expect((await post('/v1/agent-runs/nope/dismiss')).status).toBe(404)
  })
})
