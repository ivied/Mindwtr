/**
 * The Claude Code sessions of this computer, read from the files Claude Code
 * keeps itself: transcripts in `~/.claude/projects/<dir>/<id>.jsonl` and the
 * registry of open sessions in `~/.claude/sessions/<pid>.json`.
 *
 * A card per session says where it runs, what it is about (Claude Code's own
 * title, the user's first and latest prompts), which tools it used and whether
 * it is open right now. No model is called to build it. The dispatcher
 * (session-dispatch.ts) sends the cards to ai-service, where an inbox agent
 * picks the session to hand a goal to; transcripts stay here and are read in
 * pieces on request.
 *
 * No dependencies beyond the runtime: this file is copied to the computer as is.
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/** What ai-service keeps about a session (its SessionCard). */
export interface WireCard {
  sessionId: string
  cwd: string | null
  title: string | null
  entrypoint: string | null
  startedAt: string | null
  lastActiveAt: string | null
  /** Prompts typed by the user — not tool results, not injected context, not delegated goals. */
  promptCount: number
  firstPrompts: string[]
  lastPrompts: string[]
  /** Built-in tool names, and `mcp:<server>` for MCP servers. */
  tools: string[]
  skills: string[]
}

export interface SessionCard extends WireCard {
  file: string
  bytes: number
  mtimeMs: number
}

export interface LiveSession {
  pid: number
  sessionId: string
  name: string | null
  /** `idle` when the session waits for input; anything else means it is in a turn. */
  status: string | null
  /** Where another session's SendMessage reaches it. */
  socket: string | null
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  text: string
  ts: string | null
}

/** Every goal handed to a session starts with this, so it can be found in the transcript and kept out of the card. */
export const DELEGATION_MARK = '[поручение gtd:'

const FIRST_PROMPTS = 3
const LAST_PROMPTS = 6
const PROMPT_CHARS = 400
/** Lines above this are request dumps and file snapshots, never a message. */
const MAX_LINE = 400_000
/** Cheap pre-filter so that big transcripts are not JSON-parsed line by line. */
const WANTED = /"type":"(user|assistant|ai-title|custom-title|tools-used)"/

const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '***'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
  // After the word, separated by a space: only something that looks generated (long, with a digit), not the next word of a sentence.
  [/((?:password|passwd|пароль|token|токен|secret|секрет|api[_-]?key|apikey|ключ|bearer)["']?\s*[:=]?\s+["']?)(?=[A-Za-z0-9_\-./+=]*\d)([A-Za-z0-9_\-./+=]{12,})/gi, '$1***'],
  [/((?:password|passwd|token|secret|api[_-]?key|apikey)["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi, '$1***'],
]

/** Things that look like keys, tokens and passwords, replaced before a text leaves this computer. */
export function maskSecrets(text: string): string {
  let out = text
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

type Rec = Record<string, any>

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some((part) => part?.type === 'tool_result')) return null
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

/** The text the user typed, or null when the record is tool output, injected context or a delegated goal. */
export function promptText(record: Rec, max = PROMPT_CHARS): string | null {
  if (record?.type !== 'user' || record.isSidechain || record.isMeta || record.isCompactSummary) return null
  if (record.isVisibleInTranscriptOnly) return null
  const raw = textOf(record.message?.content)
  if (!raw) return null
  const text = raw
    .replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+|task-notification)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\[Image[^\]]*\]/g, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || text.startsWith('Caveat:') || text.startsWith('[Request interrupted') || text.startsWith(DELEGATION_MARK)) return null
  return clip(maskSecrets(text), max)
}

function assistantParts(record: Rec): { texts: string[]; toolUse: boolean } {
  const texts: string[] = []
  let toolUse = false
  for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
    if (part?.type === 'tool_use') toolUse = true
    else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) texts.push(part.text.trim())
  }
  return { texts, toolUse }
}

function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__/.exec(name)
  return mcp ? `mcp:${mcp[1]}` : name
}

function parse(line: string): Rec | null {
  if (line.length > MAX_LINE || !WANTED.test(line)) return null
  try {
    return JSON.parse(line) as Rec
  } catch {
    return null
  }
}

export async function readSessionFile(file: string): Promise<WireCard> {
  const card: WireCard = {
    sessionId: file.replace(/^.*\//, '').replace(/\.jsonl$/, ''),
    cwd: null,
    title: null,
    entrypoint: null,
    startedAt: null,
    lastActiveAt: null,
    promptCount: 0,
    firstPrompts: [],
    lastPrompts: [],
    tools: [],
    skills: [],
  }
  const tools = new Set<string>()
  const skills = new Set<string>()
  let customTitle: string | null = null

  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    const record = parse(line)
    if (!record) continue
    switch (record.type) {
      case 'ai-title':
        if (typeof record.aiTitle === 'string') card.title = record.aiTitle
        break
      case 'custom-title':
        if (typeof record.customTitle === 'string') customTitle = record.customTitle
        break
      case 'tools-used':
        for (const tool of Array.isArray(record.tools) ? record.tools : []) {
          if (typeof tool === 'string') tools.add(toolLabel(tool))
          else if (typeof tool?.name === 'string') tools.add(toolLabel(tool.name))
        }
        break
      case 'assistant':
        if (record.isSidechain) break
        for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue
          tools.add(toolLabel(part.name))
          if (part.name === 'Skill' && typeof part.input?.skill === 'string') skills.add(part.input.skill)
        }
        if (record.timestamp) card.lastActiveAt = record.timestamp
        break
      case 'user': {
        if (record.isSidechain) break
        card.cwd ??= record.cwd ?? null
        card.entrypoint ??= record.entrypoint ?? null
        if (record.timestamp) {
          card.startedAt ??= record.timestamp
          card.lastActiveAt = record.timestamp
        }
        const text = promptText(record)
        if (!text) break
        card.promptCount += 1
        if (card.firstPrompts.length < FIRST_PROMPTS) card.firstPrompts.push(text)
        else {
          card.lastPrompts.push(text)
          if (card.lastPrompts.length > LAST_PROMPTS) card.lastPrompts.shift()
        }
        break
      }
    }
  }
  card.title = customTitle ?? card.title
  if (card.title) card.title = clip(maskSecrets(card.title), 200)
  card.tools = [...tools].sort()
  card.skills = [...skills].sort()
  return card
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Sessions open in a running Claude Code process, by session id. */
export async function liveSessions(claudeDir = join(homedir(), '.claude')): Promise<Map<string, LiveSession>> {
  const dir = join(claudeDir, 'sessions')
  const live = new Map<string, LiveSession>()
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    try {
      const entry = JSON.parse(await readFile(join(dir, name), 'utf8')) as Rec
      if (typeof entry.pid !== 'number' || typeof entry.sessionId !== 'string' || !processAlive(entry.pid)) continue
      live.set(entry.sessionId, {
        pid: entry.pid,
        sessionId: entry.sessionId,
        name: typeof entry.name === 'string' ? entry.name : null,
        status: typeof entry.status === 'string' ? entry.status : null,
        socket: typeof entry.messagingSocketPath === 'string' ? entry.messagingSocketPath : null,
      })
    } catch {
      // a half-written registry file: the session shows up on the next pass
    }
  }
  return live
}

export interface IndexOptions {
  claudeDir?: string
  /** Where the cards are cached between passes. */
  cacheFile?: string
  /** Sessions untouched for longer than this are left out. */
  days?: number
  now?: () => number
}

/**
 * All sessions somebody typed into, the most recently used first. A transcript
 * whose size and mtime did not change since the last pass is not read again.
 */
export async function buildIndex(options: IndexOptions = {}): Promise<SessionCard[]> {
  const claudeDir = options.claudeDir ?? join(homedir(), '.claude')
  const cacheFile = options.cacheFile ?? join(homedir(), '.cache', 'gtd-agents', 'session-index.json')
  const since = (options.now ?? Date.now)() - (options.days ?? 30) * 86_400_000
  let cached = new Map<string, SessionCard>()
  try {
    cached = new Map((JSON.parse(await readFile(cacheFile, 'utf8')) as SessionCard[]).map((card) => [card.file, card]))
  } catch {
    // no cache yet, or one from another version: read everything
  }
  const projects = join(claudeDir, 'projects')
  const cards: SessionCard[] = []
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    const dir = join(projects, project)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      const info = await stat(file).catch(() => null)
      if (!info || info.mtimeMs < since) continue
      const known = cached.get(file)
      cards.push(
        known && known.bytes === info.size && known.mtimeMs === info.mtimeMs
          ? known
          : { ...(await readSessionFile(file)), file, bytes: info.size, mtimeMs: info.mtimeMs }
      )
    }
  }
  // By the last real turn: Claude Code touches the file of an open session without anyone working in it.
  const activity = (card: SessionCard) => (card.lastActiveAt ? Date.parse(card.lastActiveAt) : card.mtimeMs)
  cards.sort((a, b) => activity(b) - activity(a))
  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 })
  await writeFile(cacheFile, JSON.stringify(cards), { mode: 0o600 })
  // A transcript with nothing typed by the user, or a one-off headless run (`claude -p`), is a run of some
  // tool and not anybody's workplace.
  return cards.filter((card) => card.promptCount > 0 && !card.entrypoint?.startsWith('sdk'))
}

export function wireCard(card: SessionCard): WireCard {
  const { file: _file, bytes: _bytes, mtimeMs: _mtimeMs, ...wire } = card
  return wire
}

async function readFrom(file: string, offset: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, Math.min(offset, size))
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** The latest messages of a session: what the user typed and what the agent answered, without tool traffic. */
export async function readTail(file: string, limit: number, maxBytes = 3_000_000): Promise<SessionMessage[]> {
  const { size } = await stat(file)
  const chunk = await readFrom(file, size - maxBytes)
  const messages: SessionMessage[] = []
  // The first line of a chunk cut out of the middle is a fragment.
  for (const line of chunk.split('\n').slice(size > maxBytes ? 1 : 0)) {
    const record = parse(line)
    if (!record || record.isSidechain) continue
    const ts = typeof record.timestamp === 'string' ? record.timestamp : null
    if (record.type === 'user') {
      const text = promptText(record, 1500)
      if (text) messages.push({ role: 'user', text, ts })
    } else if (record.type === 'assistant') {
      for (const text of assistantParts(record).texts) messages.push({ role: 'assistant', text: clip(maskSecrets(text), 1500), ts })
    }
  }
  return messages.slice(-limit)
}

export interface TurnState {
  /** The message with the marker reached the transcript. */
  seen: boolean
  /** The last thing after it is the agent's text, with no tool call pending. */
  settled: boolean
  /** That closing text. */
  text: string
}

/**
 * What happened in a transcript after the message carrying `marker`, reading
 * from `offset` (the file's size just before the message was sent).
 */
export async function turnAfter(file: string, offset: number, marker: string): Promise<TurnState> {
  const state: TurnState = { seen: false, settled: false, text: '' }
  let closing: string[] = []
  for (const line of (await readFrom(file, offset)).split('\n')) {
    const record = parse(line)
    if (!record || record.isSidechain) continue
    if (record.type === 'user') {
      const content = record.message?.content
      const text = typeof content === 'string' ? content : (textOf(content) ?? '')
      if (!state.seen) {
        state.seen = text.includes(marker)
        continue
      }
      // A tool result or a new message: whatever was said before it was not the end.
      closing = []
      state.settled = false
    } else if (record.type === 'assistant' && state.seen) {
      const { texts, toolUse } = assistantParts(record)
      const stop = record.message?.stop_reason
      if (toolUse) {
        closing = []
        state.settled = false
      } else if (texts.length) {
        closing.push(...texts)
        state.settled = !stop || stop === 'end_turn'
      }
    }
  }
  state.text = closing.join('\n\n')
  return state
}
