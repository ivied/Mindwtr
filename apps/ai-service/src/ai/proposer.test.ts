import { describe, it, expect, mock } from 'bun:test'
import { Proposer } from './proposer'
import type { LLMClient } from './client'

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
  it('parses actionable proposal', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: 'Pay Acme invoice',
        reasoning: 'Invoice due tomorrow visible on screen',
        confidence: 0.92,
      })
    )
    const result = await p.propose('Invoice from Acme due 2026-04-25, $500', {
      app: 'Mail',
    })
    expect(result.is_actionable).toBe(true)
    expect(result.title).toBe('Pay Acme invoice')
    expect(result.confidence).toBe(0.92)
  })

  it('parses non-actionable proposal', async () => {
    const p = new Proposer(
      mockLLM({
        is_actionable: false,
        title: '',
        reasoning: 'Just code on screen',
        confidence: 0.95,
      })
    )
    const result = await p.propose('function main() { return 42 }')
    expect(result.is_actionable).toBe(false)
    expect(result.title).toBe('')
  })

  it('truncates title to 120 chars', async () => {
    const long = 'a'.repeat(200)
    const p = new Proposer(
      mockLLM({
        is_actionable: true,
        title: long,
        reasoning: 'r',
        confidence: 0.9,
      })
    )
    const result = await p.propose('text')
    expect(result.title.length).toBe(120)
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

  it('coerces missing fields to safe defaults', async () => {
    const p = new Proposer(mockLLM({}))
    const result = await p.propose('text')
    expect(result.is_actionable).toBe(false)
    expect(result.title).toBe('')
    expect(result.reasoning).toBe('')
    expect(result.confidence).toBe(0)
  })
})
