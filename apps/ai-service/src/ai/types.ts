/**
 * AI domain types shared across agents (Enricher, Proposer, Reviser).
 */

export type GtdCategory =
  | 'next' // actionable, single-step task
  | 'waiting' // delegated or blocked, waiting on someone
  | 'someday' // maybe/later, not actionable now
  | 'reference' // informational, no action required
  | 'two_minute' // < 2 min, should be done immediately
