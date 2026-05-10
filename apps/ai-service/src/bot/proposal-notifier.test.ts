import { describe, it, expect, mock } from 'bun:test'
import { ProposalNotifier } from './proposal-notifier'
import type { Bot } from 'grammy'
import type { ProposalRecord } from '../proposal-store/types'
import type { CreatePayload, ModifyPayload } from '../proposal-store/payloads'

function makeBot(): { bot: Bot; sendMessage: ReturnType<typeof mock> } {
  const sendMessage = mock(async () => ({ message_id: 1 }))
  const bot = { api: { sendMessage } } as unknown as Bot
  return { bot, sendMessage }
}

function makeProposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  const payload: CreatePayload = {
    kind: 'create',
    task: { title: 'Pay invoice', status: 'inbox', tags: [], description: 'D', metadata: {} },
    traceback: { captureExcerpt: 'invoice email', sourceChannel: 'screen_capture' },
  }
  return {
    id: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'create',
    targetTaskIds: [],
    sourceCaptureId: null,
    sourceAgent: 'commitment-detector',
    status: 'pending',
    currentPayload: payload,
    currentVersion: 1,
    originSnapshot: null,
    createdAt: '2026-05-06T00:00:00Z',
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  }
}

const WEB = 'http://localhost:5173'

describe('ProposalNotifier', () => {
  it('disabled when notifyChatId is empty', async () => {
    const { bot, sendMessage } = makeBot()
    const n = new ProposalNotifier({ bot, notifyChatId: '', webBaseUrl: WEB })
    expect(n.enabled).toBe(false)
    await n.notifyCreated(makeProposal())
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('sends a TG message with single Open-in-Mindwtr deep-link button', async () => {
    const { bot, sendMessage } = makeBot()
    const n = new ProposalNotifier({ bot, notifyChatId: '12345', webBaseUrl: WEB })
    await n.notifyCreated(makeProposal())

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const args = sendMessage.mock.calls[0]
    expect(args[0]).toBe('12345')

    const text = args[1] as string
    expect(text).toContain('AI Proposal')
    expect(text).toContain('Pay invoice')

    const opts = args[2] as {
      reply_markup: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] }
    }
    const buttons = opts.reply_markup.inline_keyboard.flat()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text).toContain('Open')
    expect(buttons[0]!.url).toBe(
      'http://localhost:5173/?view=inbox&id=aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee'
    )
    // No approve / reject / comment / open callbacks anymore.
    expect(buttons.some((b) => b.callback_data)).toBe(false)
  })

  it('strips trailing slash from webBaseUrl', async () => {
    const { bot, sendMessage } = makeBot()
    const n = new ProposalNotifier({ bot, notifyChatId: '1', webBaseUrl: 'http://x.com/' })
    await n.notifyCreated(makeProposal())
    const opts = sendMessage.mock.calls[0][2] as {
      reply_markup: { inline_keyboard: { url?: string }[][] }
    }
    const url = opts.reply_markup.inline_keyboard.flat()[0]!.url!
    expect(url.startsWith('http://x.com/?view=inbox')).toBe(true)
    expect(url.startsWith('http://x.com//')).toBe(false)
  })

  it('renders modify diff fields in body', async () => {
    const { bot, sendMessage } = makeBot()
    const n = new ProposalNotifier({ bot, notifyChatId: '12345', webBaseUrl: WEB })
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: 't1',
      diff: [{ field: 'title', from: 'Old', to: 'New' }],
    }
    await n.notifyCreated(makeProposal({ type: 'modify', targetTaskIds: ['t1'], currentPayload: payload }))
    const text = sendMessage.mock.calls[0][1] as string
    expect(text).toContain('Modify task')
    expect(text).toContain('title')
    expect(text).toContain('Old')
    expect(text).toContain('New')
  })

  it('swallows TG errors instead of throwing', async () => {
    const sendMessage = mock(async () => {
      throw new Error('TG offline')
    })
    const bot = { api: { sendMessage } } as unknown as Bot
    const n = new ProposalNotifier({ bot, notifyChatId: '12345', webBaseUrl: WEB })
    await n.notifyCreated(makeProposal())
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('notifyResolved sends short status update without keyboard', async () => {
    const { bot, sendMessage } = makeBot()
    const n = new ProposalNotifier({ bot, notifyChatId: '12345', webBaseUrl: WEB })
    await n.notifyResolved(makeProposal(), 'rejected')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const opts = sendMessage.mock.calls[0][2] as { reply_markup?: unknown }
    expect(opts.reply_markup).toBeUndefined()
    expect(sendMessage.mock.calls[0][1]).toContain('rejected')
  })
})
