import { describe, it, expect, mock } from 'bun:test'
import { Classifier } from './classifier'
import type { LLMClient } from './client'
import type { ClassifierInput } from './types'

function mockLLM(response: Record<string, unknown>): LLMClient {
  return {
    chatCompletion: mock().mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'classify_gtd_item',
                  arguments: JSON.stringify(response),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  } as unknown as LLMClient
}

describe('Classifier', () => {
  const input: ClassifierInput = {
    text: 'Buy milk on the way home',
    sourceChannel: 'telegram_dm',
    capturedAt: '2026-04-12T18:00:00Z',
  }

  it('parses a next-action classification', async () => {
    const classifier = new Classifier(
      mockLLM({
        category: 'next',
        is_noise: false,
        suggested_contexts: ['@errands'],
        suggested_tags: ['shopping'],
        is_project: false,
        is_delegation: false,
        confidence: 0.92,
        reasoning: 'Clear single-step actionable task',
      })
    )

    const result = await classifier.classify(input)

    expect(result.category).toBe('next')
    expect(result.confidence).toBe(0.92)
    expect(result.suggested_contexts).toEqual(['@errands'])
    expect(result.is_noise).toBe(false)
  })

  it('handles two_minute category', async () => {
    const classifier = new Classifier(
      mockLLM({
        category: 'two_minute',
        is_noise: false,
        suggested_contexts: ['@phone'],
        suggested_tags: [],
        is_project: false,
        is_delegation: false,
        confidence: 0.85,
        reasoning: 'Quick call, under 2 min',
      })
    )

    const result = await classifier.classify(input)
    expect(result.category).toBe('two_minute')
  })

  it('handles noise items', async () => {
    const classifier = new Classifier(
      mockLLM({
        category: 'reference',
        is_noise: true,
        noise_reason: 'Advertisement',
        suggested_contexts: [],
        suggested_tags: [],
        is_project: false,
        is_delegation: false,
        confidence: 0.95,
        reasoning: 'Spam/ad content',
      })
    )

    const result = await classifier.classify(input)
    expect(result.is_noise).toBe(true)
    expect(result.noise_reason).toBe('Advertisement')
  })

  it('handles delegation', async () => {
    const classifier = new Classifier(
      mockLLM({
        category: 'waiting',
        is_noise: false,
        suggested_contexts: [],
        suggested_tags: [],
        is_project: false,
        is_delegation: true,
        delegate_to: 'Alice',
        confidence: 0.88,
        reasoning: 'Waiting for Alice to send PDF',
      })
    )

    const result = await classifier.classify(input)
    expect(result.is_delegation).toBe(true)
    expect(result.delegate_to).toBe('Alice')
    expect(result.category).toBe('waiting')
  })

  it('throws when LLM does not return tool call', async () => {
    const classifier = new Classifier({
      chatCompletion: mock().mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'no tool call' }, finish_reason: 'stop' }],
      }),
    } as unknown as LLMClient)

    await expect(classifier.classify(input)).rejects.toThrow('did not return expected tool call')
  })

  it('throws on invalid JSON in tool call', async () => {
    const classifier = new Classifier({
      chatCompletion: mock().mockResolvedValue({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'classify_gtd_item', arguments: 'not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    } as unknown as LLMClient)

    await expect(classifier.classify(input)).rejects.toThrow('Failed to parse')
  })
})
