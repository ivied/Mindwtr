/**
 * HTTP client for Mindwtr Cloud REST API.
 * Used by AI Service to create/read/update tasks via Cloud server.
 */

interface MindwtrClientConfig {
  baseUrl: string
  authToken: string
}

interface CreateTaskParams {
  title: string
  status?: string
  contexts?: string[]
  tags?: string[]
  description?: string
  priority?: string
  projectId?: string
  dueDate?: string
  metadata?: Record<string, unknown>
}

interface Task {
  id: string
  title: string
  status: string
  contexts: string[]
  tags: string[]
  description?: string
  priority?: string
  projectId?: string
  dueDate?: string
  createdAt: string
  updatedAt: string
}

interface ListTasksParams {
  status?: string
  projectId?: string
  search?: string
  limit?: number
  offset?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export class MindwtrClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(config: MindwtrClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.authToken}`,
    }
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(`createTask failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as Task | { task: Task }
    return 'task' in data ? data.task : data
  }

  async listTasks(params: ListTasksParams = {}): Promise<Task[]> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value))
    }
    const res = await fetch(`${this.baseUrl}/v1/tasks?${query}`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    return data.tasks ?? data
  }

  async getTask(id: string): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/v1/tasks/${id}`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`getTask failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as Task | { task: Task }
    return 'task' in data ? data.task : data
  }

  async updateTask(id: string, updates: Partial<CreateTaskParams>): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/v1/tasks/${id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(`updateTask failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as Task | { task: Task }
    return 'task' in data ? data.task : data
  }

  async completeTask(id: string): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/v1/tasks/${id}/complete`, {
      method: 'POST',
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`completeTask failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as Task | { task: Task }
    return 'task' in data ? data.task : data
  }

  async search(query: string): Promise<{ tasks: Task[]; projects: unknown[] }> {
    const res = await fetch(`${this.baseUrl}/v1/search?q=${encodeURIComponent(query)}`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`)
      return res.ok
    } catch {
      return false
    }
  }
}
