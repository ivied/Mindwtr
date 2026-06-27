/**
 * Control Center client — read-only dashboard aggregator (Phase 2).
 *
 * Hits GET /v1/status/dashboard which bundles health + memory + procedural +
 * recording into one call. Same VITE_AI_SERVICE_URL/TOKEN config + bearer
 * pattern as procedural-client.ts. @ai-agent task counts come from the local
 * task store (client-side), not this endpoint.
 */

const BASE_URL = String(import.meta.env.VITE_AI_SERVICE_URL ?? '').replace(/\/$/, '');
const TOKEN = String(import.meta.env.VITE_AI_SERVICE_TOKEN ?? '').trim();

export function isControlCenterAvailable(): boolean {
  return Boolean(BASE_URL && TOKEN);
}

export interface HealthComponent { ok: boolean; detail?: string }

export type SourceKey = 'screen' | 'audio' | 'chat' | 'notes';
export interface SourceActivity { recent: number; lastAt: string | null }

export interface DashboardStatus {
  ok: boolean;
  components: Record<string, HealthComponent> | null;
  capturePaused: boolean;
  memory: {
    events: number;
    facts: number;
    activeFacts: number;
    eventsToday: number;
    latestEventAt: string | null;
  } | null;
  procedural: { total: number; visible: number } | null;
  recording: { active: boolean; taskTitle: string | null };
  sources: Record<SourceKey, SourceActivity> | null;
  checkedAt: string;
}

export async function getDashboardStatus(signal?: AbortSignal): Promise<DashboardStatus> {
  if (!BASE_URL || !TOKEN) {
    throw new Error('AI Service is not configured (VITE_AI_SERVICE_URL/TOKEN missing)');
  }
  const res = await fetch(`${BASE_URL}/v1/status/dashboard`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal,
  });
  if (!res.ok) throw new Error(`dashboard status ${res.status}`);
  return (await res.json()) as DashboardStatus;
}

export interface SourcePulse {
  now: string;
  sources: Record<SourceKey, number>;
}

/** New events per bucket since `since` — for literal on-arrival flow. */
export async function getSourcePulse(since: string | null, signal?: AbortSignal): Promise<SourcePulse> {
  if (!BASE_URL || !TOKEN) throw new Error('AI Service is not configured');
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await fetch(`${BASE_URL}/v1/status/source-pulse${q}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal,
  });
  if (!res.ok) throw new Error(`source-pulse ${res.status}`);
  return (await res.json()) as SourcePulse;
}

/** Control-plane: flip the capture pause switch (Phase 3). */
export async function setCapturePaused(paused: boolean): Promise<{ capturePaused: boolean }> {
  if (!BASE_URL || !TOKEN) throw new Error('AI Service is not configured');
  const res = await fetch(`${BASE_URL}/v1/agent-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ capturePaused: paused }),
  });
  if (!res.ok) throw new Error(`agent-config ${res.status}`);
  return (await res.json()) as { capturePaused: boolean };
}
