import { describe, it, expect } from 'bun:test'
import type { RunsApi } from './client'
import { describeTool, filterOrphanResults, mapMessage } from './events'
import { outwardReason } from './guard'
import { buildFirstPrompt, buildResumePrompt } from './prompt'
import type { ClaimedRun, FinishBody, HeartbeatResult, RunEventInput } from './protocol'
import { decideOutcome, executeTurn, type QueryFn, type RunnerConfig } from './runner'

const cfg: RunnerConfig = {
  name: 'test',
  concurrency: 1,
  pollMs: 1000,
  flushMs: 10_000,
  cwd: '/tmp',
  maxBudgetUsd: 0,
  turnTimeoutMs: 60_000,
  env: {},
}

const claimed = (over: Partial<ClaimedRun['run']> = {}, reply: ClaimedRun['reply'] = null): ClaimedRun => ({
  run: {
    id: 'run-12345678',
    taskId: 't1',
    taskTitle: 'Продлить домен',
    taskDescription: '',
    state: 'running',
    sessionId: null,
    cwd: null,
    costUsd: 0,
    ...over,
  },
  reply,
})

function fakeApi(heartbeats: HeartbeatResult[] = []) {
  const events: RunEventInput[] = []
  const finished: FinishBody[] = []
  const api: RunsApi = {
    claim: async () => ({ items: [], overBudget: false }),
    sendEvents: async (_id, batch) => {
      events.push(...batch)
      return heartbeats.shift() ?? { stop: false, messages: [] }
    },
    finish: async (_id, body) => {
      finished.push(body)
    },
  }
  return { api, events, finished }
}

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  session_id: 'sess-1',
  parent_tool_use_id: parent,
  message: { content },
})
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  result: 'итог текстом',
  total_cost_usd: 0.25,
  ...over,
})

describe('events', () => {
  it('summarises tool calls the way the log shows them', () => {
    expect(describeTool('Bash', { command: 'hermes  cron\n list' })).toEqual({ tool: 'Shell', call: 'hermes cron list' })
    expect(describeTool('mcp__slack__search_messages', { query: 'скидка', limit: 5, deep: { a: 1 } })).toEqual({
      tool: 'slack',
      call: 'search_messages · query=скидка, limit=5',
    })
    expect(describeTool('Agent', { description: 'логи за ночь', prompt: '…' }).tool).toBe('Субагент')
  })

  it('maps text, tool calls and results; hides the control tools and their results', () => {
    const shown = new Set<string>()
    const a = filterOrphanResults(
      mapMessage(
        assistant([
          { type: 'thinking', thinking: '…' },
          { type: 'text', text: ' Ищу тред ' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'tu2', name: 'mcp__gtd__ask_user', input: { question: '?' } },
        ])
      ),
      shown
    )
    expect(a.map((e) => e.kind)).toEqual(['say', 'tool'])
    expect(a[0]!.payload.text).toBe('Ищу тред')
    expect(a[1]!.payload).toMatchObject({ toolUseId: 'tu1', tool: 'Shell', call: 'ls' })

    const b = filterOrphanResults(
      mapMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }] },
            { type: 'tool_result', tool_use_id: 'tu2', content: 'Вопрос передан' },
          ],
        },
      }),
      shown
    )
    expect(b).toEqual([{ kind: 'tool_result', payload: { toolUseId: 'tu1', output: 'a.txt', isError: false } }])
  })

  it('marks subagent steps with their parent call', () => {
    const [e] = mapMessage(assistant([{ type: 'text', text: 'читаю логи' }], 'tu-agent'))
    expect(e!.payload.parent).toBe('tu-agent')
  })
})

describe('outward-action guard', () => {
  const bash = (command: string) => outwardReason('Bash', { command })

  it('lets investigation through', () => {
    expect(bash('git log --oneline -5 && git status')).toBeNull()
    expect(bash('docker ps && docker logs ai-service --tail 20')).toBeNull()
    expect(bash('curl -s -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/context/search?q=x"')).toBeNull()
    expect(bash('curl -s -X POST http://localhost:3030/v1/capture -d "{}"')).toBeNull()
    expect(bash('rm -rf /tmp/agent-scratch /private/tmp/x')).toBeNull()
    expect(outwardReason('mcp__slack__search_messages', {})).toBeNull()
    expect(outwardReason('mcp__gtd__request_confirmation', {})).toBeNull()
    expect(outwardReason('Read', { file_path: '/etc/hosts' })).toBeNull()
  })

  it('blocks sending, publishing, deploying and destroying', () => {
    expect(bash('git add -A && git push origin main')).toContain('git push')
    expect(bash('gh pr merge 48 --squash')).not.toBeNull()
    expect(bash('docker compose -f docker/compose.yaml up -d ai-service')).not.toBeNull()
    expect(bash('rm -rf ~/projects/old')).toContain('удаление')
    expect(bash('rm -rf /tmp/x ~/Documents')).not.toBeNull()
    expect(bash('curl -X POST https://slack.com/api/chat.postMessage -d text=hi')).not.toBeNull()
    expect(bash('curl https://api.example.com/v1/orders --json \'{"a":1}\'')).toContain('HTTP')
    expect(bash('hermes send slack:D123 "привет"')).not.toBeNull()
    expect(bash('sqlite3 data.db "DELETE FROM leads"')).not.toBeNull()
    expect(outwardReason('mcp__slack__send_message', {})).toContain('slack')
    expect(outwardReason('mcp__notion__create_page', {})).not.toBeNull()
  })
})

describe('browser guard', () => {
  const chrome = (tool: string, input: Record<string, unknown>) => outwardReason(`mcp__claude-in-chrome__${tool}`, input)
  const act = (action: string, action_summary?: string, extra: Record<string, unknown> = {}) =>
    chrome('computer', { action, tabId: 1, ...(action_summary ? { action_summary } : {}), ...extra })

  it('lets the agent read, navigate and search', () => {
    expect(chrome('tabs_create_mcp', {})).toBeNull()
    expect(chrome('navigate', { url: 'https://app.slack.com/client', tabId: 1 })).toBeNull()
    expect(chrome('get_page_text', { tabId: 1 })).toBeNull()
    expect(act('screenshot')).toBeNull()
    expect(act('scroll', undefined, { scroll_direction: 'down' })).toBeNull()
    expect(act('left_click', 'Opens the #deals channel')).toBeNull()
    expect(act('type', 'Types the query into the search box', { text: 'домен' })).toBeNull()
    expect(act('key', 'Runs the search', { text: 'Enter' })).toBeNull()
    expect(act('key', 'Closes the dialog', { text: 'Escape' })).toBeNull()
    expect(chrome('form_input', { ref: 'r1', value: 'x', action_summary: 'Filters the list by owner' })).toBeNull()
  })

  it('holds back what changes or sends something on the site', () => {
    expect(act('left_click', 'Sends the drafted reply to Pat')).toContain('Sends')
    expect(act('left_click', 'Удаляет сообщение')).not.toBeNull()
    expect(act('left_click', 'Submits the order')).not.toBeNull()
    expect(act('key', 'Moves to the next line', { text: 'Enter' })).toContain('Enter')
    expect(act('key', 'Sends the message', { text: 'cmd+Return' })).not.toBeNull()
    expect(act('left_click')).toContain('action_summary')
    expect(chrome('javascript_tool', { action: 'javascript_exec', text: 'document.title' })).not.toBeNull()
    expect(chrome('file_upload', {})).not.toBeNull()
    expect(chrome('navigate', { url: 'javascript:void(document.forms[0].submit())' })).not.toBeNull()
  })

  it('checks every step of a batch', () => {
    const read = { name: 'computer', input: { action: 'left_click', action_summary: 'Opens the thread', tabId: 1 } }
    const send = { name: 'computer', input: { action: 'left_click', action_summary: 'Posts the comment', tabId: 1 } }
    expect(chrome('browser_batch', { actions: [read, { name: 'navigate', input: { url: 'https://x.test' } }] })).toBeNull()
    expect(chrome('browser_batch', { actions: [read, send] })).toContain('Posts')
  })
})

describe('prompts', () => {
  it('puts the task into the first prompt and the reply into the resume prompt', () => {
    expect(buildFirstPrompt({ taskId: 't1', taskTitle: 'Продлить домен', taskDescription: '' })).toContain('Продлить домен')
    expect(buildResumePrompt({ kind: 'answer', text: '3 года' })).toContain('3 года')
    expect(buildResumePrompt({ kind: 'approve', text: '' })).toContain('подтвердил')
    expect(buildResumePrompt({ kind: 'reject', text: 'не надо' })).toContain('не выполняй')
  })
})

describe('turn outcome', () => {
  it('a pending request wins over a result; bare text becomes a plain result', () => {
    const pending = { kind: 'question' as const, question: '?', options: [] }
    const res = { summary: 's', evidence: [], changes: {} }
    expect(decideOutcome({ pending, result: res }, 'x').state).toBe('question')
    expect(decideOutcome({ pending: null, result: res }, 'x')).toEqual({ state: 'done', result: res })
    expect(decideOutcome({ pending: null, result: null }, ' итог ').result!.summary).toBe('итог')
  })
})

describe('executeTurn', () => {
  it('streams steps and finishes done with the session and cost', async () => {
    const { api, events, finished } = fakeApi()
    const seen: Array<{ prompt: string; resume?: string }> = []
    const q: QueryFn = async function* ({ prompt, options }) {
      seen.push({ prompt, resume: options.resume })
      yield assistant([{ type: 'text', text: 'Смотрю регистратора' }])
      yield result()
    }
    await executeTurn(api, cfg, claimed(), () => {}, q)
    expect(seen[0]!.resume).toBeUndefined()
    expect(seen[0]!.prompt).toContain('Продлить домен')
    expect(events.map((e) => e.kind)).toEqual(['say', 'done'])
    expect(finished[0]).toMatchObject({ state: 'done', sessionId: 'sess-1', costUsd: 0.25, cwd: '/tmp' })
    expect(finished[0]!.result!.summary).toBe('итог текстом')
  })

  it('resumes the session with the user reply', async () => {
    const { api, finished } = fakeApi()
    let got: { prompt: string; resume?: string } | null = null
    const q: QueryFn = async function* ({ prompt, options }) {
      got = { prompt, resume: options.resume }
      yield result({ session_id: 'sess-0' })
    }
    await executeTurn(api, cfg, claimed({ sessionId: 'sess-0', cwd: '/work' }, { kind: 'answer', text: '3 года' }), () => {}, q)
    expect(got!.resume).toBe('sess-0')
    expect(got!.prompt).toContain('3 года')
    expect(finished[0]!.cwd).toBe('/work')
  })

  it('runs a follow-up turn for messages sent while the agent was working', async () => {
    const { api, finished } = fakeApi([{ stop: false, messages: [{ kind: 'message', text: 'проверь ещё Slack' }] }])
    const prompts: string[] = []
    const q: QueryFn = async function* ({ prompt }) {
      prompts.push(prompt)
      yield result({ result: `ход ${prompts.length}` })
    }
    await executeTurn(api, cfg, claimed(), () => {}, q)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('проверь ещё Slack')
    expect(finished[0]!.result!.summary).toBe('ход 2')
  })

  it('reports stopped when the user stops mid-turn', async () => {
    const { api, finished } = fakeApi([{ stop: true, messages: [] }])
    const q: QueryFn = async function* () {
      yield assistant([{ type: 'text', text: 'работаю' }])
      yield result()
    }
    await executeTurn(api, cfg, claimed(), () => {}, q)
    expect(finished[0]!.state).toBe('stopped')
  })

  it('turns SDK failures into an error outcome instead of throwing', async () => {
    const a = fakeApi()
    const limit: QueryFn = async function* () {
      yield result({ subtype: 'error_max_budget_usd', result: undefined })
    }
    await executeTurn(a.api, cfg, claimed(), () => {}, limit)
    expect(a.finished[0]!.state).toBe('error')
    expect(a.events.at(-1)!.kind).toBe('error')

    const b = fakeApi()
    const boom: QueryFn = async function* () {
      throw new Error('session not found')
    }
    await executeTurn(b.api, cfg, claimed({ sessionId: 'gone' }), () => {}, boom)
    expect(b.finished[0]).toMatchObject({ state: 'error', error: 'session not found' })
  })
})
