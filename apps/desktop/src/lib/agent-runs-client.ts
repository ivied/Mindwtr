/**
 * Client for ai-service agent runs (/v1/agent-runs) — a full agent per inbox
 * item, executed on the host by apps/agent-runner.
 *
 * Same build-time config as proposals-client (VITE_AI_SERVICE_URL +
 * VITE_AI_SERVICE_TOKEN). When unset, isAgentRunsAvailable() is false and the
 * Inbox zone stays hidden.
 */

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isAgentRunsAvailable(): boolean {
    return Boolean(BASE_URL && TOKEN);
}

export type AgentRunState =
    | 'queued'
    | 'running'
    | 'question'
    | 'confirm'
    | 'done'
    | 'stopped'
    | 'error'
    | 'closed';

export interface PendingQuestion {
    kind: 'question';
    question: string;
    options: string[];
}

export interface PendingConfirm {
    kind: 'confirm';
    action: string;
    target: string;
    draft: string;
}

export type AccessScope = 'read' | 'write';

/** A task agent asks for access to a service it cannot reach. */
export interface PendingAccess {
    kind: 'access';
    service: string;
    purpose: string;
    scope: AccessScope;
    /** Set once granted: the provisioning run that is connecting it. */
    provisionRunId: string | null;
}

/** The provisioning agent asks for a key; the value is typed into a password field. */
export interface PendingSecret {
    kind: 'secret';
    name: string;
    label: string;
    hint: string;
    url: string;
}

/** The runner started a browser sign-in; `url` is the link to open. */
export interface PendingOAuth {
    kind: 'oauth';
    name: string;
    label: string;
    url: string;
    state: string;
    hint: string;
    /** The service returns only to the runner's computer: from another device the address is pasted. */
    local: boolean;
}

export interface AgentAccess {
    name: string;
    kind: 'mcp' | 'cli' | 'http' | 'ssh' | 'other';
    scope: AccessScope;
    hosts: string[];
    envVars: string[];
    mcpServer: string;
    skill: string;
    notes: string;
    status: 'active' | 'revoking' | 'revoked';
    createdAt: string;
    updatedAt: string;
}

export interface TaskChanges {
    title?: string;
    status?: string;
    contexts?: string[];
    addTags?: string[];
    project?: string;
    descriptionAppend?: string;
}

export interface RunResult {
    summary: string;
    evidence: string[];
    changes: TaskChanges;
    /** Provisioning runs: the access that was connected. */
    access?: Omit<AgentAccess, 'status' | 'createdAt' | 'updatedAt'>;
    /** What the user said or confirmed during the run; saved to memory on accept. */
    lessons?: Array<{ statement: string; entity: string }>;
}

/** A fact the user stated or confirmed; agents are told to treat it as true. */
export interface KnowledgeItem {
    id: number;
    statement: string;
    entity: string | null;
    createdAt: string;
}

export interface AgentRun {
    id: string;
    /** `provision` = a run that connects an access rather than working a task. */
    kind: 'task' | 'provision';
    parentRunId: string | null;
    taskId: string;
    taskTitle: string;
    taskDescription: string;
    state: AgentRunState;
    sessionId: string | null;
    cwd: string | null;
    pending: PendingQuestion | PendingConfirm | PendingAccess | PendingSecret | PendingOAuth | null;
    result: RunResult | null;
    costUsd: number;
    durationMs: number;
    turnStartedAt: string | null;
    stepCount: number;
    claimedBy: string | null;
    heartbeatAt: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

export type AgentRunEventKind = 'say' | 'tool' | 'tool_result' | 'user' | 'done' | 'error';

export interface AgentRunEvent {
    runId: string;
    seq: number;
    ts: string;
    kind: AgentRunEventKind;
    payload: Record<string, unknown>;
}

export type HoldReason = 'quota' | 'budget';

export interface AgentRunList {
    items: AgentRun[];
    spentTodayUsd: number;
    dailyBudgetUsd: number;
    /** Percent of the weekly subscription quota agents used today, and the daily cap (0 = none). */
    quotaTodayPct?: number;
    dailyQuotaPct?: number;
    /** Why runs that have not started yet are being held back, if they are. */
    hold?: HoldReason | null;
    runnerSeenAt: string | null;
    accesses: AgentAccess[];
    /** Server clock — elapsed timers are computed against it, not the local clock. */
    now: string;
}

export type ReplyKind = 'answer' | 'approve' | 'reject' | 'message' | 'resume';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!BASE_URL || !TOKEN) throw new Error('AI Service не настроен (VITE_AI_SERVICE_URL / TOKEN)');
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `agent-runs ${res.status}`);
    }
    return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export function listAgentRuns(signal?: AbortSignal): Promise<AgentRunList> {
    return request<AgentRunList>('/v1/agent-runs', { signal });
}

export function getAgentRun(
    id: string,
    since = 0,
    signal?: AbortSignal,
): Promise<{ run: AgentRun; events: AgentRunEvent[]; now: string }> {
    return request(`/v1/agent-runs/${encodeURIComponent(id)}?since=${since}`, { signal });
}

/** Queue an agent for every inbox task that doesn't have an active run. */
export function startInboxRuns(): Promise<{ enqueued: number; items: AgentRun[] }> {
    return post('/v1/agent-runs', { inbox: true });
}

export function startTaskRun(taskId: string): Promise<{ enqueued: number; items: AgentRun[] }> {
    return post('/v1/agent-runs', { taskId });
}

/** A screenshot sent along with a reply: base64 without the data-URL prefix. */
export interface ReplyImage {
    name: string;
    mime: string;
    data: string;
}

export function replyToRun(id: string, kind: ReplyKind, text = '', images: ReplyImage[] = []): Promise<{ run: AgentRun }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/reply`, {
        kind,
        text,
        ...(images.length ? { images: images.map(({ name, mime, data }) => ({ name, mime, data })) } : {}),
    });
}

/** Finish a sign-in made on another device: the address the browser ended on after signing in. */
export function sendSignInUrl(id: string, url: string): Promise<{ run: AgentRun; accepted: boolean }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/sign-in`, { url });
}

/** Remove a run from the list in any state; a running agent is stopped. The task is not touched. */
export function dismissRun(id: string): Promise<{ run: AgentRun }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/dismiss`);
}

export function stopRun(id: string): Promise<{ run: AgentRun }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/stop`);
}

/** Accept the result (applies the proposed task changes) or just dismiss the run. */
export function acceptRun(
    id: string,
    apply = true,
    lessons?: number[],
): Promise<{ run: AgentRun; applied: boolean; remembered?: number }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/accept`, { apply, ...(lessons ? { lessons } : {}) });
}

export function listKnowledge(): Promise<{ items: KnowledgeItem[]; available: boolean }> {
    return request('/v1/agent-knowledge');
}

export function addKnowledge(statement: string, entity = ''): Promise<{ item: KnowledgeItem }> {
    return post('/v1/agent-knowledge', { statement, entity });
}

export function removeKnowledge(id: number): Promise<{ ok: boolean }> {
    return request(`/v1/agent-knowledge/${id}`, { method: 'DELETE' });
}

/** Grant or deny an access a task agent asked for. Granting starts a provisioning run. */
export function decideAccess(
    id: string,
    decision: 'grant' | 'deny',
    scope?: AccessScope,
): Promise<{ run: AgentRun; provision?: AgentRun }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/access`, { decision, scope });
}

/** Hand a key to the provisioning run that asked for it. It is not stored in the run's log. */
export function sendSecret(id: string, value: string): Promise<{ run: AgentRun }> {
    return post(`/v1/agent-runs/${encodeURIComponent(id)}/secret`, { value });
}

/** Ask for a new access directly: starts a provisioning run. */
export function startProvision(service: string, scope: AccessScope): Promise<{ enqueued: number; items: AgentRun[] }> {
    return post('/v1/agent-runs', { provision: { service, scope } });
}

export function revokeAccess(name: string): Promise<{ access: AgentAccess }> {
    return post(`/v1/agent-accesses/${encodeURIComponent(name)}/revoke`);
}
