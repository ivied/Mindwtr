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
