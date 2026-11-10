/**
 * Agent runs — one full agent session per inbox item.
 *
 * ai-service owns the durable record (state + event log) and the user-facing
 * API; the actual agent executes in `apps/agent-runner` on the host (it needs
 * the real `claude` runtime, ~/.claude, Slack, repos) and talks to ai-service
 * over the runner endpoints (claim / events / finish).
 *
 * State machine:
 *
 *   queued ──claim──▶ running ──finish──▶ question | confirm | done | error
 *      ▲                 │                     │
 *      │                 └──stop──▶ stopped    │
 *      └───────── user reply (answer / approve / reject / message) ─┘
 *   done ──accept──▶ closed
 *
 * A run that stops to wait for the user keeps its `sessionId`; the reply
 * re-queues it and the runner resumes the SAME session with the reply as the
 * next prompt, so nothing is held open while the user is away.
 */

export type AgentRunState =
  | 'queued'
  | 'running'
  | 'question'
  | 'confirm'
  | 'done'
  | 'stopped'
  | 'error'
  | 'closed'

/** States where the run is parked waiting for the user. */
export const WAITING_STATES: ReadonlySet<AgentRunState> = new Set([
  'question',
  'confirm',
  'done',
  'stopped',
  'error',
])

export interface PendingQuestion {
  kind: 'question'
  question: string
  options: string[]
}

export interface PendingConfirm {
  kind: 'confirm'
  /** What the agent wants to do, e.g. "Отправить сообщение в Slack". */
  action: string
  /** Where it lands: channel, recipient, repo, host. */
  target: string
  /** The exact content/command that will be sent or executed. */
  draft: string
}

/** A task agent lacks access to a service and asks for it (parks as `confirm`). */
export interface PendingAccess {
  kind: 'access'
  service: string
  purpose: string
  scope: AccessScope
  /** Set once the user granted it: the provisioning run that is connecting it. */
  provisionRunId: string | null
}

/**
 * The provisioning agent needs a key from the user (parks as `question`). The
 * value goes UI → ai-service → runner → host secrets file; it never enters the
 * event log or a prompt.
 */
export interface PendingSecret {
  kind: 'secret'
  /** Environment variable the agents will read it from. */
  name: string
  label: string
  hint: string
  url: string
}

/**
 * The provisioning agent started a browser sign-in (parks as `question`). The
 * runner registered itself with the service and built `url`; the service sends
 * the browser back to our public callback with a code, which goes to the
 * runner the same way a typed secret does. Tokens never come here.
 */
export interface PendingOAuth {
  kind: 'oauth'
  /** Short name of the sign-in on the runner; becomes the MCP server name. */
  name: string
  label: string
  url: string
  /** Opaque value that ties the callback to this run. */
  state: string
  hint: string
  /** The service only returns to the runner's own computer; from elsewhere the user pastes the address. */
  local: boolean
}

export type PendingRequest = PendingQuestion | PendingConfirm | PendingAccess | PendingSecret | PendingOAuth

/** Run state a pending request parks the run in. */
export function stateOfPending(p: PendingRequest): 'question' | 'confirm' {
  return p.kind === 'question' || p.kind === 'secret' || p.kind === 'oauth' ? 'question' : 'confirm'
}

export type AccessScope = 'read' | 'write'
export type AccessKind = 'mcp' | 'cli' | 'http' | 'ssh' | 'other'

/** What a provisioning run connected — one row of the access registry. */
export interface AccessSpec {
  name: string
  kind: AccessKind
  scope: AccessScope
  /** Hosts this access talks to; with scope=write the runner lets writes to them through. */
  hosts: string[]
  /** Names (never values) of the secrets it uses. */
  envVars: string[]
  /** User-scope MCP server name, when kind=mcp. */
  mcpServer: string
  /** Skill directory name under ~/.claude/skills that documents it. */
  skill: string
  /** One or two lines for other agents: how to use it. */
  notes: string
}

export type AccessStatus = 'active' | 'revoking' | 'revoked'

export interface AccessRecord extends AccessSpec {
  status: AccessStatus
  runId: string | null
  createdAt: string
  updatedAt: string
}

/** `task` works an inbox item; `provision` connects an access with wider rights. */
export type RunKind = 'task' | 'provision'

/** Task edits the agent proposes; applied only when the user accepts. */
export interface TaskChanges {
  title?: string
  status?: string
  contexts?: string[]
  addTags?: string[]
  /** Project title; resolved to an id on accept. */
  project?: string
  descriptionAppend?: string
}

export interface RunResult {
  summary: string
  evidence: string[]
  changes: TaskChanges
  /** Provisioning runs only: the access that was connected. */
  access?: AccessSpec
  /**
   * Things the user said or confirmed during the run that are worth keeping.
   * They become confirmed facts in memory only when the user accepts them.
   */
  lessons?: RunLesson[]
}

export interface RunLesson {
  statement: string
  /** Project, person or service the fact is about, as the agent named it; '' = general rule. */
  entity: string
}

/** A fact the user stated or confirmed — what the agents are told to treat as true. */
export interface KnowledgeItem {
  id: number
  statement: string
  entity: string | null
  createdAt: string
}

/** Memory as agent runs use it. Optional: runs work without it. */
export interface AgentRunsMemory {
  /** The "what memory knows" block for a task; '' when there is nothing. */
  taskContext(text: string): Promise<string>
  list(): KnowledgeItem[]
  save(statement: string, entity: string): KnowledgeItem
  remove(id: number): boolean
}

export type RunReplyKind = 'answer' | 'approve' | 'reject' | 'message' | 'resume'

/** A screenshot the user attached to a reply; the bytes are fetched separately. */
export interface RunImageRef {
  id: string
  name: string
  mime: string
}

export interface RunReply {
  kind: RunReplyKind
  text: string
  images?: RunImageRef[]
}

export type RunEventKind = 'say' | 'tool' | 'tool_result' | 'user' | 'done' | 'error'

export interface RunEventInput {
  kind: RunEventKind
  payload: Record<string, unknown>
}

export interface AgentRunEvent extends RunEventInput {
  runId: string
  seq: number
  ts: string
}

export interface AgentRunRecord {
  id: string
  kind: RunKind
  /** Provisioning runs: the task run that is waiting for this access. */
  parentRunId: string | null
  taskId: string
  taskTitle: string
  taskDescription: string
  state: AgentRunState
  sessionId: string | null
  cwd: string | null
  pending: PendingRequest | null
  result: RunResult | null
  costUsd: number
  /** Accumulated active time of finished turns. */
  durationMs: number
  /** Start of the turn in flight (state=running), else null. */
  turnStartedAt: string | null
  stepCount: number
  claimedBy: string | null
  heartbeatAt: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** What the runner gets when it claims a run. */
export interface ClaimedRun {
  run: AgentRunRecord
  /** Present when this is a resume triggered by the user. */
  reply: RunReply | null
  /** Secrets the user entered for this run; handed over once, then forgotten here. */
  secrets: Array<{ name: string; value: string }>
  /** What memory knows about the task — only on the first turn of a task run. */
  context?: string
}

export interface FinishInput {
  state: Extract<AgentRunState, 'question' | 'confirm' | 'done' | 'stopped' | 'error'>
  pending?: PendingRequest | null
  result?: RunResult | null
  sessionId?: string | null
  cwd?: string | null
  costUsd?: number
  error?: string | null
}
