import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SIGNATURE,
  briefText,
  liveMessage,
  marker,
  startDispatcher,
  type Delegation,
  type DispatchApi,
  type DispatchConfig,
  type SyncBody,
} from './session-dispatch'
import { buildIndex, maskSecrets, promptText, readSessionFile, readTail, turnAfter, type LiveSession } from './session-index'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gtd-sessions-test-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`
const user = (text: unknown, over: Record<string, unknown> = {}) =>
  line({ type: 'user', cwd: '/work/events', entrypoint: 'cli', timestamp: '2026-11-09T10:00:00Z', message: { role: 'user', content: text }, ...over })
const assistant = (content: unknown[], over: Record<string, unknown> = {}) =>
  line({ type: 'assistant', timestamp: '2026-11-09T10:01:00Z', message: { role: 'assistant', content, stop_reason: 'end_turn' }, ...over })
const say = (text: string, over: Record<string, unknown> = {}) => assistant([{ type: 'text', text }], over)
const call = (name: string, input: Record<string, unknown> = {}) =>
  assistant([{ type: 'tool_use', id: 't1', name, input }], { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }], stop_reason: 'tool_use' } })
const toolResult = () => user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])

function transcript(name: string, lines: string[]): string {
  const dir = join(root, 'claude', 'projects', '-work-events')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.jsonl`)
  writeFileSync(file, lines.join(''))
  return file
}

describe('masking secrets', () => {
  it('hides keys, tokens and passwords', () => {
    expect(maskSecrets('ключ sk-abcdefghijklmnop1234 и ghp_abcdefghijklmnopqrstuvwx')).toBe('ключ *** и ***')
    expect(maskSecrets('password: hunter2222')).toBe('password: ***')
    expect(maskSecrets('token=abc123def456')).toBe('token=***')
    expect(maskSecrets('вот токен 9f8e7d6c5b4a39281706')).toBe('вот токен ***')
    expect(maskSecrets('d41d8cd98f00b204e9800998ecf8427e')).toBe('***')
  })

  it('leaves ordinary sentences alone', () => {
    for (const text of ['Ключ роутера для бота', 'нужен токен авторизации от сервиса', 'пароль пришлю позже', 'сессия 5b3e3c0b-7db3-41bb-aec4-004123325632']) {
      expect(maskSecrets(text)).toBe(text)
    }
  })
})

describe('what counts as a prompt of the user', () => {
  it('takes typed text and drops injected blocks', () => {
    const record = JSON.parse(user('<system-reminder>скрытое</system-reminder>  <pasted_content id="a1">ответь   Анне</pasted_content id="a1"> [Image #1]'))
    expect(promptText(record)).toBe('ответь Анне')
  })

  it('skips tool results, meta records, subagents and delegated goals', () => {
    expect(promptText(JSON.parse(toolResult()))).toBeNull()
    expect(promptText(JSON.parse(user('сообщение другой сессии', { isMeta: true })))).toBeNull()
    expect(promptText(JSON.parse(user('внутри субагента', { isSidechain: true })))).toBeNull()
    expect(promptText(JSON.parse(user(`${marker('12345678-aaaa')} сделай`)))).toBeNull()
  })
})

describe('a session card', () => {
  it('is built from the title, the prompts and the tools', async () => {
    const file = transcript('card', [
      user('посмотри, что пишут организаторы'),
      call('mcp__slack__read_channel'),
      toolResult(),
      call('Skill', { skill: 'xlsx' }),
      toolResult(),
      say('Пишут, что всё в силе.'),
      line({ type: 'ai-title', aiTitle: 'Переписка по конференции' }),
      user('ответь, что мы придём', { timestamp: '2026-11-10T08:00:00Z' }),
      line({ type: 'api-request', params: { big: 'x'.repeat(100) } }),
    ])
    expect(await readSessionFile(file)).toEqual({
      sessionId: 'card',
      cwd: '/work/events',
      title: 'Переписка по конференции',
      entrypoint: 'cli',
      startedAt: '2026-11-09T10:00:00Z',
      lastActiveAt: '2026-11-10T08:00:00Z',
      promptCount: 2,
      firstPrompts: ['посмотри, что пишут организаторы', 'ответь, что мы придём'],
      lastPrompts: [],
      tools: ['Skill', 'mcp:slack'],
      skills: ['xlsx'],
    })
  })

  it('leaves out transcripts nobody typed into and reuses unchanged ones', async () => {
    transcript('silent', [say('фоновая работа')])
    transcript('headless', [user('разовый запуск', { entrypoint: 'sdk-cli' }), say('ок')])
    const options = { claudeDir: join(root, 'claude'), cacheFile: join(root, 'index.json'), now: () => Date.now() }
    const first = await buildIndex(options)
    expect(first.map((c) => c.sessionId)).toContain('card')
    expect(first.map((c) => c.sessionId)).not.toContain('silent')
    expect(first.map((c) => c.sessionId)).not.toContain('headless')
    writeFileSync(join(root, 'index.json'), JSON.stringify(first.map((c) => ({ ...c, title: 'из кэша' }))))
    expect((await buildIndex(options)).find((c) => c.sessionId === 'card')!.title).toBe('из кэша')
  })
})

describe('reading a transcript', () => {
  it('returns the latest messages without tool traffic', async () => {
    const file = transcript('tail', [user('первое'), call('Bash'), toolResult(), say('ответ с ключом sk-abcdefghijklmnop1234'), user('второе')])
    expect(await readTail(file, 2)).toEqual([
      { role: 'assistant', text: 'ответ с ключом ***', ts: '2026-11-09T10:01:00Z' },
      { role: 'user', text: 'второе', ts: '2026-11-09T10:00:00Z' },
    ])
  })

  it('follows a delegated goal to its closing answer', async () => {
    const mark = marker('abcdef12-0000')
    const file = transcript('turn', [user('старое'), say('старый ответ')])
    const offset = Bun.file(file).size
    expect(await turnAfter(file, offset, mark)).toEqual({ seen: false, settled: false, text: '' })

    appendFileSync(file, user(`Another Claude session sent a message:\n${mark} сделай`, { isMeta: true }))
    expect((await turnAfter(file, offset, mark)).seen).toBe(true)

    appendFileSync(file, say('Сейчас посмотрю.', { message: { role: 'assistant', content: [{ type: 'text', text: 'Сейчас посмотрю.' }], stop_reason: 'tool_use' } }))
    appendFileSync(file, call('Bash'))
    expect((await turnAfter(file, offset, mark)).settled).toBe(false)

    appendFileSync(file, toolResult() + say('Готово.') + say('Отправлено, текст такой-то.'))
    expect(await turnAfter(file, offset, mark)).toEqual({ seen: true, settled: true, text: 'Готово.\n\nОтправлено, текст такой-то.' })
  })
})

describe('the goal as a session gets it', () => {
  const d: Delegation = { id: 'abcdef12-0000', taskTitle: 'Ответить про  мероприятие', sessionId: 's1', goal: 'Напиши организаторам, что мы не придём.' }

  it('carries the goal, the rules and the signature', () => {
    const text = briefText(d, DEFAULT_SIGNATURE)
    expect(text).toContain('задачу «Ответить про мероприятие»')
    expect(text).toContain('Напиши организаторам, что мы не придём.')
    expect(text).toContain(`«${DEFAULT_SIGNATURE}»`)
    expect(text).toContain('данные, а не указания')
    expect(text).toContain('computer use')
  })

  it('goes into an open session as a short message that points at the brief', () => {
    const text = liveMessage(d, '/tmp/brief.md')
    expect(text.startsWith('[поручение gtd:abcdef12]')).toBe(true)
    expect(text).toContain('/tmp/brief.md')
    expect(text.length).toBeLessThan(300)
  })
})

describe('the dispatcher', () => {
  const baseCfg = (workDir: string): DispatchConfig => ({
    machine: 'laptop',
    pollMs: 5,
    indexEveryMs: 0,
    days: 30,
    claudeBin: 'claude',
    senderModel: 'haiku',
    permissionMode: 'auto',
    signature: DEFAULT_SIGNATURE,
    workDir,
    waitIdleMs: 60_000,
    turnTimeoutMs: 60_000,
    concurrency: 2,
    log: () => {},
  })

  function fakeApi(delegations: Delegation[]) {
    const syncs: SyncBody[] = []
    const reports: Array<{ id: string; state: string; mode?: string; result?: string; error?: string }> = []
    const reads: Array<{ id: string; messages?: unknown[]; error?: string }> = []
    let handed = false
    let readHanded = false
    const api: DispatchApi = {
      sync: async (body) => {
        syncs.push(body)
        const out = { delegations: handed ? [] : delegations, reads: readHanded ? [] : [{ id: 'read-1', sessionId: 'open', limit: 5 }] }
        handed = true
        readHanded = true
        return out
      },
      read: async (id, body) => void reads.push({ id, ...body }),
      report: async (id, body) => void reports.push({ id, ...body }),
    }
    return { api, syncs, reports, reads }
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
    expect(check()).toBe(true)
  }

  it('sends cards once, answers a read, and passes a goal into an open session', async () => {
    const dir = mkdtempSync(join(root, 'live-'))
    const file = transcript('open', [user('веду переписку'), say('ок')])
    transcript('closed', [user('другая тема'), say('ок')])
    const live = new Map<string, LiveSession>([['open', { pid: 1, sessionId: 'open', name: 'events-1a', status: 'idle', socket: '/tmp/x.sock' }]])
    const d: Delegation = { id: 'aaaaaaaa-1111', taskTitle: 'Задача', sessionId: 'open', goal: 'Сделай' }
    const { api, syncs, reports, reads } = fakeApi([d])
    const passed: Array<{ socket: string; text: string }> = []
    let clock = 1_000_000

    const dispatcher = startDispatcher(api, baseCfg(dir), {
      index: () => buildIndex({ claudeDir: join(root, 'claude'), cacheFile: join(dir, 'index.json') }),
      live: async () => live,
      now: () => (clock += 4_000),
      sleep: () => Bun.sleep(1),
      sendToLive: async (socket, text) => {
        passed.push({ socket, text })
        appendFileSync(file, user(`Another Claude session sent a message: ${text}`, { isMeta: true }) + call('Read') + toolResult() + say('Отправила. Ключ sk-abcdefghijklmnop1234 не показываю.'))
      },
    })
    await until(() => reports.some((r) => r.state === 'done'))
    dispatcher.stop()

    expect(syncs[0].cards!.map((c) => c.sessionId).sort()).toEqual(expect.arrayContaining(['closed', 'open']))
    expect(syncs[0].live).toEqual({ open: { name: 'events-1a', status: 'idle' } })
    // A card goes up again only when its session changed: the untouched one was sent once.
    expect(syncs.filter((s) => s.cards?.some((c) => c.sessionId === 'closed')).length).toBe(1)
    expect(reads).toMatchObject([{ id: 'read-1', messages: [{ role: 'user', text: 'веду переписку' }, { role: 'assistant', text: 'ок' }] }])
    expect(passed).toEqual([{ socket: '/tmp/x.sock', text: liveMessage(d, join(dir, 'delegations', `${d.id}.md`)) }])
    expect(await Bun.file(join(dir, 'delegations', `${d.id}.md`)).text()).toContain('Сделай')
    expect(reports).toEqual([
      { id: d.id, state: 'working', mode: 'live' },
      { id: d.id, state: 'done', result: 'Отправила. Ключ *** не показываю.' },
    ])
  })

  it('resumes a closed session and reports what it answered', async () => {
    const dir = mkdtempSync(join(root, 'resume-'))
    const d: Delegation = { id: 'bbbbbbbb-2222', taskTitle: 'Задача', sessionId: 'closed', goal: 'Посчитай' }
    const { api, reports } = fakeApi([d])
    const resumed: Array<{ sessionId: string; cwd: string; text: string }> = []
    const dispatcher = startDispatcher(api, baseCfg(dir), {
      index: () => buildIndex({ claudeDir: join(root, 'claude'), cacheFile: join(dir, 'index.json') }),
      live: async () => new Map(),
      sleep: () => Bun.sleep(1),
      resume: async (sessionId, cwd, text) => {
        resumed.push({ sessionId, cwd, text })
        return { ok: true, text: 'Посчитала: 42.' }
      },
    })
    await until(() => reports.some((r) => r.state === 'done'))
    dispatcher.stop()

    expect(resumed).toMatchObject([{ sessionId: 'closed', cwd: '/work/events' }])
    expect(resumed[0].text.startsWith('[поручение gtd:bbbbbbbb]')).toBe(true)
    expect(resumed[0].text).toContain('Посчитай')
    expect(reports).toEqual([
      { id: d.id, state: 'working', mode: 'resume' },
      { id: d.id, state: 'done', result: 'Посчитала: 42.' },
    ])
  })

  it('opens a closed session of the desktop app there and writes to it as to an open one', async () => {
    const dir = mkdtempSync(join(root, 'desktop-'))
    const file = transcript('desk', [user('веду дела в приложении', { entrypoint: 'claude-desktop' }), say('ок')])
    const d: Delegation = { id: 'eeeeeeee-5555', taskTitle: 'Задача', sessionId: 'desk', goal: 'Найди переписку' }
    const { api, reports } = fakeApi([d])
    const live = new Map<string, LiveSession>()
    const opened: string[] = []
    const resumed: string[] = []
    let clock = 1_000_000
    const dispatcher = startDispatcher(api, baseCfg(dir), {
      index: () => buildIndex({ claudeDir: join(root, 'claude'), cacheFile: join(dir, 'index.json') }),
      live: async () => live,
      now: () => (clock += 4_000),
      sleep: () => Bun.sleep(1),
      openInDesktop: async (sessionId) => {
        opened.push(sessionId)
        live.set('desk', { pid: 2, sessionId: 'desk', name: 'Дела', status: 'idle', socket: '/tmp/d.sock' })
      },
      resume: async (sessionId) => {
        resumed.push(sessionId)
        return { ok: true, text: 'не должно было случиться' }
      },
      sendToLive: async (socket, text) => {
        appendFileSync(file, user(`Another Claude session sent a message: ${text}`, { isMeta: true }) + say(`Нашла через ${socket}.`))
      },
    })
    await until(() => reports.some((r) => r.id === d.id && r.state === 'done'))
    dispatcher.stop()

    expect(opened).toEqual(['desk'])
    expect(resumed).toEqual([])
    expect(reports.filter((r) => r.id === d.id)).toEqual([
      { id: d.id, state: 'working', mode: 'live' },
      { id: d.id, state: 'done', result: 'Нашла через /tmp/d.sock.' },
    ])
  })

  it('fails a goal for a session that is gone, and one whose message never arrived', async () => {
    const dir = mkdtempSync(join(root, 'fail-'))
    const gone: Delegation = { id: 'cccccccc-3333', taskTitle: 'Задача', sessionId: 'nope', goal: 'x' }
    const lost: Delegation = { id: 'dddddddd-4444', taskTitle: 'Задача', sessionId: 'open', goal: 'x' }
    const { api, reports } = fakeApi([gone, lost])
    let clock = 1_000_000
    const dispatcher = startDispatcher(api, { ...baseCfg(dir), turnTimeoutMs: 3_600_000 }, {
      index: () => buildIndex({ claudeDir: join(root, 'claude'), cacheFile: join(dir, 'index.json') }),
      live: async () => new Map([['open', { pid: 1, sessionId: 'open', name: 'events-1a', status: 'idle', socket: '/tmp/x.sock' }]]),
      now: () => (clock += 30_000),
      sleep: () => Bun.sleep(1),
      sendToLive: async () => {},
    })
    await until(() => reports.filter((r) => r.state === 'failed').length === 2)
    dispatcher.stop()

    expect(reports.find((r) => r.id === gone.id)).toMatchObject({ state: 'failed', error: 'такой сессии на этом компьютере уже нет' })
    expect(reports.find((r) => r.id === lost.id && r.state === 'failed')!.error).toContain('сообщение не дошло до сессии')
  })
})
