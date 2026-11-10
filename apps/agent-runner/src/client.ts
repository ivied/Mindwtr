/** Thin client for ai-service's runner endpoints (/v1/agent-runs/*). */

import type { ClaimResult, FinishBody, HeartbeatResult, RunEventInput } from './protocol'

export interface RunsApi {
  claim(runner: string, capacity: number): Promise<ClaimResult>
  sendEvents(
    runId: string,
    events: RunEventInput[],
    patch: { sessionId?: string | null; costUsd?: number; cwd?: string | null }
  ): Promise<HeartbeatResult>
  finish(runId: string, body: FinishBody): Promise<void>
  /** Bytes of a screenshot attached to a reply. */
  attachment?(runId: string, attachmentId: string): Promise<Uint8Array>
  /** An access marked for revocation has been removed from this host. */
  accessRevoked?(name: string): Promise<void>
}

export class RunsClient implements RunsApi {
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(baseUrl: string, token: string, runnerToken = '') {
    this.base = baseUrl.replace(/\/$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(runnerToken ? { 'x-runner-token': runnerToken } : {}),
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }

  claim(runner: string, capacity: number) {
    return this.post<ClaimResult>('/v1/agent-runs/claim', { runner, capacity })
  }

  sendEvents(
    runId: string,
    events: RunEventInput[],
    patch: { sessionId?: string | null; costUsd?: number; cwd?: string | null }
  ) {
    return this.post<HeartbeatResult>(`/v1/agent-runs/${runId}/events`, { events, ...patch })
  }

  async finish(runId: string, body: FinishBody): Promise<void> {
    await this.post(`/v1/agent-runs/${runId}/finish`, body)
  }

  async attachment(runId: string, attachmentId: string): Promise<Uint8Array> {
    const path = `/v1/agent-runs/${runId}/attachments/${attachmentId}`
    const res = await fetch(`${this.base}${path}`, { headers: this.headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async accessRevoked(name: string): Promise<void> {
    await this.post(`/v1/agent-accesses/${encodeURIComponent(name)}/revoked`, {})
  }
}
