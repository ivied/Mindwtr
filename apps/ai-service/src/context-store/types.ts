/**
 * Context Store types — domain model for capture memory layer.
 */

import type { CapturedItem } from '../capture/normalizer'

export interface CaptureRecord {
  id: string
  text: string
  sourceChannel: CapturedItem['sourceChannel']
  sourceMeta: Record<string, unknown> | null
  capturedAt: string
  receivedAt: string
  contentHash: string
  ttlAt: string
  isPull: boolean
}

export interface InsertResult {
  /** True when new record was inserted; false when L2 dedup matched */
  inserted: boolean
  capture: CaptureRecord
}

export interface SearchHit {
  capture: CaptureRecord
  /** Cosine similarity 0..1 (higher = more similar) when vec search; null for FTS */
  score: number | null
  /** 'vec' | 'fts' — how the hit was retrieved */
  via: 'vec' | 'fts'
}

export interface SearchOptions {
  topK?: number
  /** Filter by sourceChannel substring (e.g., ['screen_capture']) */
  sourceFilter?: string[]
  /** Only captures within this many ms from now (e.g., 7 * 24 * 3600_000) */
  withinMs?: number
}

export interface ContextStoreConfig {
  dbPath: string
  /** Default TTL applied to new captures (ms). 7 days default. */
  ttlMs: number
  /** L2 dedup window (ms). Same content_hash within this window is treated as duplicate. */
  l2WindowMs: number
}

export const DEFAULT_CONTEXT_STORE_CONFIG: ContextStoreConfig = {
  dbPath: '/app/data/context.db',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  l2WindowMs: 60 * 60 * 1000,
}
