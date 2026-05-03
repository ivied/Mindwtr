/**
 * In-memory store of pending proposals waiting for user approval.
 *
 * Each captured passive item that the Proposer flagged as actionable
 * is registered here, presented to the user via TG, and either approved
 * (→ creates inbox task) or rejected (→ dropped).
 *
 * Bounded so a runaway capture loop can't OOM the process.
 * MVP: lost on restart. We'll move to file/SQLite later.
 */

import { randomUUID } from 'node:crypto'
import type { CapturedItem } from '../capture/normalizer'
import type { Proposal } from '../ai/proposer'

export interface PendingProposal {
  id: string
  capturedItem: CapturedItem
  proposal: Proposal
  createdAt: number
}

export interface ProposalStoreConfig {
  /** Maximum pending proposals; oldest evicted when exceeded. */
  capacity: number
  /** Drop proposals older than this. */
  ttlMs: number
}

export const DEFAULT_PROPOSAL_STORE_CONFIG: ProposalStoreConfig = {
  capacity: 200,
  ttlMs: 24 * 60 * 60 * 1000,
}

export class ProposalStore {
  private map = new Map<string, PendingProposal>()

  constructor(
    private config: ProposalStoreConfig = DEFAULT_PROPOSAL_STORE_CONFIG,
    private now: () => number = () => Date.now()
  ) {}

  add(capturedItem: CapturedItem, proposal: Proposal): PendingProposal {
    this.evictExpired()
    while (this.map.size >= this.config.capacity) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
    const entry: PendingProposal = {
      id: randomUUID(),
      capturedItem,
      proposal,
      createdAt: this.now(),
    }
    this.map.set(entry.id, entry)
    return entry
  }

  take(id: string): PendingProposal | null {
    this.evictExpired()
    const entry = this.map.get(id)
    if (!entry) return null
    this.map.delete(id)
    return entry
  }

  size(): number {
    this.evictExpired()
    return this.map.size
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.config.ttlMs
    for (const [id, entry] of this.map) {
      if (entry.createdAt < cutoff) this.map.delete(id)
    }
  }
}
