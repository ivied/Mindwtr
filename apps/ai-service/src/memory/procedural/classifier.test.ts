import { describe, it, expect, mock } from 'bun:test'
import { classifyByHeuristic, LlmChunkClassifier } from './classifier'
import type { LLMClient } from '../../ai/client'

describe('classifyByHeuristic', () => {
  it('marks chunks with [[skill_call]] notation as openclaw-only', () => {
    const v = classifyByHeuristic(
      '- ВСЕГДА использовать [[reply_to_current]] для ответа в тред',
      '## Slack'
    )
    expect(v.appliesTo).toBe('openclaw-only')
    expect(v.classifiedBy).toBe('heuristic')
    expect(v.reason).toMatch(/skill call/)
  })

  it('marks chunks with OpenClaw algorithm self-reference as openclaw-only', () => {
    const v = classifyByHeuristic(
      'Шаги: 0 → 1-3 → 4 → 5 → 6 → 7-8 → 9 → 10. Ветки: H1-H4, P1-P2, U1-U4.',
      '## Алгоритм работы'
    )
    expect(v.appliesTo).toBe('openclaw-only')
    expect(v.reason).toMatch(/self-algorithm/)
  })

  it('marks chunks with launchctl as openclaw-only', () => {
    const v = classifyByHeuristic(
      'launchctl bootout gui/$(id -u)/com.openclaw.telegram-monitor',
      '## Telegram через Telethon'
    )
    expect(v.appliesTo).toBe('openclaw-only')
  })

  it('marks NO_REPLY / privacy rules as universal even when channel-ids look opaque', () => {
    const v = classifyByHeuristic(
      'D09RU9JDATY — переписка Сереги с Настей — НЕ вмешиваться, NO_REPLY',
      '## Slack DM каналы — важно'
    )
    expect(v.appliesTo).toBe('universal')
    expect(v.reason).toMatch(/privacy|do-not/)
  })

  it('marks identity / family sections as universal', () => {
    const v = classifyByHeuristic(
      '- **Имя:** Sergey Kurdyuk\n- **Timezone:** America/Buenos_Aires (GMT-3)',
      '## Серега (мой человек)'
    )
    expect(v.appliesTo).toBe('universal')
  })

  it('marks free-form chunks with no signal as needs-review', () => {
    const v = classifyByHeuristic(
      'Some neutral text about a project status without identifying patterns whatsoever, just description.',
      '## Update'
    )
    expect(v.appliesTo).toBe('needs-review')
    expect(v.classifiedBy).toBeNull()
  })

  it('universal wins over openclaw when both patterns hit', () => {
    // Privacy rule that also references an OpenClaw skill name — the
    // rule itself is universal ("don't write to Nastya's DM"), the
    // skill mention is incidental.
    const v = classifyByHeuristic(
      '⚠️ НЕ писать в DM с Настей. Если очень нужно — использовать [[message read]] чтобы только прочитать.',
      '## Privacy override'
    )
    expect(v.appliesTo).toBe('universal')
  })
})

describe('LlmChunkClassifier', () => {
  function makeLlm(returnText: string): LLMClient {
    return {
      chatCompletion: mock(async () => ({
        choices: [{ message: { content: returnText }, finish_reason: 'stop' }],
      })),
    } as unknown as LLMClient
  }

  it('parses verdict from a clean JSON response', async () => {
    const llm = makeLlm('{"verdict":"universal","reason":"identity fact"}')
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## Серега', 'TZ: Buenos Aires')
    expect(v.appliesTo).toBe('universal')
    expect(v.classifiedBy).toBe('llm')
    expect(v.reason).toBe('identity fact')
  })

  it('strips ```json fences before parsing', async () => {
    const llm = makeLlm('```json\n{"verdict":"openclaw-only","reason":"skill call"}\n```')
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## X', 'use [[xxx]]')
    expect(v.appliesTo).toBe('openclaw-only')
  })

  it('returns needs-review on non-JSON LLM output', async () => {
    const llm = makeLlm('I think this is universal because...')
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## X', 'body')
    expect(v.appliesTo).toBe('needs-review')
    expect(v.classifiedBy).toBeNull()
  })

  it('returns needs-review when LLM throws', async () => {
    const llm = {
      chatCompletion: mock(async () => {
        throw new Error('LLM down')
      }),
    } as unknown as LLMClient
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## X', 'body')
    expect(v.appliesTo).toBe('needs-review')
    expect(v.reason).toMatch(/LLM error/)
  })

  it('normalises snake_case verdicts to kebab-case', async () => {
    const llm = makeLlm('{"verdict":"openclaw_only","reason":"x"}')
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## X', 'body')
    expect(v.appliesTo).toBe('openclaw-only')
  })

  it('falls back to needs-review on unknown verdict strings', async () => {
    const llm = makeLlm('{"verdict":"maybe","reason":"x"}')
    const c = new LlmChunkClassifier({ llm })
    const v = await c.classify('## X', 'body')
    expect(v.appliesTo).toBe('needs-review')
  })
})
