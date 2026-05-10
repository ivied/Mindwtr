/**
 * Telegram /proposals command — awareness-only list of pending proposals.
 *
 * Each row carries a single deep-link button that opens the web UI focused
 * on that proposal. All decisions (approve, reject, comment, dialogue) live
 * in the web; Telegram does NOT host inline keyboards for them anymore — see
 * notes in proposal-notifier.ts for why.
 */

import type { Bot, Context } from 'grammy'
import type { ProposalStore } from '../../proposal-store/store'
import type { ProposalRecord } from '../../proposal-store/types'

const MAX_PROPOSALS_PER_PAGE = 10

export interface ProposalBotDeps {
  store: ProposalStore
  /** Base URL of the Mindwtr web UI; rows link to `<base>/?view=proposals&id=<id>`. */
  webBaseUrl: string
}

export function registerProposalHandlers(bot: Bot, deps: ProposalBotDeps): void {
  bot.command('proposals', async (ctx) => {
    await handleListCommand(ctx, deps)
  })
}

async function handleListCommand(ctx: Context, deps: ProposalBotDeps): Promise<void> {
  const items = deps.store.listPending({ limit: MAX_PROPOSALS_PER_PAGE })
  if (items.length === 0) {
    await ctx.reply('✨ No pending proposals.')
    return
  }
  const base = deps.webBaseUrl.replace(/\/$/, '')
  for (const p of items) {
    await ctx.reply(renderListItem(p), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📂 Open in Mindwtr',
              url: `${base}/?view=inbox&id=${encodeURIComponent(p.id)}`,
            },
          ],
        ],
      },
    })
  }
}

function renderListItem(p: ProposalRecord): string {
  const payload = p.currentPayload as { kind?: string } & Record<string, unknown>
  let label: string = p.type
  if (payload?.kind === 'create' && typeof payload.task === 'object') {
    label = `Create: ${(payload.task as { title?: string }).title ?? ''}`
  } else if (payload?.kind === 'modify' && Array.isArray(payload.diff)) {
    label = `Modify: ${(payload.diff as { field: string }[]).map((d) => d.field).join(', ')}`
  } else if (payload?.kind === 'delete') {
    label = 'Delete task'
  }
  return [
    `🤖 <b>${escapeHtml(label)}</b>`,
    `<i>${escapeHtml(p.sourceAgent)}</i> · v${p.currentVersion}`,
    `<code>${escapeHtml(p.id.slice(0, 8))}</code>`,
  ].join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
