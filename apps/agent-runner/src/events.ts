/**
 * SDK message → UI events. Pure, so the transcript shape is unit-tested
 * without spawning an agent.
 *
 * The UI shows a Claude-Code-like log: what the agent said, each tool call as
 * a one-line summary that expands into its input/output, and subagent work
 * nested under the call that spawned it (`parent`).
 */

import type { RunEventInput } from './protocol'

const MAX_TEXT = 6000
const MAX_IO = 4000
/** Our own control tools — they surface as run state, not as transcript noise. */
export const GTD_TOOL_PREFIX = 'mcp__gtd__'
/** Harness plumbing with nothing to show the user. */
const HIDDEN_TOOLS = new Set(['ToolSearch'])

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + `\n… (ещё ${s.length - max} симв.)` : s)
const oneLine = (s: string, max = 180): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Human label + one-line summary for a tool call. */
export function describeTool(name: string, rawInput: unknown): { tool: string; call: string } {
  const input = asRecord(rawInput)
  switch (name) {
    case 'Bash':
      return { tool: 'Shell', call: oneLine(s(input.command)) }
    case 'Read':
      return { tool: 'Файл', call: oneLine(`читает ${s(input.file_path)}`) }
    case 'Write':
      return { tool: 'Файл', call: oneLine(`пишет ${s(input.file_path)}`) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool: 'Файл', call: oneLine(`правит ${s(input.file_path) || s(input.notebook_path)}`) }
    case 'Grep':
      return { tool: 'Поиск', call: oneLine(`«${s(input.pattern)}»${input.path ? ` в ${s(input.path)}` : ''}`) }
    case 'Glob':
      return { tool: 'Поиск', call: oneLine(`файлы ${s(input.pattern)}`) }
    case 'WebFetch':
      return { tool: 'Веб', call: oneLine(s(input.url)) }
    case 'WebSearch':
      return { tool: 'Веб', call: oneLine(`поиск «${s(input.query)}»`) }
    case 'Agent':
    case 'Task':
      return { tool: 'Субагент', call: oneLine(s(input.description) || s(input.prompt)) }
    case 'TodoWrite':
      return { tool: 'План', call: 'обновил список шагов' }
  }
  if (name.startsWith('mcp__')) {
    const [, server = 'mcp', ...rest] = name.split('__')
    const args = Object.entries(input)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
    return { tool: server, call: oneLine(`${rest.join('__')}${args ? ` · ${args}` : ''}`) }
  }
  return { tool: name, call: oneLine(JSON.stringify(input)) }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const block = asRecord(b)
      if (block.type === 'text') return s(block.text)
      if (block.type === 'image') return '[изображение]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Loose view of the SDK message union — only the fields we read. */
export interface SdkMessageLike {
  type: string
  parent_tool_use_id?: string | null
  message?: { content?: unknown }
}

export function mapMessage(msg: SdkMessageLike): RunEventInput[] {
  const out: RunEventInput[] = []
  const parent = msg.parent_tool_use_id ?? null
  const content = msg.message?.content

  if (msg.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      const block = asRecord(b)
      if (block.type === 'text') {
        const text = s(block.text).trim()
        if (text) out.push({ kind: 'say', payload: { text: clip(text, MAX_TEXT), ...(parent ? { parent } : {}) } })
      } else if (block.type === 'tool_use') {
        const name = s(block.name)
        if (name.startsWith(GTD_TOOL_PREFIX) || HIDDEN_TOOLS.has(name)) continue
        const { tool, call } = describeTool(name, block.input)
        out.push({
          kind: 'tool',
          payload: {
            toolUseId: s(block.id),
            name,
            tool,
            call,
            input: clip(JSON.stringify(block.input ?? {}, null, 2), MAX_IO),
            ...(parent ? { parent } : {}),
          },
        })
      }
    }
  } else if (msg.type === 'user' && Array.isArray(content)) {
    for (const b of content) {
      const block = asRecord(b)
      if (block.type !== 'tool_result') continue
      out.push({
        kind: 'tool_result',
        payload: {
          toolUseId: s(block.tool_use_id),
          output: clip(toolResultText(block.content), MAX_IO),
          isError: block.is_error === true,
        },
      })
    }
  }
  return out
}

/**
 * Drop results of calls we never showed (our own control tools), so the UI
 * doesn't get orphan outputs. `shown` accumulates across a turn.
 */
export function filterOrphanResults(events: RunEventInput[], shown: Set<string>): RunEventInput[] {
  const out: RunEventInput[] = []
  for (const e of events) {
    if (e.kind === 'tool') shown.add(String(e.payload.toolUseId))
    if (e.kind === 'tool_result' && !shown.has(String(e.payload.toolUseId))) continue
    out.push(e)
  }
  return out
}
