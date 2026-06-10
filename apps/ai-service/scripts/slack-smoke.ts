#!/usr/bin/env node
/**
 * Smoke-test for the Slack adapter — runs the REAL SlackChannel against live
 * workspace tokens, but with an in-memory cursor store and a sink that just
 * prints what would be captured. No DB, no Mindwtr, no inbox writes.
 *
 * It exercises the actual polling logic (bootstrap, cursor compare, filters,
 * push/pull classification) so we see real CapturedItems without standing up
 * the whole service.
 *
 * Two passes:
 *   Pass 1 — bootstrap: every conversation gets its cursor set to "now",
 *            zero captures (we don't backfill the archive).
 *   Pass 2 — after we rewind cursors by REWIND_MS, the adapter treats recent
 *            history as "new" and emits CapturedItems, so we can see real text.
 *
 * Usage:
 *   SLACK_USER_TOKENS=xoxp-a,xoxp-b node --experimental-strip-types scripts/slack-smoke.ts
 */

import { SlackChannel } from '../src/channels/slack.ts'
import type { CapturedItem } from '../src/capture/normalizer.ts'

// Treat last N hours as "new" in pass 2 (default 24h; search mode pulls every
// message in the window, so keep it short).
const REWIND_MS = Number(process.env.SMOKE_REWIND_HOURS ?? 24) * 3600_000

const tokens = (process.env.SLACK_USER_TOKENS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

if (tokens.length === 0) {
  console.error('SLACK_USER_TOKENS is required (comma-separated xoxp-...)')
  process.exit(1)
}

// In-memory cursor store implementing the adapter's ConversationCursorStore.
class MemCursors {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, ts: string): Promise<void> {
    this.map.set(key, ts)
  }
  /** Rewind every cursor by ms so the next poll sees recent history as new. */
  rewindAll(ms: number): void {
    for (const [k, ts] of this.map) {
      const [sec, micro] = ts.split('.')
      const newSec = Number(sec) - Math.floor(ms / 1000)
      this.map.set(k, `${newSec}.${micro ?? '000000'}`)
    }
  }
  get size(): number {
    return this.map.size
  }
}

const captured: CapturedItem[] = []
const sink = async (item: CapturedItem): Promise<void> => {
  captured.push(item)
}

async function main(): Promise<void> {
  const cursors = new MemCursors()
  const channel = new SlackChannel(
    {
      workspaces: tokens.map((token) => ({ token })),
      pollIntervalMs: 60_000,
      pacingMs: Number(process.env.SMOKE_PACING_MS ?? 300),
      maxHistoryPerCycle: Number(process.env.SMOKE_MAX_HISTORY ?? 6),
    },
    sink,
    cursors
  )

  console.log('=== start (auth all workspaces) ===')
  await channel.start()
  // start() schedules the first loop on a timer; we drive poll() manually
  // instead by reaching into the workspaces. Stop the timer first.
  await channel.stop()

  // Access the private workspaces array to drive a deterministic poll.
  // (Smoke test only — not how prod runs.)
  const workspaces = (channel as unknown as { workspaces: Array<{ poll: () => Promise<void>; teamName: string }> })
    .workspaces

  console.log(`\n=== PASS 1: bootstrap (${workspaces.length} workspace(s)) ===`)
  for (const ws of workspaces) {
    await ws.poll()
    console.log(`  ${ws.teamName}: bootstrap done`)
  }
  console.log(`  cursors saved: ${cursors.size}`)
  console.log(`  captures so far (should be 0): ${captured.length}`)

  console.log(`\n=== PASS 2: rewind ${REWIND_MS / 86400000}d, re-poll ===`)
  cursors.rewindAll(REWIND_MS)
  captured.length = 0
  for (const ws of workspaces) {
    await ws.poll()
    console.log(`  ${ws.teamName}: re-poll done`)
  }

  console.log(`\n=== CAPTURED ITEMS (${captured.length}) ===`)
  const byChannel = new Map<string, number>()
  for (const item of captured) {
    byChannel.set(item.sourceChannel, (byChannel.get(item.sourceChannel) ?? 0) + 1)
  }
  for (const [ch, n] of byChannel) console.log(`  ${ch}: ${n}`)

  console.log('\n  sample (first 12):')
  for (const item of captured.slice(0, 12)) {
    const meta = item.sourceMeta as { workspace?: string; channelName?: string; isDm?: boolean }
    const where = meta.isDm ? `DM` : `#${meta.channelName ?? '?'}`
    const text = item.text.replace(/\s+/g, ' ').slice(0, 70)
    console.log(`    [${meta.workspace}] ${where} :: ${text}`)
  }
}

main().catch((err) => {
  console.error('smoke failed:', err)
  process.exit(1)
})
