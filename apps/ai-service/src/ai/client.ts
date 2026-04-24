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
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private defaultModel: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async chatCompletion(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string }
  ): Promise<ChatCompletionResponse> {
    const body: ChatCompletionRequest = {
      model: request.model ?? this.defaultModel,
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
