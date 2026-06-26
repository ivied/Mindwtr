/**
 * Client for the AI Service glossary / onboarding API.
 *
 * Same build-time config as procedural-client (VITE_AI_SERVICE_URL +
 * VITE_AI_SERVICE_TOKEN). When unset, isGlossaryAvailable() is false and the
 * onboarding view hides itself.
 *
 * Flow: scan() asks the service to read the user's tasks and propose glossary
 * candidates (decodings of project codenames / acronyms / internal terms); the
 * wizard then confirm()s (optionally editing) or reject()s each. Confirmed rows
 * feed the KNOWN_GLOSSARY block; rejected rows are remembered so the same
 * shorthand is never re-proposed.
 */

export type GlossaryKind = 'project' | 'term' | 'technology' | 'organization';
export type CandidateGrade = 'high' | 'needs_input';

export interface GlossaryCandidate {
    slug: string;
    term: string;
    expansion: string;
    kind: GlossaryKind;
    confidence: number | null;
    mentionCount: number;
    grade: CandidateGrade;
    evidence: string;
}

export interface ScanResult {
    scannedTasks: number;
    candidates: GlossaryCandidate[];
    counts: { candidate: number; confirmed: number; rejected: number };
}

export interface GlossaryRecord {
    slug: string;
    term: string;
    expansion: string;
    kind: GlossaryKind;
    aliases: string[];
    status: 'candidate' | 'confirmed' | 'rejected';
    source: string;
    confidence: number | null;
    mentionCount: number;
    confirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isGlossaryAvailable(): boolean {
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

export async function scanOnboarding(): Promise<ScanResult> {
    return apiFetch<ScanResult>('/v1/onboarding/scan', { method: 'POST', body: '{}' });
}

export async function listGlossary(
    status: 'candidate' | 'confirmed' | 'rejected'
): Promise<{ items: GlossaryRecord[] }> {
    return apiFetch<{ items: GlossaryRecord[] }>(`/v1/glossary?status=${status}`);
}

export async function confirmGlossary(input: {
    slug: string;
    expansion?: string;
    term?: string;
    kind?: GlossaryKind;
    aliases?: string[];
}): Promise<{ record: GlossaryRecord }> {
    return apiFetch<{ record: GlossaryRecord }>('/v1/glossary/confirm', {
        method: 'POST',
        body: JSON.stringify(input),
    });
}

export async function rejectGlossary(slug: string): Promise<{ record: GlossaryRecord }> {
    return apiFetch<{ record: GlossaryRecord }>('/v1/glossary/reject', {
        method: 'POST',
        body: JSON.stringify({ slug }),
    });
}
