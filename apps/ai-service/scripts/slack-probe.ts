#!/usr/bin/env bun
/**
 * Read-only Slack probe — verifies what a user token (xoxp-) can actually see
 * across one workspace, and how close we get to the rate limit, BEFORE we
 * rewrite the channel adapter to poll 10 workspaces.
 *
 * Nothing here writes to Slack or to our DB. It only reads and prints a report.
 *
 * Usage:
 *   SLACK_USER_TOKEN=xoxp-... bun run scripts/slack-probe.ts
 *   SLACK_USER_TOKEN=xoxp-... bun run scripts/slack-probe.ts --channels=2 --messages=10
 *
 * Env:
 *   SLACK_USER_TOKEN — your xoxp- user token (required). Never commit it.
 *
 * Flags:
 *   --channels=N — how many non-DM channels to sample history from (default 2)
 *   --messages=N — how many recent messages to fetch per conversation (default 5)
 *   --dms=N      — how many DM conversations to sample (default 3)
 */

import { WebClient } from '@slack/web-api'

interface Flags {
  channels: number
  messages: number
  dms: number
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    if (!hit) return fallback
    const n = Number(hit.split('=')[1])
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    channels: get('channels', 2),
    messages: get('messages', 5),
    dms: get('dms', 3),
  }
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`)
}

async function main(): Promise<void> {
  const token = process.env.SLACK_USER_TOKEN
  if (!token) {
    console.error('SLACK_USER_TOKEN is required (xoxp-...)')
    process.exit(1)
  }
  if (!token.startsWith('xoxp-')) {
    console.warn(
      `[warn] token does not start with "xoxp-" — for "see what I see" you want a USER token, not a bot token (xoxb-).`
    )
  }

  const flags = parseFlags(process.argv.slice(2))
  const web = new WebClient(token)

  // Track rate-limit hits across the whole run.
  let rateLimited = 0
  const startedAt = Date.now()
  let apiCalls = 0
  async function call<T>(fn: () => Promise<T>, what: string): Promise<T | null> {
    apiCalls++
    try {
      return await fn()
    } catch (err) {
      const e = err as { data?: { error?: string }; code?: string }
      const code = e.data?.error ?? e.code ?? 'unknown'
      if (code === 'ratelimited' || code === 'rate_limited') rateLimited++
      console.error(`  [error] ${what}: ${code}`)
      return null
    }
  }

  // 1. Who am I / which workspace.
  console.log('\n=== 1. auth.test (identity) ===')
  const auth = await call(() => web.auth.test(), 'auth.test')
  if (!auth) {
    console.error('auth.test failed — token invalid or missing scopes. Stopping.')
    process.exit(1)
  }
  line('user', auth.user)
  line('user_id', auth.user_id)
  line('team (workspace)', auth.team)
  line('team_id', auth.team_id)
  line('url', auth.url)

  // 2. What conversations are visible (DMs, public, private, group DMs).
  console.log('\n=== 2. conversations.list (visibility) ===')
  const convs = await call(
    () =>
      web.conversations.list({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
      }),
    'conversations.list'
  )

  const all = convs?.channels ?? []
  const dms = all.filter((c) => (c as { is_im?: boolean }).is_im)
  const mpims = all.filter((c) => (c as { is_mpim?: boolean }).is_mpim)
  const privates = all.filter(
    (c) => (c as { is_private?: boolean; is_im?: boolean; is_mpim?: boolean }).is_private && !(c as { is_im?: boolean }).is_im && !(c as { is_mpim?: boolean }).is_mpim
  )
  const publics = all.filter(
    (c) =>
      !(c as { is_private?: boolean }).is_private &&
      !(c as { is_im?: boolean }).is_im &&
      !(c as { is_mpim?: boolean }).is_mpim
  )
  line('total visible', all.length)
  line('DMs (im)', dms.length)
  line('group DMs (mpim)', mpims.length)
  line('private channels', privates.length)
  line('public channels', publics.length)
  if (all.length === 200) {
    console.log('  [note] hit page_size=200 — more exist (pagination not followed in probe)')
  }

  // Resolve a few user names for nicer DM output (best-effort).
  async function userName(id: string | undefined): Promise<string> {
    if (!id) return '?'
    const info = await call(() => web.users.info({ user: id }), `users.info ${id}`)
    const u = info?.user as { real_name?: string; name?: string } | undefined
    return u?.real_name ?? u?.name ?? id
  }

  // 3. Sample DM history.
  console.log('\n=== 3. DM history sample ===')
  for (const dm of dms.slice(0, flags.dms)) {
    const id = (dm as { id?: string }).id
    const peer = await userName((dm as { user?: string }).user)
    const hist = await call(
      () => web.conversations.history({ channel: id as string, limit: flags.messages }),
      `conversations.history (dm ${id})`
    )
    const msgs = (hist?.messages ?? []) as Array<{ text?: string; ts?: string; user?: string }>
    console.log(`  DM with ${peer} (${id}) — ${msgs.length} recent msgs:`)
    for (const m of msgs) {
      const txt = (m.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
      console.log(`    · ${txt || '<no text>'}`)
    }
  }

  // 4. Sample channel history.
  console.log('\n=== 4. Channel history sample ===')
  const sampleChannels = [...publics, ...privates].slice(0, flags.channels)
  for (const ch of sampleChannels) {
    const id = (ch as { id?: string }).id
    const name = (ch as { name?: string }).name ?? id
    const hist = await call(
      () => web.conversations.history({ channel: id as string, limit: flags.messages }),
      `conversations.history (channel ${id})`
    )
    const msgs = (hist?.messages ?? []) as Array<{ text?: string; ts?: string; user?: string }>
    console.log(`  #${name} (${id}) — ${msgs.length} recent msgs:`)
    for (const m of msgs) {
      const txt = (m.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
      console.log(`    · ${txt || '<no text>'}`)
    }
  }

  // 4b. DM deep-dive with pagination — conversations.list(limit=200) may not
  //     return im conversations on the first page. Page through types=im only,
  //     sorted by recency, to settle "I have lots of DMs but probe showed 0".
  console.log('\n=== 4b. DM deep-dive (im, paginated) ===')
  const ims: Array<{ id?: string; user?: string; latest?: { ts?: string } }> = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await call(
      () =>
        web.conversations.list({
          types: 'im',
          exclude_archived: true,
          limit: 200,
          cursor,
        }),
      `conversations.list(im) page ${pages + 1}`
    )
    if (!page) break
    for (const c of page.channels ?? []) ims.push(c as { id?: string; user?: string })
    cursor = page.response_metadata?.next_cursor || undefined
    pages++
  } while (cursor && pages < 5)
  line('total im (paginated)', ims.length)
  line('pages walked', pages)

  // 4c. "Where are new messages?" — the core adapter signal. For a sample of
  //     conversations, read the latest message ts WITHOUT pulling full history
  //     (limit=1). This is the cheap per-cycle check the poller will use.
  console.log('\n=== 4c. Activity signal (latest ts per conversation, limit=1) ===')
  const sample = [...ims.slice(0, 5), ...publics.slice(0, 5)]
  const activity: Array<{ id: string; label: string; lastTs: string }> = []
  for (const c of sample) {
    const id = (c as { id?: string }).id
    if (!id) continue
    const isIm = !!(c as { is_im?: boolean }).is_im || ims.includes(c as { id?: string })
    const label = isIm
      ? `dm:${await userName((c as { user?: string }).user)}`
      : `#${(c as { name?: string }).name ?? id}`
    const hist = await call(
      () => web.conversations.history({ channel: id, limit: 1 }),
      `latest ts ${id}`
    )
    const ts = ((hist?.messages ?? [])[0] as { ts?: string } | undefined)?.ts
    if (ts) {
      const when = new Date(Number(ts.split('.')[0]) * 1000).toISOString()
      activity.push({ id, label, lastTs: when })
    }
  }
  activity.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
  for (const a of activity) console.log(`  ${a.lastTs}  ${a.label}`)
  console.log(
    '  [note] poller compares this latest-ts against a saved cursor per conversation;\n' +
      '         only fetches full history where latest-ts moved. Silent channels cost ~0.'
  )

  // 4d. conversations.info on DMs — does it expose unread_count / last_read?
  //     If yes, the poller uses this as the cheap "has new?" signal for DMs
  //     (no need to pull history just to check), then conversations.history
  //     with oldest=last_read to fetch only the unread tail.
  console.log('\n=== 4d. conversations.info unread signal (DMs) ===')
  let infoHasUnread = 0
  for (const dm of ims.slice(0, 8)) {
    const id = (dm as { id?: string }).id
    if (!id) continue
    const info = await call(
      () => web.conversations.info({ channel: id }),
      `conversations.info ${id}`
    )
    const ch = info?.channel as
      | { unread_count?: number; last_read?: string; user?: string }
      | undefined
    if (!ch) continue
    const hasUnreadField = ch.unread_count !== undefined
    if (hasUnreadField) infoHasUnread++
    const peer = await userName(ch.user)
    console.log(
      `  dm:${peer.padEnd(16)} unread_count=${ch.unread_count ?? '<absent>'} last_read=${ch.last_read ?? '<absent>'}`
    )
  }
  console.log(
    infoHasUnread > 0
      ? `  [ok] unread_count present on ${infoHasUnread}/8 — poller can use it as the cheap DM signal.`
      : '  [!] unread_count absent — fall back to latest-ts vs saved cursor (still works, just no native unread).'
  )

  // 5. Rate-limit / timing summary.
  console.log('\n=== 5. Summary ===')
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1)
  line('API calls made', apiCalls)
  line('elapsed (s)', elapsedS)
  line('rate-limited hits', rateLimited)
  console.log(
    rateLimited > 0
      ? '  [!] Hit rate limit — polling cadence for this workspace must be conservative.'
      : '  [ok] No rate-limit hits in this probe.'
  )
  console.log(
    '\nNote: conversations.history with a user token is capped at ~5 req/min per workspace.\n' +
      'A real poll cycle should touch only DMs + a few chosen channels, not every channel.\n'
  )
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})
