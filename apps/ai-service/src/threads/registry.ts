/**
 * Cached access to the scanned thread registry + the Enricher pre-fill matcher.
 * One scan is shared by the /v1/threads route, the Enricher, and the Mac worker.
 */

import { TARGET_PREFIX } from '../commitment/routing-target'
import { scanThreadRegistry, type RegistryThread, type ScannedRegistry } from './registry-scan'

const TTL_MS = 5 * 60 * 1000
let cache: { at: number; data: ScannedRegistry } | null = null

function load(): ScannedRegistry {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.data
  const data = scanThreadRegistry()
  cache = { at: now, data }
  return data
}

/** Force a refresh on the next read (e.g. after a new thread is created). */
export function invalidateThreadRegistry(): void {
  cache = null
}

export function getThreadRegistry(): RegistryThread[] {
  return load().threads
}

export function getRepoPaths(): Record<string, string> {
  return load().repoPaths
}

export function findThread(sessionId: string): RegistryThread | undefined {
  return load().threads.find((t) => t.sessionId === sessionId)
}

/**
 * Enricher pre-fill: pick where a routable task should run. Deterministic
 * scoring over alias / repo / summary — best hit continues that thread; no hit
 * → OpenClaw. The user can override via the card chip, so a wrong guess is one
 * tap to fix (no model call needed here).
 */
export function pickRoutingTargetTag(
  title: string,
  description: string | undefined,
  tags: string[] | undefined,
  /**
   * Optional WHERE-hint from a matching playbook (a tool/repo/session name the
   * recorded procedure pointed at). Weighted highest — the user wrote it down
   * on purpose — but still resolved against the live thread registry so it
   * lands on a real session when one matches.
   */
  targetHint?: string
): string {
  const hint = (targetHint ?? '').toLowerCase().trim()
  const hay = `${title} ${description ?? ''} ${(tags ?? []).join(' ')} ${hint}`.toLowerCase()
  // Significant words from the playbook hint, so "Upwork Monitor" still hits a
  // repo labelled "Upwork API" via the shared "upwork" token. Drops generic
  // filler that would over-match ("the", "task", "monitor", "agent"…).
  const hintWords = new Set(
    hint
      .split(/\W+/)
      .filter((w) => w.length >= 4 && !TARGET_HINT_STOPWORDS.has(w))
  )
  let best: { id: string; score: number } | null = null
  for (const t of getThreadRegistry()) {
    let score = 0
    const alias = t.alias.toLowerCase()
    const repoLabel = t.repoLabel.toLowerCase()
    const repoSlug = t.repo.toLowerCase()
    if (alias.length >= 3 && hay.includes(alias)) score += 3
    // A playbook that names this thread's alias/repo is the strongest signal.
    if (hint.length >= 3 && alias.length >= 3 && hint.includes(alias)) score += 5
    if (repoLabel.length >= 3 && hay.includes(repoLabel)) score += 2
    if (hint.length >= 3 && repoLabel.length >= 3 && hint.includes(repoLabel)) score += 4
    // Word-overlap between the playbook hint and the thread's repo/label/alias.
    // Catches naming drift ("Upwork Monitor" playbook ↔ "Upwork API" repo).
    if (hintWords.size > 0) {
      const threadWords = `${repoLabel} ${repoSlug} ${alias} ${t.summary.toLowerCase()}`
      for (const w of hintWords) {
        if (threadWords.includes(w)) score += 4
      }
    }
    for (const w of t.summary.toLowerCase().split(/\W+/)) {
      if (w.length >= 4 && hay.includes(w)) score += 1
    }
    if (score > 0 && (!best || score > best.score)) best = { id: t.sessionId, score }
  }
  return best ? `${TARGET_PREFIX}mac:${best.id}` : `${TARGET_PREFIX}openclaw`
}

/** Generic words that should not drive playbook→thread target matching. */
const TARGET_HINT_STOPWORDS: ReadonlySet<string> = new Set([
  'monitor',
  'agent',
  'task',
  'tasks',
  'playbook',
  'tool',
  'tools',
  'project',
  'через',
  'отправить',
  'сгенерировать',
])
