import { describe, it, expect, mock } from 'bun:test'
import { Enricher } from './enricher'
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
                  name: 'enrich_inbox_card',
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

const HAPPY: Record<string, unknown> = {
  is_actionable: true,
  proposed_title: 'Text nanny about Saturday 7pm',
  category: 'two_minute',
  is_project: false,
  project_name: '',
  sub_actions: [],
  suggested_contexts: ['@phone'],
  suggested_tags: ['family'],
  smart: {
    specific: 'Nanny confirmed for Saturday 7pm',
    time_bound: 'Saturday',
    measurable: 'Nanny confirmed for Saturday 7pm',
  },
  is_noise: false,
  noise_reason: '',
  is_delegation: false,
  delegate_to: '',
  confidence: 0.93,
  reasoning: 'Single-step short message, classic 2-min rule',
}

describe('Enricher', () => {
  it('parses a 2-minute card with title rewrite', async () => {
    const e = new Enricher(mockLLM(HAPPY))
    const result = await e.enrich('позвать няню на субботу')
    expect(result.is_actionable).toBe(true)
    expect(result.proposed_title).toBe('Text nanny about Saturday 7pm')
    expect(result.category).toBe('two_minute')
    expect(result.is_project).toBe(false)
    expect(result.sub_actions).toEqual([])
    expect(result.smart.specific).toBe('Nanny confirmed for Saturday 7pm')
    expect(result.smart.time_bound).toBe('Saturday')
    expect(result.suggested_contexts).toEqual(['@phone'])
    expect(result.confidence).toBe(0.93)
  })

  it('parses a multi-step project with sub-actions', async () => {
    const e = new Enricher(
      mockLLM({
        ...HAPPY,
        proposed_title: 'Renovate bathroom',
        category: 'next',
        is_project: true,
        project_name: 'Bathroom renovation',
        sub_actions: [
          { title: 'Measure bathroom and list required works', suggested_category: 'next' },
          { title: 'Get 3 contractor quotes', suggested_category: 'next' },
        ],
        smart: {
          specific: 'Bathroom fully renovated',
          time_bound: 'no deadline',
          measurable: 'All rooms repainted, contractor paid, no leaks',
        },
      })
    )
    const result = await e.enrich('renovate the bathroom')
    expect(result.is_project).toBe(true)
    expect(result.project_name).toBe('Bathroom renovation')
    expect(result.sub_actions.length).toBe(2)
    expect(result.sub_actions[0]!.title).toBe('Measure bathroom and list required works')
    expect(result.sub_actions[0]!.suggested_category).toBe('next')
    expect(result.smart.measurable).toContain('contractor paid')
  })

  it('passes priorContext to the LLM as Past similar items', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = []
    const llm = {
      chatCompletion: mock(async (req: { messages: Array<{ role: string; content: string }> }) => {
        capturedMessages = req.messages
        return {
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
                      name: 'enrich_inbox_card',
                      arguments: JSON.stringify(HAPPY),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
      }),
    } as unknown as LLMClient
    const e = new Enricher(llm)
    await e.enrich('call vet', { priorContext: '- Call dentist [@phone, two_minute]' })
    const userMsg = capturedMessages.find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('Past similar items:')
    expect(userMsg.content).toContain('Call dentist')
    expect(userMsg.content).toContain('Card text:')
    expect(userMsg.content).toContain('call vet')
  })

  it('includes sourceMeta when provided', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = []
    const llm = {
      chatCompletion: mock(async (req: { messages: Array<{ role: string; content: string }> }) => {
        capturedMessages = req.messages
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'enrich_inbox_card', arguments: JSON.stringify(HAPPY) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
      }),
    } as unknown as LLMClient
    const e = new Enricher(llm)
    await e.enrich('text', { sourceMeta: { channel: 'telegram_dm' } })
    const userMsg = capturedMessages.find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('Source context:')
    expect(userMsg.content).toContain('telegram_dm')
  })

  it('coerces invalid category to "next"', async () => {
    const e = new Enricher(mockLLM({ ...HAPPY, category: 'garbage' }))
    const result = await e.enrich('text')
    expect(result.category).toBe('next')
  })

  it('truncates proposed_title to 120 chars', async () => {
    const e = new Enricher(mockLLM({ ...HAPPY, proposed_title: 'a'.repeat(200) }))
    const result = await e.enrich('text')
    expect(result.proposed_title.length).toBe(120)
  })

  it('drops sub_actions with empty title and caps at 5', async () => {
    const e = new Enricher(
      mockLLM({
        ...HAPPY,
        is_project: true,
        project_name: 'P',
        sub_actions: [
          { title: 'one', suggested_category: 'next' },
          { title: '', suggested_category: 'next' },
          { title: 'two', suggested_category: 'next' },
          { title: 'three', suggested_category: 'two_minute' },
          { title: 'four', suggested_category: 'next' },
          { title: 'five', suggested_category: 'next' },
          { title: 'six', suggested_category: 'next' },
        ],
      })
    )
    const result = await e.enrich('x')
    expect(result.sub_actions.length).toBe(5)
    expect(result.sub_actions.map((s) => s.title)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ])
  })

  it('defaults invalid sub_action category to "next"', async () => {
    const e = new Enricher(
      mockLLM({
        ...HAPPY,
        is_project: true,
        sub_actions: [{ title: 'foo', suggested_category: 'banana' }],
      })
    )
    const result = await e.enrich('x')
    expect(result.sub_actions[0]!.suggested_category).toBe('next')
  })

  it('defaults is_actionable=true when omitted (explicit user input)', async () => {
    const { is_actionable: _omit, ...without } = HAPPY
    void _omit
    const e = new Enricher(mockLLM(without))
    const result = await e.enrich('x')
    expect(result.is_actionable).toBe(true)
  })

  it('defaults time_bound to "no deadline" when empty', async () => {
    const e = new Enricher(
      mockLLM({ ...HAPPY, smart: { specific: 's', time_bound: '', measurable: 'm' } })
    )
    const result = await e.enrich('x')
    expect(result.smart.time_bound).toBe('no deadline')
  })

  it('clamps confidence outside [0,1] to 0', async () => {
    const e = new Enricher(mockLLM({ ...HAPPY, confidence: 1.5 }))
    const result = await e.enrich('x')
    expect(result.confidence).toBe(0)
  })

  it('throws when LLM does not return tool call', async () => {
    const llm = {
      chatCompletion: mock(async () => ({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      })),
    } as unknown as LLMClient
    const e = new Enricher(llm)
    await expect(e.enrich('text')).rejects.toThrow('did not return tool call')
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
                  function: { name: 'enrich_inbox_card', arguments: 'not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })),
    } as unknown as LLMClient
    const e = new Enricher(llm)
    await expect(e.enrich('text')).rejects.toThrow('failed to parse')
  })

  it('uses provided model override in the LLM call', async () => {
    let capturedRequest: { model?: string } = {}
    const llm = {
      chatCompletion: mock(async (req: { model?: string }) => {
        capturedRequest = req
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'enrich_inbox_card', arguments: JSON.stringify(HAPPY) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
      }),
    } as unknown as LLMClient
    const e = new Enricher(llm, 'cc/claude-opus-4-6')
    await e.enrich('x')
    expect(capturedRequest.model).toBe('cc/claude-opus-4-6')
  })
})
