/**
 * OpenAI-compatible HTTP client for 9Router (Anthropic proxy).
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class LLMClient {
  private readonly defaultModel: string
  /** Maps a model to the ordered list of models to try (itself first). */
  private readonly chainOf: Map<string, string[]>

  constructor(
    private baseUrl: string,
    private apiKey: string,
    models:
      | string
      | {
          opus: string
          sonnet: string
          fallbackOpus?: string
          fallbackSonnet?: string
        }
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    if (typeof models === 'string') {
      this.defaultModel = models
      this.chainOf = new Map()
    } else {
      // opus-tier requests fall back to sonnet and vice versa, so a single
      // model being down on the proxy degrades quality rather than failing.
      // The optional fallback pair sits behind both: when the whole primary
      // provider is out (shared quota pool), requests cross over to it.
      this.defaultModel = models.opus
      const chain = (...tries: Array<string | undefined>) => {
        const seen = new Set<string>()
        return tries.filter(
          (m): m is string => !!m && !seen.has(m) && !!seen.add(m)
        )
      }
      this.chainOf = new Map([
        [
          models.opus,
          chain(models.opus, models.sonnet, models.fallbackOpus, models.fallbackSonnet),
        ],
        [
          models.sonnet,
          chain(models.sonnet, models.opus, models.fallbackSonnet, models.fallbackOpus),
        ],
      ])
    }
  }

  async chatCompletion(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string }
  ): Promise<ChatCompletionResponse> {
    const primary = request.model ?? this.defaultModel
    const chain = this.chainOf.get(primary) ?? [primary]
    let lastErr: unknown
    for (const model of chain) {
      try {
        return await this.send(request, model)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  }

  private async send(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string },
    model: string
  ): Promise<ChatCompletionResponse> {
    // Claude Sonnet 5+ rejects `temperature` as deprecated (400). All our
    // callers used ≤0.3 anyway; drop the knob entirely rather than branch by
    // model family.
    const body: ChatCompletionRequest = {
      model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
      max_tokens: request.max_tokens ?? 2000,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      // lone surrogates from truncated OCR text make Anthropic reject the body (400).
      // Well-formed JSON.stringify escapes them as literal \udXXX (valid pairs stay raw),
      // so strip the escaped form.
      body: JSON.stringify(body).replace(/(?<!\\)\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, ''),
      // the router can silently hold a dead connection open forever
      signal: AbortSignal.timeout(180_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM request failed: ${res.status} ${text}`)
    }

    return res.json() as Promise<ChatCompletionResponse>
  }
}
