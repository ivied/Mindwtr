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

export interface DashboardStatus {
  ok: boolean;
  components: Record<string, HealthComponent> | null;
  memory: {
    events: number;
    facts: number;
    activeFacts: number;
    eventsToday: number;
    latestEventAt: string | null;
  } | null;
  procedural: { total: number; visible: number } | null;
  recording: { active: boolean; taskTitle: string | null };
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
