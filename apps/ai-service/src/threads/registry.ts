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
  tags: string[] | undefined
): string {
  const hay = `${title} ${description ?? ''} ${(tags ?? []).join(' ')}`.toLowerCase()
  let best: { id: string; score: number } | null = null
  for (const t of getThreadRegistry()) {
    let score = 0
    const alias = t.alias.toLowerCase()
    if (alias.length >= 3 && hay.includes(alias)) score += 3
    if (t.repoLabel.length >= 3 && hay.includes(t.repoLabel.toLowerCase())) score += 2
    for (const w of t.summary.toLowerCase().split(/\W+/)) {
      if (w.length >= 4 && hay.includes(w)) score += 1
    }
    if (score > 0 && (!best || score > best.score)) best = { id: t.sessionId, score }
  }
  return best ? `${TARGET_PREFIX}mac:${best.id}` : `${TARGET_PREFIX}openclaw`
}
