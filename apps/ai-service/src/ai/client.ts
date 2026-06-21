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
  /** Maps a model to the model used when its request fails. */
  private readonly fallbackOf: Map<string, string>

  constructor(
    private baseUrl: string,
    private apiKey: string,
    models: string | { opus: string; sonnet: string }
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    if (typeof models === 'string') {
      this.defaultModel = models
      this.fallbackOf = new Map()
    } else {
      // opus-tier requests fall back to sonnet and vice versa, so a single
      // model being down on the proxy degrades quality rather than failing.
      this.defaultModel = models.opus
      this.fallbackOf = new Map([
        [models.opus, models.sonnet],
        [models.sonnet, models.opus],
      ])
    }
  }

  async chatCompletion(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string }
  ): Promise<ChatCompletionResponse> {
    const primary = request.model ?? this.defaultModel
    try {
      return await this.send(request, primary)
    } catch (err) {
      const fallback = this.fallbackOf.get(primary)
      if (!fallback) throw err
      return this.send(request, fallback)
    }
  }

  private async send(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string },
    model: string
  ): Promise<ChatCompletionResponse> {
    const body: ChatCompletionRequest = {
      model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
      max_tokens: request.max_tokens ?? 2000,
      temperature: request.temperature ?? 0.2,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM request failed: ${res.status} ${text}`)
    }

    return res.json() as Promise<ChatCompletionResponse>
  }
}
