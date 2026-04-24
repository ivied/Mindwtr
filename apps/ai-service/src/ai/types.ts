/**
 * AI Classification types — SGR pipeline output.
 */

export type GtdCategory =
  | 'next' // actionable, single-step task
  | 'waiting' // delegated or blocked, waiting on someone
  | 'someday' // maybe/later, not actionable now
  | 'reference' // informational, no action required
  | 'two_minute' // < 2 min, should be done immediately

export interface ClassificationResult {
  /** Primary GTD category */
  category: GtdCategory
  /** Is this noise (ads, spam, trivial) — keep in inbox but flag */
  is_noise: boolean
  noise_reason?: string
  /** GTD contexts: @home, @work, @errands, @phone, @computer */
  suggested_contexts: string[]
  /** Free-form tags */
  suggested_tags: string[]
  /** Should this be broken down into a project */
  is_project: boolean
  project_name?: string
  /** Delegation flag — item is about waiting for someone */
  is_delegation: boolean
  delegate_to?: string
  /** Confidence 0..1 */
  confidence: number
  /** Short human-readable reasoning */
  reasoning: string
}

export interface ClassifierInput {
  text: string
  sourceChannel: string
  capturedAt: string
  /** Optional additional context from previous items */
  priorContext?: string
}

export interface TaskMetadata {
  ai_category: GtdCategory
  ai_confidence: number
  ai_reasoning: string
  ai_is_noise: boolean
  ai_noise_reason?: string
  ai_is_project: boolean
  ai_project_name?: string
  ai_is_delegation: boolean
  ai_delegate_to?: string
  ai_classified_at: string
  source_channel: string
}
