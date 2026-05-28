/**
 * Client for the AI Service recording-session API (Phase 2).
 * Shares the build-time config of procedural-client / proposals-client.
 */

export type DistillationStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RecordingSession {
    id: string;
    taskId: string;
    taskTitle: string | null;
    startedAt: string;
    stoppedAt: string | null;
    distillationStatus: DistillationStatus;
    distilledChunkId: string | null;
    distillationError: string | null;
}

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isRecordingAvailable(): boolean {
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
            data && typeof data === 'object' && 'error' in data &&
            typeof (data as { error: unknown }).error === 'string'
                ? (data as { error: string }).error
                : `HTTP ${res.status}`;
        const err = new Error(message) as Error & { status?: number; session?: RecordingSession };
        err.status = res.status;
        if (
            data && typeof data === 'object' && 'session' in data &&
            (data as { session?: unknown }).session
        ) {
            err.session = (data as { session: RecordingSession }).session;
        }
        throw err;
    }
    return data as T;
}

export async function getActiveRecording(): Promise<RecordingSession | null> {
    const r = await apiFetch<{ session: RecordingSession | null }>('/v1/recordings/active');
    return r.session;
}

export async function startRecording(input: {
    taskId: string;
    taskTitle?: string;
}): Promise<RecordingSession> {
    const r = await apiFetch<{ ok: boolean; session: RecordingSession }>(
        '/v1/recordings/start',
        { method: 'POST', body: JSON.stringify(input) }
    );
    return r.session;
}

export async function stopRecording(sessionId: string): Promise<RecordingSession> {
    const r = await apiFetch<{ ok: boolean; session: RecordingSession }>(
        `/v1/recordings/${sessionId}/stop`,
        { method: 'POST' }
    );
    return r.session;
}

export async function listRecordings(limit = 50): Promise<RecordingSession[]> {
    const r = await apiFetch<{ items: RecordingSession[] }>(`/v1/recordings?limit=${limit}`);
    return r.items;
}
