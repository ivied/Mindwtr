/**
 * Procedural memory (FR85, Phase 0).
 *
 * Read-only mirror of long-form playbook/journal markdown (initially
 * OpenClaw's MEMORY.md rsync'd into the shared-memory dir), chunked by
 * `##` sections, embedded, and surfaced to the Proposer as a
 * KNOWN_PLAYBOOK block alongside RECENT_CONTEXT.
 *
 * Wire-format is markdown so OpenCode and other downstream agents can
 * consume the same source without going through this service.
 */

export { chunkMarkdown, type RawChunk } from './chunker'
export { ProceduralStore } from './store'
export type {
  AppliesTo,
  ClassifiedBy,
  ProceduralChunkRow,
  ProceduralStoreOptions,
  UpsertInput,
} from './store'
export { ProceduralReader } from './reader'
export type { ProceduralReaderOptions, ScanStats } from './reader'
export { ProceduralRetriever, DEFAULT_APPLIES_FILTER } from './retriever'
export type { RetrieveOptions, RetrievedChunk } from './retriever'
export { ProceduralProposerBlock } from './proposer-block'
export type {
  ProceduralProposerBlockOptions,
  ProceduralContextProvider,
} from './proposer-block'
export { classifyByHeuristic, LlmChunkClassifier } from './classifier'
export type { ClassificationVerdict, LlmClassifierOptions } from './classifier'
