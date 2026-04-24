/**
 * Channel abstraction — unified interface for all capture sources.
 */

import type { CapturedItem } from '../capture/normalizer'

export interface Channel {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
}

export type CaptureSink = (item: CapturedItem) => Promise<void>
