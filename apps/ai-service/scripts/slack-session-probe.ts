/**
 * Read-only probe for a Slack BROWSER SESSION token (xoxc + d cookie).
 *
 * Use this to validate a session credential for a workspace where you can't
 * install an OAuth app, before wiring it into prod (SLACK_SESSION_TOKENS).
 *
 * How to get the credential (per workspace, in a browser logged into Slack):
 *   xoxc token — DevTools → Console → paste:
 *     JSON.parse(localStorage.localConfig_v2)
 *       .teams[location.pathname.match(/^\/client\/([A-Z0-9]+)/)[1]].token
 *   d cookie  — DevTools → Application → Cookies → app.slack.com → `d`
 *               (value starts with xoxd-)
 *
 * Usage:
 *   SLACK_SESSION_TOKENS='xoxc-...|xoxd-...' npx tsx scripts/slack-session-probe.ts
 *   (multiple pairs comma-separated, same format as the prod env var)
 */

import { WebClient } from '@slack/web-api'

interface SearchMatch {
  ts?: string
  text?: string
  username?: string
  channel?: { name?: string; id?: string; is_im?: boolean; is_mpim?: boolean }
}

function client(token: string, cookie: string): WebClient {
  return new WebClient(token, {
    headers: {
      Cookie: `d=${cookie}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  })
}

async function probe(token: string, cookie: string): Promise<void> {
  const web = client(token, cookie)

  console.log('\n=== auth.test ===')
  const auth = await web.auth.test()
  console.log(`  team: ${auth.team} (${auth.team_id})`)
  console.log(`  user: ${auth.user} (${auth.user_id})`)

  console.log('\n=== search.messages (last 24h) ===')
  const afterStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  try {
    const res = await web.search.messages({
      query: `after:${afterStr}`,
      sort: 'timestamp',
      sort_dir: 'desc',
      count: 10,
    })
    const m = res.messages as { total?: number; matches?: SearchMatch[] } | undefined
    console.log(`  reported total: ${m?.total ?? 0}`)
    for (const match of (m?.matches ?? []).slice(0, 6)) {
      const ch = match.channel
      const where = ch?.is_im || ch?.is_mpim ? 'DM' : `#${ch?.name ?? ch?.id}`
      console.log(
        `    [${where}] @${match.username} ts=${match.ts} "${(match.text ?? '').slice(0, 60).replaceAll('\n', ' ')}"`
      )
    }
    console.log('  → search mode will work for this workspace ✅')
  } catch (err) {
    const e = err as { data?: { error?: string } }
    if (e?.data?.error === 'missing_scope') {
      console.log('  search not available (missing_scope) → falls back to history-rr mode')
    } else {
      console.log('  search failed:', (err as Error).message)
    }
  }
}

async function main(): Promise<void> {
  const pairs = (process.env.SLACK_SESSION_TOKENS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (pairs.length === 0) {
    console.error("SLACK_SESSION_TOKENS empty. Format: 'xoxc-...|xoxd-...'")
    process.exit(1)
  }
  for (const pair of pairs) {
    const [token, cookie] = pair.split('|').map((s) => s.trim())
    if (!token?.startsWith('xoxc-') || !cookie?.startsWith('xoxd-')) {
      console.error(`skipping malformed pair (need xoxc-...|xoxd-...): ${pair.slice(0, 20)}...`)
      continue
    }
    try {
      await probe(token, cookie)
    } catch (err) {
      const e = err as { data?: { error?: string } }
      console.error(`probe failed: ${e?.data?.error ?? (err as Error).message}`)
      if (e?.data?.error === 'invalid_auth') {
        console.error('  → token/cookie expired or mismatched; re-extract both from the same browser session')
      }
    }
  }
}

void main()
