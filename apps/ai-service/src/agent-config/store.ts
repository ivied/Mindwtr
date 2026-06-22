/**
 * AgentConfigStore — the control-plane state the capture-agent obeys
 * (Phase 3). Currently just the remote pause switch: the web Control Center
 * sets it, the capture-agent polls it and stops capturing while true.
 *
 * File-backed so a paused state survives an ai-service restart — resuming
 * capture on a crash would be a privacy regression, so we fail toward the
 * last persisted intent.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AgentConfig {
  capturePaused: boolean;
  /** ISO time the pause state last changed, for UI display. */
  updatedAt: string | null;
}

const DEFAULT: AgentConfig = { capturePaused: false, updatedAt: null };

export class AgentConfigStore {
  private state: AgentConfig;

  constructor(private readonly path: string) {
    this.state = this.load();
  }

  private load(): AgentConfig {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return { capturePaused: Boolean(raw.capturePaused), updatedAt: raw.updatedAt ?? null };
    } catch {
      return { ...DEFAULT };
    }
  }

  get(): AgentConfig {
    return { ...this.state };
  }

  setCapturePaused(paused: boolean): AgentConfig {
    this.state = { capturePaused: paused, updatedAt: new Date().toISOString() };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state), 'utf8');
    } catch {
      /* in-memory still reflects the change; next write retries */
    }
    return this.get();
  }
}
