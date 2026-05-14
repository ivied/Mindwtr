import { describe, it, expect, mock } from 'bun:test'
import { Proposer } from './proposer'
import type { LLMClient } from '../ai/client'

function mockLLM(args: Record<string, unknown>): LLMClient {
  return {
    chatCompletion: mock(async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'propose_inbox_item',
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })),
  } as unknown as LLMClient
}

describe('Proposer', () => {
  it('parses actionable user proposal with full schema', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: 'Pay Acme invoice',
        who_owes: 'user',
        who_to: 'Acme',
        what: 'Pay invoice from Acme due Friday',
        by_when: 'Friday',
        confidence: 0.92,
        reasoning: 'Invoice with explicit due date addressed to user',
      })
    )
    const result = await p.propose('Invoice from Acme due 2026-04-25, $500', { app: 'Mail' })
    expect(result.is_actionable).toBe(true)
    expect(result.title).toBe('Pay Acme invoice')
    expect(result.who_owes).toBe('user')
    expect(result.who_to).toBe('Acme')
    expect(result.by_when).toBe('Friday')
    expect(result.confidence).toBe(0.92)
  })

  it('marks who_owes=other when commitment belongs to someone else', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: 'Wait for Alice review',
        who_owes: 'other',
        who_to: 'Alice',
        what: 'Alice promised to review PR',
        by_when: '',
        confidence: 0.8,
        reasoning: 'Other party committed, user does not need to act',
      })
    )
    const result = await p.propose("Alice: I'll review the PR by EOD")
    expect(result.who_owes).toBe('other')
  })

  it('parses non-actionable proposal', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: false,
        title: '',
        who_owes: 'unclear',
        who_to: '',
        what: '',
        by_when: '',
        confidence: 0.95,
        reasoning: 'Just code on screen',
      })
    )
    const result = await p.propose('function main() { return 42 }')
    expect(result.is_actionable).toBe(false)
    expect(result.title).toBe('')
    expect(result.who_to).toBeNull()
    expect(result.by_when).toBeNull()
  })

  it('truncates title to 120 chars', async () => {
    const long = 'a'.repeat(200)
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: long,
        who_owes: 'user',
        who_to: '',
        what: 'x',
        by_when: '',
        confidence: 0.9,
        reasoning: 'r',
      })
    )
    const result = await p.propose('text')
    expect(result.title.length).toBe(120)
  })

  it('coerces invalid who_owes to "unclear"', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: 'X',
        who_owes: 'garbage',
        who_to: '',
        what: 'x',
        by_when: '',
        confidence: 0.8,
        reasoning: 'r',
      })
    )
    const result = await p.propose('text')
    expect(result.who_owes).toBe('unclear')
  })

  it('throws when LLM does not return tool call', async () => {
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      })),
    } as unknown as LLMClient
    const p = new Proposer(llm)
    await expect(p.propose('text')).rejects.toThrow('did not return tool call')
  })

  it('renders RECENT_USER_ITEMS block with per-source labels in the user-message', async () => {
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'propose_inbox_item',
                    arguments: JSON.stringify({
                      is_actionable: false,
                      title: '',
                      who_owes: 'unclear',
                      who_to: '',
                      what: '',
                      by_when: '',
                      confidence: 0.9,
                      reasoning: 'noise',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })),
    } as unknown as LLMClient
    const p = new Proposer(llm)
    await p.propose('text', undefined, [
      { title: 'Pay Acme invoice', source: 'inbox' },
      { title: 'Reply to Alice', source: 'pending' },
      {
        title: 'Send weekly report',
        source: 'resolved',
        resolution: 'rejected',
        ageMs: 2 * 24 * 60 * 60 * 1000,
      },
      {
        title: 'Submit timesheet',
        source: 'resolved',
        resolution: 'already-done',
        ageMs: 60 * 60 * 1000,
      },
    ])
    const callArgs = (llm.chatCompletion as unknown as { mock: { calls: Array<Array<{ messages: Array<{ role: string; content: string }> }>> } }).mock.calls[0][0]
    const userMsg = callArgs.messages.find((m) => m.role === 'user')!.content
    expect(userMsg).toContain('RECENT_USER_ITEMS')
    expect(userMsg).toContain('"Pay Acme invoice" [in inbox]')
    expect(userMsg).toContain('"Reply to Alice" [pending AI review]')
    expect(userMsg).toContain('"Send weekly report" [user rejected 2 days ago]')
    expect(userMsg).toContain('"Submit timesheet" [user already done 1 hour ago]')
  })

  it('accepts legacy string[] for recent items and labels them as [in inbox]', async () => {
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'propose_inbox_item',
                    arguments: JSON.stringify({
                      is_actionable: false,
                      title: '',
                      who_owes: 'unclear',
                      who_to: '',
                      what: '',
                      by_when: '',
                      confidence: 0.9,
                      reasoning: 'noise',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })),
    } as unknown as LLMClient
    const p = new Proposer(llm)
    await p.propose('text', undefined, ['Legacy title A', 'Legacy title B'])
    const callArgs = (llm.chatCompletion as unknown as { mock: { calls: Array<Array<{ messages: Array<{ role: string; content: string }> }>> } }).mock.calls[0][0]
    const userMsg = callArgs.messages.find((m) => m.role === 'user')!.content
    expect(userMsg).toContain('RECENT_USER_ITEMS')
    expect(userMsg).toContain('"Legacy title A" [in inbox]')
    expect(userMsg).toContain('"Legacy title B" [in inbox]')
  })

  it('throws on invalid JSON in tool call', async () => {
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'propose_inbox_item', arguments: 'not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })),
    } as unknown as LLMClient
    const p = new Proposer(llm)
    await expect(p.propose('text')).rejects.toThrow('failed to parse')
  })
})
