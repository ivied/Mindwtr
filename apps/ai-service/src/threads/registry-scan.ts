/**
 * Thread registry scanner — builds the live Claude Code thread list by reading
 * the local session store (~/.claude/projects/<encoded-path>/<sessionId>.jsonl).
 *
 * Single source of truth: ai-service serves this over /v1/threads (desktop
 * picker) and the Enricher + Mac worker consume it in-process. No hand-curated
 * copies.
 *
 * Cheap by design: per session we read only the head of the file (aiTitle,
 * first user message, cwd all appear early) and take lastTouched from the file
 * mtime — so a 50 MB thread costs one stat + a 256 KB read, not a full parse.
 *
 * NOTE: the process must see ~/.claude/projects. On the host (dev, Mac worker)
 * that's automatic; a Dockerized ai-service needs it mounted, or set
 * CLAUDE_PROJECTS_DIR to a synced path.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RegistryThread {
  sessionId: string
  alias: string
  repo: string
  repoLabel: string
  lastTouched: string
  summary: string
}

export interface ScannedRegistry {
  threads: RegistryThread[]
  /** repo slug → filesystem cwd, for the Mac worker to run `claude` in. */
  repoPaths: Record<string, string>
}

const HEAD_BYTES = 256 * 1024
const NOISE = /<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|local-command)[^>]*>[\s\S]*?<\/\1>|<[^>]+>/g

export function defaultProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
}

export function repoLabelFromSlug(slug: string): string {
  const known: Record<string, string> = {
    UpworkApI: 'Upwork API',
    SynapseType: 'Synapse Type',
    '9routerNB': '9router',
    GTD_automation: 'GitHub automation',
    GTD_mindwtr: 'GTD (mindwtr)',
    TatianaUniDevFinance: 'UniDev Finance',
    home: 'Home / Mac',
  }
  return known[slug] ?? slug
}

function clean(s: string): string {
  return s.replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
}

function repoFromCwd(cwd: string | null, home: string): string {
  if (!cwd) return 'home'
  if (cwd === home) return 'home'
  const slug = cwd.split('/').filter(Boolean).pop()
  return slug || 'home'
}

interface HeadFields {
  aiTitle?: string
  firstUser?: string
  cwd?: string
}

function readHead(file: string): HeadFields {
  let buf: Buffer
  try {
    const fd = openSync(file, 'r')
    try {
      buf = Buffer.alloc(HEAD_BYTES)
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
      buf = buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return {}
  }
  const out: HeadFields = {}
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue // last line may be truncated by the head cap
    }
    if (!out.aiTitle && typeof d.aiTitle === 'string') out.aiTitle = d.aiTitle
    if (!out.cwd && typeof d.cwd === 'string') out.cwd = d.cwd
    if (!out.firstUser && d.type === 'user') {
      const msg = d.message as { content?: unknown } | undefined
      const c = msg?.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) {
        for (const it of c) {
          if (it && typeof it === 'object' && (it as { type?: string }).type === 'text') {
            text = String((it as { text?: string }).text ?? '')
            break
          }
        }
      }
      const cl = clean(text)
      if (cl) out.firstUser = cl
    }
    if (out.aiTitle && out.cwd && out.firstUser) break
  }
  return out
}

export function scanThreadRegistry(dir = defaultProjectsDir(), limit = 120): ScannedRegistry {
  const home = homedir()
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(dir)
  } catch {
    return { threads: [], repoPaths: { home } }
  }

  const threads: RegistryThread[] = []
  const repoPaths: Record<string, string> = { home }

  for (const proj of projectDirs) {
    const pdir = join(dir, proj)
    let files: string[]
    try {
      if (!statSync(pdir).isDirectory()) continue
      files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const file = join(pdir, f)
      const sessionId = f.slice(0, -'.jsonl'.length)
      let mtime: Date
      try {
        mtime = statSync(file).mtime
      } catch {
        continue
      }
      const head = readHead(file)
      if (!head.firstUser && !head.aiTitle) continue // empty / no user turn

      const repo = repoFromCwd(head.cwd ?? null, home)
      if (head.cwd && !repoPaths[repo]) repoPaths[repo] = head.cwd
      const alias = (head.aiTitle || head.firstUser || '(без имени)').slice(0, 80)
      threads.push({
        sessionId,
        alias,
        repo,
        repoLabel: repoLabelFromSlug(repo),
        lastTouched: mtime.toISOString().slice(0, 10),
        summary: (head.firstUser ?? '').slice(0, 160),
      })
    }
  }

  threads.sort((a, b) => b.lastTouched.localeCompare(a.lastTouched))
  return { threads: threads.slice(0, limit), repoPaths }
}
