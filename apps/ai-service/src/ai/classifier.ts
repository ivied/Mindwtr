import type { LLMClient } from './client'
import { CLASSIFICATION_SCHEMA } from './schema'
import { SYSTEM_PROMPT } from './prompts'
import type { ClassificationResult, ClassifierInput } from './types'

export class Classifier {
  constructor(private llm: LLMClient) {}

  async classify(input: ClassifierInput): Promise<ClassificationResult> {
    const userMessage = this.buildUserMessage(input)

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      tools: [CLASSIFICATION_SCHEMA],
      tool_choice: 'required',
      temperature: 0.2,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) {
      throw new Error('LLM did not return expected tool call')
    }

    return this.parseClassification(toolCall.function.arguments)
  }

  private buildUserMessage(input: ClassifierInput): string {
    const parts = [
      `Captured item:\n"${input.text}"`,
      `\nSource: ${input.sourceChannel}`,
      `Captured at: ${input.capturedAt}`,
    ]
    if (input.priorContext) {
      parts.push(`\nPrior context:\n${input.priorContext}`)
    }
    return parts.join('\n')
  }

  private parseClassification(argsJson: string): ClassificationResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(argsJson)
    } catch (err) {
      throw new Error(`Failed to parse classification JSON: ${err}`)
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Classification result is not an object')
    }

    const obj = parsed as Record<string, unknown>

    return {
      category: obj.category as ClassificationResult['category'],
      is_noise: Boolean(obj.is_noise),
      noise_reason: obj.noise_reason as string | undefined,
      suggested_contexts: Array.isArray(obj.suggested_contexts)
        ? (obj.suggested_contexts as string[])
        : [],
      suggested_tags: Array.isArray(obj.suggested_tags)
        ? (obj.suggested_tags as string[])
        : [],
      is_project: Boolean(obj.is_project),
      project_name: obj.project_name as string | undefined,
      is_delegation: Boolean(obj.is_delegation),
      delegate_to: obj.delegate_to as string | undefined,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    }
  }
}
