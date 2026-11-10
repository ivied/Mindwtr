/**
 * Wire types shared with ai-service (src/agent-runs/types.ts). Duplicated on
 * purpose: the runner is a separate host process and must not pull ai-service
 * (and its native deps) into its install.
 */

export interface PendingQuestion {
  kind: 'question'
  question: string
  options: string[]
}

export interface PendingConfirm {
  kind: 'confirm'
  action: string
  target: string
  draft: string
}

export type AccessScope = 'read' | 'write'

export interface PendingAccess {
  kind: 'access'
  service: string
  purpose: string
  scope: AccessScope
}

export interface PendingSecret {
  kind: 'secret'
  name: string
  label: string
  hint: string
  url: string
}

/** A browser sign-in the runner started; the user opens `url`, the code comes back through the server. */
export interface PendingOAuth {
  kind: 'oauth'
  name: string
  label: string
  url: string
  state: string
  hint: string
  /** True when the service only returns to this computer: from another device the user pastes the address. */
  local: boolean
}

export type PendingRequest = PendingQuestion | PendingConfirm | PendingAccess | PendingSecret | PendingOAuth

export interface AccessSpec {
  name: string
  kind: 'mcp' | 'cli' | 'http' | 'ssh' | 'other'
  scope: AccessScope
  hosts: string[]
  envVars: string[]
  mcpServer: string
  skill: string
  notes: string
}

export interface AccessRecord extends AccessSpec {
  status: 'active' | 'revoking' | 'revoked'
}

export interface TaskChanges {
  title?: string
  status?: string
  contexts?: string[]
  addTags?: string[]
  project?: string
  descriptionAppend?: string
}

export interface RunResult {
  summary: string
  evidence: string[]
  changes: TaskChanges
  access?: AccessSpec
  /** What the user said or confirmed in this run that is worth remembering. */
  lessons?: Array<{ statement: string; entity: string }>
}

/** A screenshot the user attached to a reply; the bytes are fetched separately. */
export interface RunImageRef {
  id: string
  name: string
  mime: string
}

export interface RunReply {
  kind: 'answer' | 'approve' | 'reject' | 'message' | 'resume'
  text: string
  images?: RunImageRef[]
}

export type RunEventKind = 'say' | 'tool' | 'tool_result' | 'user' | 'done' | 'error'

export interface RunEventInput {
  kind: RunEventKind
  payload: Record<string, unknown>
}

export interface RunRecord {
  id: string
  kind?: 'task' | 'provision'
  taskId: string
  taskTitle: string
  taskDescription: string
  state: string
  sessionId: string | null
  cwd: string | null
  costUsd: number
}

export interface ClaimedRun {
  run: RunRecord
  reply: RunReply | null
  /** What memory knows about the task; first turn of a task run only. */
  context?: string
  secrets?: Array<{ name: string; value: string }>
}

export interface ClaimResult {
  items: ClaimedRun[]
  overBudget: boolean
  accesses?: AccessRecord[]
  /** Public address of the server — where a browser sign-in is sent back to. */
  publicUrl?: string
}

export type FinishState = 'question' | 'confirm' | 'done' | 'stopped' | 'error'

export interface FinishBody {
  state: FinishState
  pending?: PendingRequest | null
  result?: RunResult | null
  sessionId?: string | null
  cwd?: string | null
  costUsd?: number
  /** Percent of the weekly subscription quota this turn used, when measurable. */
  quotaPct?: number
  error?: string | null
}

export interface HeartbeatResult {
  stop: boolean
  messages: RunReply[]
}
