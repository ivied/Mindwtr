/**
 * Public surface of the memory module.
 *
 * Wire-up from index.ts:
 *
 *   const memoryStore = new MemoryStore({ db: contextStore.rawDb, vecAvailable: contextStore.hasVectorSearch })
 *   const memoryExtractor = new UnifiedExtractor(llm)
 *   const memoryIngest = new IngestService({ store: memoryStore, embeddings, extractor: memoryExtractor })
 *   const memoryRetriever = new HybridRetriever(memoryStore, embeddings)
 *   const focusContext = new FocusContextAssembler({ store: memoryStore, retriever: memoryRetriever, llm })
 *   const dailySummaryJob = new DailySummaryJob({ store: memoryStore, llm, embeddings })
 */

export { MemoryStore, contentHash } from './store'
export { UnifiedExtractor, parseExtractorOutput } from './extractor'
export type {
  ExtractedEntity,
  ExtractedFact,
  ExtractInput,
  ExtractOutput,
  EntityType,
  FactType as ExtractorFactType,
} from './extractor'
export { IngestService, parseCaptureMd } from './ingest'
export type { IngestLiveInput, IngestLiveResult } from './ingest'
export { HybridRetriever } from './retrieve'
export type { RetrieveOptions } from './retrieve'
export { FocusContextAssembler } from './focus-context'
export type { AssembleArgs } from './focus-context'
export { DailySummaryJob } from './daily-summary'
export type { DailySummaryResult } from './daily-summary'
export { MemoryProposerContext } from './proposer-context'
export type { ProposerContextProvider } from './proposer-context'
export { SlugCanonicalizer } from './slug-canonicalizer'
export type { SlugCanonicalizerOptions } from './slug-canonicalizer'
export { ProactiveRunner, parseProactiveOutput, parseCompletionOutput } from './proactive-runner'
export type { ProactiveRunnerOptions } from './proactive-runner'
export {
  DEFAULT_PROACTIVE_CONFIG,
  PROACTIVE_SOURCE_AGENT,
} from './proactive-types'
export type {
  ProactiveConfig,
  ProactiveDecision,
  ProactiveEvaluation,
  ProactiveRunResult,
  StaleFactGroup,
  CompletionEvaluation,
  TaskVerdict,
  OpenTaskDecision,
  ReversePassResult,
  ProactiveCombinedResult,
} from './proactive-types'
export type {
  Event,
  NewEventInput,
  Fact,
  NewFactInput,
  FactType,
  DailySummary,
  RetrievedEvent,
  FocusContext,
} from './types'
