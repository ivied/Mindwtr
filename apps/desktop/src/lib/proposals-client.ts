/**
 * Client for the AI Service Proposals REST API.
 *
 * Configured via VITE_AI_SERVICE_URL + VITE_AI_SERVICE_TOKEN at build time.
 * When unset, isProposalsAvailable() returns false and views should hide.
 */

export type ProposalType = 'create' | 'modify' | 'delete' | 'merge' | 'split' | 'move';

export type ProposalStatus =
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'superseded'
    | 'stale'
    | 'expired';

export interface ProposalSummary {
    id: string;
    type: ProposalType;
    targetTaskIds: string[];
    sourceCaptureId: string | null;
    sourceAgent: string;
    status: ProposalStatus;
    currentVersion: number;
    currentPayload: unknown;
    createdAt: string;
    resolvedAt: string | null;
}

export interface ProposalVersion {
    proposalId: string;
    version: number;
    payload: unknown;
    author: 'agent' | 'user';
    summary: string | null;
    createdAt: string;
}

export interface ProposalMessage {
    id: string;
    proposalId: string;
    role: 'user' | 'agent';
    text: string;
    refVersion: number | null;
    createdAt: string;
}

export interface ProposalAuditEntry {
    id: string;
    proposalId: string;
    event: string;
    eventMeta: Record<string, unknown> | null;
    actor: string;
    ts: string;
}

export interface ProposalDetail extends ProposalSummary {
    versions: ProposalVersion[];
    messages: ProposalMessage[];
    audit: ProposalAuditEntry[];
}

export interface ApproveResult {
    ok: boolean;
    appliedTaskIds?: string[];
    reason?: string;
    details?: string;
    proposal: ProposalSummary | ProposalDetail | null;
}

export interface CommentResult {
    ok: boolean;
    outcome: { kind: 'revise' | 'clarify' | 'withdraw' } | null;
    error?: string;
    proposal: ProposalDetail | null;
}

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isProposalsAvailable(): boolean {
    return Boolean(BASE_URL && TOKEN);
}

function authHeaders(): HeadersInit {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
    };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    if (!BASE_URL || !TOKEN) {
        throw new Error('AI Service is not configured (VITE_AI_SERVICE_URL/TOKEN missing)');
    }
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...authHeaders(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let data: unknown;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    if (!res.ok) {
        const message =
            (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
                ? (data as { error: string }).error
                : null) ?? `HTTP ${res.status}`;
        const err = new Error(message);
        // Attach response payload for callers that want details (stale, etc.).
        (err as Error & { response?: unknown }).response = data;
        throw err;
    }
    return data as T;
}

export interface ListFilter {
    type?: ProposalType;
    sourceAgent?: string;
    targetTaskId?: string;
    limit?: number;
}

export async function listPendingProposals(filter: ListFilter = {}): Promise<ProposalSummary[]> {
    const qs = new URLSearchParams();
    if (filter.type) qs.set('type', filter.type);
    if (filter.sourceAgent) qs.set('sourceAgent', filter.sourceAgent);
    if (filter.targetTaskId) qs.set('targetTaskId', filter.targetTaskId);
    if (filter.limit !== undefined) qs.set('limit', String(filter.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await apiFetch<{ items: ProposalSummary[] }>(`/v1/proposals${suffix}`);
    return data.items;
}

export async function getProposal(id: string): Promise<ProposalDetail> {
    return apiFetch<ProposalDetail>(`/v1/proposals/${id}`);
}

export async function approveProposal(
    id: string,
    options: { includeFields?: string[] } = {}
): Promise<ApproveResult> {
    const body =
        options.includeFields && options.includeFields.length > 0
            ? JSON.stringify({ includeFields: options.includeFields })
            : undefined;
    return apiFetch<ApproveResult>(`/v1/proposals/${id}/approve`, {
        method: 'POST',
        body,
    });
}

export async function rejectProposal(id: string, reason?: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/v1/proposals/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
    });
}

export async function commentOnProposal(id: string, text: string): Promise<CommentResult> {
    return apiFetch<CommentResult>(`/v1/proposals/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text }),
    });
}
