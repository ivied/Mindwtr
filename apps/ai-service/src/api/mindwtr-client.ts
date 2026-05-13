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
  /** Person this task is waiting on — surfaces in Mindwtr's Organize > Waiting view. */
  assignedTo?: string
  metadata?: Record<string, unknown>
}

export interface Task {
  id: string
  title: string
  status: string
  contexts: string[]
  tags: string[]
  description?: string
  priority?: string
  projectId?: string
  assignedTo?: string
  dueDate?: string
  createdAt: string
  updatedAt: string
}

interface CreateProjectParams {
  title: string
  status?: 'active' | 'someday' | 'waiting' | 'archived'
  color?: string
  order?: number
  tagIds?: string[]
  areaId?: string
  supportNotes?: string
  dueDate?: string
  isSequential?: boolean
}

export interface MindwtrProject {
  id: string
  title: string
  status: 'active' | 'someday' | 'waiting' | 'archived'
  color: string
  order: number
  tagIds: string[]
  areaId?: string
  supportNotes?: string
  dueDate?: string
  isSequential?: boolean
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
      // Marks all writes as originating from ai-service so the cloud's
      // task-change webhook can suppress feedback loops on our own applies.
      'X-Mindwtr-Source': 'ai-service',
    }
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    // Mindwtr Cloud expects { title, props: { ...rest } } shape, not flat.
    // Anything outside title/input goes into props.
    const { title, ...rest } = params
    const body: Record<string, unknown> = { title, props: rest }
    const res = await fetch(`${this.baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
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

  /** Delete task. Returns true on 2xx, false on 404 (already gone). Throws on other errors. */
  async deleteTask(id: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/v1/tasks/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    })
    if (res.ok) return true
    if (res.status === 404) return false
    throw new Error(`deleteTask failed: ${res.status} ${await res.text()}`)
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

  async createProject(params: CreateProjectParams): Promise<MindwtrProject> {
    // Cloud expects { title, props: { ...rest } } shape, mirroring createTask.
    const { title, ...rest } = params
    const body: Record<string, unknown> = { title, props: rest }
    const res = await fetch(`${this.baseUrl}/v1/projects`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`createProject failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as MindwtrProject | { project: MindwtrProject }
    return 'project' in data ? data.project : data
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
