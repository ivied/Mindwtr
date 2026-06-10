/**
 * Read-only probe: can search.messages act as a "what's new" detector?
 *
 * For each workspace token, run `search.messages` with `after:<date>` sorted
 * by timestamp desc, and report: result shape, channel attribution, whether
 * DMs are included, pagination, and the rate-limit tier behavior.
 *
 * Usage: SLACK_USER_TOKENS=xoxp-...,xoxp-... npx tsx slack-search-probe.ts
 */

import { WebClient } from '@slack/web-api'

interface SearchMatch {
  type?: string
  ts?: string
  text?: string
  user?: string
  username?: string
  team?: string
  channel?: {
    id?: string
    name?: string
    is_im?: boolean
    is_mpim?: boolean
    is_private?: boolean
    is_channel?: boolean
    is_group?: boolean
  }
  permalink?: string
}

async function probeWorkspace(token: string): Promise<void> {
  const web = new WebClient(token)
  const auth = await web.auth.test()
  const team = auth.team as string
  const selfId = auth.user_id as string
  console.log(`\n=== Workspace: ${team} (self=${selfId}) ===`)

  const after = new Date(Date.now() - 48 * 3600_000)
  const afterStr = after.toISOString().slice(0, 10)
  console.log(`query: after:${afterStr} (last ~48h)`) // search 'after' is date-granular

  const t0 = Date.now()
  let page = 1
  let total = 0
  const channelKinds = new Map<string, number>()
  const samples: string[] = []
  let reportedTotal = 0

  while (page <= 5) {
    const res = await web.search.messages({
      query: `after:${afterStr}`,
      sort: 'timestamp',
      sort_dir: 'desc',
      count: 100,
      page,
    })
    const m = res.messages as
      | { total?: number; matches?: SearchMatch[]; paging?: { pages?: number; page?: number } }
      | undefined
    reportedTotal = m?.total ?? 0
    const matches = m?.matches ?? []
    total += matches.length

    for (const match of matches) {
      const ch = match.channel
      const kind = ch?.is_im
        ? 'im'
        : ch?.is_mpim
          ? 'mpim'
          : ch?.is_private || ch?.is_group
            ? 'private_channel'
            : 'public_channel'
      channelKinds.set(kind, (channelKinds.get(kind) ?? 0) + 1)
      if (samples.length < 8) {
        samples.push(
          `[${kind}] #${ch?.name ?? ch?.id} @${match.username ?? match.user} ts=${match.ts} "${(match.text ?? '').slice(0, 80).replaceAll('\n', ' ')}"`
        )
      }
    }

    const pages = m?.paging?.pages ?? 1
    console.log(`page ${page}/${pages}: ${matches.length} matches`)
    if (page >= pages) break
    page++
  }

  console.log(`reported total: ${reportedTotal}, fetched: ${total} in ${Date.now() - t0}ms`)
  console.log('by kind:', Object.fromEntries(channelKinds))
  console.log('samples:')
  for (const s of samples) console.log('  ', s)

  console.log('\n-- rate limit check: 5 rapid calls --')
  for (let i = 0; i < 5; i++) {
    const t = Date.now()
    try {
      await web.search.messages({ query: `after:${afterStr}`, count: 1 })
      console.log(`  call ${i + 1}: ok (${Date.now() - t}ms)`)
    } catch (err) {
      const e = err as { code?: string; retryAfter?: number }
      console.log(`  call ${i + 1}: ERROR code=${e.code} retryAfter=${e.retryAfter}`)
      break
    }
  }

  console.log('\n-- ts-precision check: after with unix ts in query? --')
  // search 'after:' only takes dates; check whether matches carry exact ts we
  // can client-side filter on (they should — every match has .ts).
  const res = await web.search.messages({
    query: `after:${afterStr}`,
    sort: 'timestamp',
    sort_dir: 'desc',
    count: 3,
  })
  const matches = ((res.messages as { matches?: SearchMatch[] } | undefined)?.matches ?? [])
  console.log(
    'top-3 ts:',
    matches.map((x) => x.ts)
  )
}

async function main(): Promise<void> {
  const tokens = (process.env.SLACK_USER_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.length === 0) {
    console.error('SLACK_USER_TOKENS empty')
    process.exit(1)
  }
  for (const token of tokens) {
    try {
      await probeWorkspace(token)
    } catch (err) {
      console.error('workspace probe failed:', err)
    }
  }
}

void main()
