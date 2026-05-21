/**
 * Client for the AI Service procedural-memory review API (FR88/FR89).
 *
 * Same build-time config as proposals-client (VITE_AI_SERVICE_URL +
 * VITE_AI_SERVICE_TOKEN). When unset, isProceduralAvailable() is false and
 * the AI Playbook view hides itself.
 */

export type AppliesTo =
    | 'universal'
    | 'openclaw-only'
    | 'mindwtr-only'
    | 'archived'
    | 'needs-review';

/** What a human reviewer is allowed to set (mirrors server USER_SETTABLE_APPLIES). */
export const USER_SETTABLE_APPLIES: AppliesTo[] = [
    'universal',
    'openclaw-only',
    'mindwtr-only',
    'archived',
];

export interface ProceduralChunk {
    id: string;
    source: string;
    path: string;
    sectionIndex: number;
    sectionTitle: string | null;
    excerpt: string;
    appliesTo: AppliesTo;
    classifiedBy: 'heuristic' | 'llm' | 'user' | null;
    classifiedAt: string | null;
    reliabilityScore: number | null;
}

export interface ProceduralStats {
    total: number;
    byApplies: Record<string, number>;
    byClassifier: Record<string, number>;
    reliability: {
        scored: number;
        avg: number | null;
        min: number | null;
        belowHalf: number;
    };
}

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isProceduralAvailable(): boolean {
    return Boolean(BASE_URL && TOKEN);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    if (!BASE_URL || !TOKEN) {
        throw new Error('AI Service is not configured (VITE_AI_SERVICE_URL/TOKEN missing)');
    }
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            ...(init?.headers ?? {}),
        },
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
            data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
                ? (data as { error: string }).error
                : `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data as T;
}

export async function getProceduralStats(): Promise<ProceduralStats> {
    return apiFetch<ProceduralStats>('/v1/procedural/stats');
}

export async function listProceduralChunks(
    opts: { applies?: AppliesTo[]; source?: string; limit?: number; offset?: number } = {}
): Promise<{ total: number; items: ProceduralChunk[] }> {
    const qs = new URLSearchParams();
    if (opts.applies && opts.applies.length > 0) qs.set('applies', opts.applies.join(','));
    if (opts.source) qs.set('source', opts.source);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ total: number; items: ProceduralChunk[] }>(`/v1/procedural/chunks${suffix}`);
}

export async function classifyProceduralChunk(
    id: string,
    appliesTo: AppliesTo
): Promise<{ ok: boolean; chunk: ProceduralChunk | null }> {
    return apiFetch<{ ok: boolean; chunk: ProceduralChunk | null }>(
        `/v1/procedural/chunks/${id}/classify`,
        { method: 'POST', body: JSON.stringify({ appliesTo }) }
    );
}
