import { join } from 'node:path'
import { MindwtrClient } from './api/mindwtr-client'
import { LLMClient } from './ai/client'
import { ContextRetriever } from './ai/retriever'
import { createBot } from './bot'
import { createCaptureSink } from './capture/sink'
import type { Channel } from './channels/types'
import { SlackChannel } from './channels/slack'
import { NotionChannel } from './channels/notion'
import { TelegramUserChannel } from './channels/telegram-user'
import { FileStateStore, channelStateFile } from './channels/state-store'
import { SlackSessionStore, slackSessionFile } from './channels/slack-session-store'
import { ContextStore } from './context-store/store'
import { OpenAIEmbeddings } from './context-store/embeddings'
import { ProposalStore } from './proposal-store/store'
import { ProposalApplier } from './proposal-store/apply'
import { CommentHandler } from './proposal-store/comment-handler'
import { TaskChangeProcessor } from './proposal-store/task-change-processor'
import { ProposalExpiryJob } from './proposal-store/expiry'
import { Proposer } from './commitment/proposer'
import { Enricher } from './commitment/enricher'
import { EnricherPipeline } from './commitment/enricher-pipeline'
import { ThreadTargetSelector } from './commitment/thread-target-selector'
import { Reviser } from './commitment/reviser'
import { ProposalWriter } from './commitment/writer'
import { SuggestionRefresher } from './commitment/suggestion-refresher'
import { SOURCE_AGENT_ENRICHER } from './commitment/enricher-pipeline'
import { buildSignature } from './commitment/title-signature'
import { CommitmentPipeline, DEFAULT_PIPELINE_CONFIG } from './commitment/pipeline'
import type { DuplicateOfExistingHook } from './commitment/pipeline'
import { CommitmentBatcher } from './commitment/batcher'
import { denyConfigFromEnv } from './commitment/source-deny'
import { MindwtrInboxTitles } from './commitment/inbox-titles'
import { WikiPersonsProvider } from './wiki/persons-reader'
import { WikiGlossaryProvider, MemoryExpansionSource } from './wiki/glossary-reader'
import { GlossaryStore, GlossaryStoreSource } from './wiki/glossary-store'
import { OnboardingExtractor } from './memory/onboarding-extractor'
import { ProposalNotifier } from './bot/proposal-notifier'
import { createHttpServer } from './http/server'
import {
  MemoryStore,
  UnifiedExtractor,
  IngestService,
  HybridRetriever,
  FocusContextAssembler,
  DailySummaryJob,
  MemoryProposerContext,
  ProactiveRunner,
} from './memory'
import { SlugCanonicalizer } from './memory/slug-canonicalizer'
import { EntityRegistryStore } from './memory/entity-registry-store'
import { EntityRegistrar } from './memory/entity-registrar'
import { EntityPipeline } from './memory/entity-pipeline'
import { LlmPublisher } from './status/llm-publisher'
import { HealthMonitor, HealthAlerter } from './status/health'
import { startAgentWatchdog, DEFAULT_AGENT_WATCHDOG_CONFIG } from './agent-watchdog'
import { ReviewNotifier } from './agent-watchdog/review-notifier'
import {
  ProceduralStore,
  ProceduralReader,
  ProceduralRetriever,
  ProceduralProposerBlock,
  LlmChunkClassifier,
} from './memory/procedural'
import { RecordingDistiller, RecordingSessionStore } from './recording'
import { AgentConfigStore } from './agent-config/store'

const MINDWTR_CLOUD_URL = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
const MINDWTR_AUTH_TOKEN = process.env.MINDWTR_AUTH_TOKEN ?? ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? ''
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
// Two tiers behind one proxy. Heavy reasoning nodes use OPUS; lightweight
// classify/select/extract/summarize nodes use SONNET. LLM_MODEL stays as the
// opus alias for backward-compatible deployments. The LLMClient falls one tier
// back to the other when its primary model errors on the proxy.
const LLM_MODEL_OPUS = process.env.LLM_MODEL_OPUS ?? process.env.LLM_MODEL ?? 'cx/gpt-5.5'
const LLM_MODEL_SONNET = process.env.LLM_MODEL_SONNET ?? 'cx/gpt-5.4-mini'
// Cross-provider safety net: tried after both primary tiers fail (e.g. the
// primary provider's shared quota pool is exhausted). Empty = disabled.
const LLM_MODEL_OPUS_FALLBACK = process.env.LLM_MODEL_OPUS_FALLBACK ?? ''
const LLM_MODEL_SONNET_FALLBACK = process.env.LLM_MODEL_SONNET_FALLBACK ?? ''

// Comma-separated xoxp- user tokens, one per workspace. "See what I see"
// across workspaces the user doesn't own (bot tokens can't do this).
const SLACK_USER_TOKENS = (process.env.SLACK_USER_TOKENS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// Browser session tokens for workspaces where we CAN'T install an app:
// `xoxc-token|xoxd-cookie` pairs, comma-separated. Telethon-style — uses the
// user's own browser session, no OAuth install. xoxc rotates; against ToS.
const SLACK_SESSION_TOKENS = (process.env.SLACK_SESSION_TOKENS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [token, cookie] = pair.split('|').map((s) => s.trim())
    return { token: token ?? '', cookie: cookie ?? '' }
  })
  .filter((w) => w.token.startsWith('xoxc-') && w.cookie.startsWith('xoxd-'))
const SLACK_POLL_INTERVAL_MS = Number(process.env.SLACK_POLL_INTERVAL_MS ?? 5 * 60 * 1000)
// Comma-separated Slack team IDs to poll. The extension pushes every signed-in
// workspace; this keeps only the ones that matter. Empty = poll all.
const SLACK_TEAM_ALLOWLIST = new Set(
  (process.env.SLACK_TEAM_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

// Telegram user-account feed (MTProto, "see what I see" — DMs + groups).
// Both empty = disabled. Session comes from a one-time interactive login
// (scripts/telegram-login.ts) persisted under DATA_DIR.
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 0)
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? ''

const NOTION_API_KEY = process.env.NOTION_API_KEY ?? ''
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID ?? ''
const NOTION_POLL_INTERVAL_MS = Number(process.env.NOTION_POLL_INTERVAL_MS ?? 5 * 60 * 1000)

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3030)
const HTTP_AUTH_TOKEN = process.env.HTTP_AUTH_TOKEN ?? ''
const HTTP_CORS_ORIGINS = (process.env.HTTP_CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Telegram chat to push proposal notifications to. Empty disables push.
const TG_NOTIFY_CHAT_ID = process.env.TG_NOTIFY_CHAT_ID ?? ''
// Mindwtr web UI base URL — used for TG deep-links from notification cards
// and from /proposals list rows. Default points at local docker exposed port.
const MINDWTR_WEB_URL = process.env.MINDWTR_WEB_URL ?? 'http://localhost:5173'

// Identity anchor — Proposer maps first-person pronouns / message authors
// against this when deciding who_owes / recipient. Without it, OCR of a chat
// where "я Flutter завтра скажу" is authored by someone else gets mis-attributed
// to the user.
const USER_IDENTITY_NAME = process.env.USER_IDENTITY_NAME ?? ''
const USER_IDENTITY_ALIASES = (process.env.USER_IDENTITY_ALIASES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Path to capture-wiki root. Empty disables the persons-registry feed into
// the Proposer (who_to stays as literal OCR strings instead of canonical slugs).
const WIKI_DIR = process.env.WIKI_DIR ?? ''

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small'

const DATA_DIR = process.env.DATA_DIR ?? '/app/data'
const CONTEXT_STORE_TTL_DAYS = Number(process.env.CONTEXT_STORE_TTL_DAYS ?? 7)

// Procedural memory root (FR85). Read-only mirror of long-form playbook
// + journal markdown — initially OpenClaw's MEMORY.md rsync'd by a host
// cron. Empty disables the feature (Proposer skips the KNOWN_PLAYBOOK
// block). Sub-dirs map to logical sources (`openclaw/`, future `notion/`).
const SHARED_MEMORY_DIR = process.env.SHARED_MEMORY_DIR ?? ''
const SHARED_MEMORY_REINDEX_INTERVAL_MS = Number(
  process.env.SHARED_MEMORY_REINDEX_INTERVAL_MS ?? 60_000
)

// Entity layer (registry + cards + facts). Shadow mode: accumulates knowledge
// from events on a cadence; nothing reads the tables yet. Set
// ENTITY_PIPELINE=false to disable (e.g. worktrees sharing an LLM budget).
const ENTITY_PIPELINE_ENABLED = process.env.ENTITY_PIPELINE !== 'false'
const ENTITY_PIPELINE_INTERVAL_MS = Number(process.env.ENTITY_PIPELINE_INTERVAL_MS ?? 15 * 60 * 1000)
const ENTITY_OWNER_SLUG = process.env.ENTITY_OWNER_SLUG ?? 'sergey-kurdyuk'

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required')
  process.exit(1)
}

if (!MINDWTR_AUTH_TOKEN) {
  console.error('MINDWTR_AUTH_TOKEN is required')
  process.exit(1)
}

const mindwtr = new MindwtrClient({
  baseUrl: MINDWTR_CLOUD_URL,
  authToken: MINDWTR_AUTH_TOKEN,
})

// --- Context Store + Embeddings ---
const embeddings = OPENAI_API_KEY
  ? new OpenAIEmbeddings({
      apiKey: OPENAI_API_KEY,
      model: EMBEDDINGS_MODEL,
      baseUrl: OPENAI_BASE_URL,
    })
  : null
if (!embeddings) {
  console.warn('⚠️ OPENAI_API_KEY not set — embeddings disabled, retrieval will use FTS only')
}

const contextStore = ContextStore.open(
  {
    dbPath: join(DATA_DIR, 'context.db'),
    ttlMs: CONTEXT_STORE_TTL_DAYS * 24 * 60 * 60 * 1000,
  },
  embeddings
)
console.log(
  `📚 Context Store opened (${contextStore.hasVectorSearch ? 'vec+FTS' : 'FTS only'}, TTL ${CONTEXT_STORE_TTL_DAYS}d, current size ${contextStore.size()})`
)

// Proposal Store shares the same SQLite handle as Context Store so that
// proposal creation can reference capture rows transactionally.
const proposalStore = new ProposalStore(contextStore.rawDb)
const proposalApplier = new ProposalApplier(proposalStore, mindwtr)
const taskChangeProcessor = new TaskChangeProcessor(proposalStore)

// Persons registry — single shared instance: Proposer pipeline reads it
// for who_to canonicalization, HTTP server exposes it at GET /v1/persons
// for the desktop AssignedToPicker autocomplete.
const personsProvider = WIKI_DIR ? new WikiPersonsProvider({ wikiDir: WIKI_DIR }) : null

// Memory module — long-lived events + LLM-extracted facts. Reuses the
// Context Store SQLite handle (migration v3 adds the tables). Independent
// of the existing short-TTL Context Store; powers /v1/memory/* and the
// focus-context surface that future proactive features will consume.
const memoryStore = new MemoryStore({
  db: contextStore.rawDb,
  vecAvailable: contextStore.hasVectorSearch,
})
const memoryRetriever = new HybridRetriever(memoryStore, embeddings)
// Glossary decoder ring — non-person entities (project codenames, acronyms,
// internal terms) from the capture-wiki, decoded via the memory module's
// active facts. Feeds a KNOWN_GLOSSARY block into Proposer + Enricher so
// shorthand gets spelled out. Same WIKI_DIR gate as persons.
// Writable glossary table (onboarding-confirmed / rejected decodings). Lives
// in the same SQLite handle. Read by the provider (confirmed wins, rejected
// suppressed) and written by the onboarding wizard via HTTP.
const glossaryStore = new GlossaryStore(contextStore.rawDb)
const glossaryProvider = WIKI_DIR
  ? new WikiGlossaryProvider({
      wikiDir: WIKI_DIR,
      expansions: new MemoryExpansionSource(memoryStore),
      confirmed: new GlossaryStoreSource(glossaryStore),
    })
  : null
// Slug canonicalizer — folds extractor's free-form slugs (e.g. "sergey",
// "sergey-kurd") into the wiki's canonical form ("sergey-kurdyuk") via
// the wiki entity's frontmatter aliases. Best-effort: if WIKI_DIR is
// unset or the wiki dir is empty, ingest still works (passes slugs through).
const slugCanonicalizer = WIKI_DIR ? new SlugCanonicalizer({ wikiDir: WIKI_DIR }) : null
// Kicked off async; the first few captures may miss the map but it's
// idempotent and self-heals on the next /v1/admin/canonicalize rebuild.
if (slugCanonicalizer) {
  void slugCanonicalizer.rebuild().catch((err) =>
    console.warn('[slug-canonicalizer] initial rebuild failed:', (err as Error).message)
  )
}
// Ingest with NO extractor: live captures embed + insert; per-capture LLM
// extraction is intentionally NOT wired in the hot path (keeps the
// inbox-proposal latency budget the Proposer already owns). Facts will be
// filled in by a background pass / future on-demand sweep.
let memoryIngest: IngestService | null = new IngestService({
  store: memoryStore,
  embeddings,
  extractor: null,
  canonicalizer: slugCanonicalizer,
})
let memoryFocusContext: FocusContextAssembler | null = null
let dailySummaryJob: DailySummaryJob | null = null
let proactiveRunner: ProactiveRunner | null = null
let entityPipeline: EntityPipeline | null = null
// Hoisted so the HTTP server (FR88 review API) can reference it; assigned
// inside the SHARED_MEMORY_DIR block below when procedural memory is on.
let proceduralStore: ProceduralStore | null = null
let proceduralReader: ProceduralReader | null = null
const recordingStore = new RecordingSessionStore(contextStore.rawDb)
const agentConfig = new AgentConfigStore(join(DATA_DIR, 'agent-config.json'))
let recordingDistiller: RecordingDistiller | null = null

// --- AI Enricher (push) + Commitment Detector (pull) + Reviser ---
let enricherPipeline: EnricherPipeline | null = null
let commitmentPipeline: CommitmentPipeline | null = null
let commentHandler: CommentHandler | null = null
let onboardingExtractor: OnboardingExtractor | null = null
if (LLM_BASE_URL && LLM_API_KEY) {
  const llm = new LLMClient(LLM_BASE_URL, LLM_API_KEY, {
    opus: LLM_MODEL_OPUS,
    sonnet: LLM_MODEL_SONNET,
    fallbackOpus: LLM_MODEL_OPUS_FALLBACK || undefined,
    fallbackSonnet: LLM_MODEL_SONNET_FALLBACK || undefined,
  })
  const retriever = new ContextRetriever(contextStore)

  // Onboarding/cold-start glossary seeding — uses the cheaper sonnet tier.
  onboardingExtractor = new OnboardingExtractor(llm, LLM_MODEL_SONNET)

  const enricher = new Enricher(llm, LLM_MODEL_OPUS)
  enricherPipeline = new EnricherPipeline({
    enricher,
    proposalStore,
    retriever,
  })
  // LLM-based run-target selection for AI-routable tasks: reads the live Mac
  // thread registry + playbook hint and picks the session/repo/openclaw the
  // way a human would. Falls back to the deterministic keyword matcher.
  enricherPipeline.setTargetSelector(new ThreadTargetSelector(llm, LLM_MODEL_SONNET))
  // Glossary decoder ring — Enricher spells out shorthand in title/description.
  if (glossaryProvider) {
    enricherPipeline.setGlossaryProvider(glossaryProvider)
  }
  console.log(
    `🪄 Enricher enabled (opus=${LLM_MODEL_OPUS}, sonnet=${LLM_MODEL_SONNET}) — push captures → modify/split proposals`
  )

  const proposer = new Proposer(llm, LLM_MODEL_OPUS)
  const writer = new ProposalWriter(proposalStore)
  const sourceDeny = denyConfigFromEnv()
  commitmentPipeline = new CommitmentPipeline(proposer, writer, {
    ...DEFAULT_PIPELINE_CONFIG,
    sourceDeny,
  })
  // Feed recent Mindwtr inbox titles to Proposer so it can suppress
  // paraphrase duplicates of cards the user already has.
  commitmentPipeline.setInboxTitlesProvider(
    new MindwtrInboxTitles({ client: mindwtr, proposalStore })
  )
  // Re-enrichment loop: a capture suppressed as duplicate-of-existing is
  // NEW INFORMATION about a task the user already has ("перепоручил Насте"
  // about an open card). Resolve the matched title back to the task and
  // re-run the Enricher with the capture as NEW_EVIDENCE — the pending
  // suggestion gets a v2 instead of the signal being dropped.
  const enricherForReEnrich = enricherPipeline
  const reviser = new Reviser(llm, LLM_MODEL_OPUS)
  const suggestionRefresher = new SuggestionRefresher({
    store: proposalStore,
    reviser,
    contextStore,
  })
  commitmentPipeline.setDuplicateOfExistingHook((info) => {
    void (async () => {
      try {
        // Proposer said the capture REPORTS this item as already done
        // (completes_title). Post the done-nudge directly on the matched
        // pending suggestion — no Reviser round-trip needed. When no pending
        // proposal matches (real task or stale title), fall through to the
        // normal evidence-folding path so the signal still lands somewhere.
        if (info.completion) {
          const flag = suggestionRefresher.flagCompletion(info.existingTitle)
          if (flag.kind !== 'no-match') {
            console.log(
              `[completes] pending suggestion ${flag.proposalId.slice(0, 8)} ${flag.kind} for "${info.existingTitle.slice(0, 50)}"`
            )
            return
          }
        }
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
        const wanted = norm(info.existingTitle)
        let match: Awaited<ReturnType<typeof mindwtr.listTasks>>[number] | undefined
        for (const status of ['inbox', 'next', 'waiting'] as const) {
          const tasks = await mindwtr.listTasks({ status, limit: 200 })
          match = tasks.find((t) => norm(t.title ?? '') === wanted)
          if (match) break
        }
        if (!match) {
          // No real Mindwtr task — the title may belong to a pending proposal
          // that hasn't been approved/materialized yet. Refresh it in place
          // rather than dropping the new evidence.
          await refreshPendingProposal(info)
          return
        }
        const outcome = await enricherForReEnrich.run({
          taskId: match.id,
          taskTitle: match.title,
          taskTags: match.tags ?? [],
          taskDescription: match.description ?? '',
          taskStatus: match.status,
          text: match.title + (match.description ? '\n' + match.description : ''),
          newEvidence: info.captureText,
          sourceChannel: info.sourceChannel,
          sourceMeta: {
            ...(info.sourceMeta ?? {}),
            reenrich_trigger: 'duplicate-of-existing',
            proposer_reasoning: info.reasoning,
          },
          sourceCaptureId: info.sourceCaptureId,
        })
        console.log(
          `[re-enrich] task ${match.id.slice(0, 8)} "${match.title.slice(0, 50)}" → ${outcome.kind}${outcome.kind === 'proposed' ? ` (${outcome.type} ${outcome.proposalId.slice(0, 8)})` : ` (${outcome.reason})`}`
        )
      } catch (err) {
        console.error('[re-enrich] failed:', (err as Error).message)
      }
    })()
  })

  // Fallback when no real Mindwtr task matched the duplicate-of-existing title:
  // the title may belong to a pending proposal. Refresh create-suggestions via
  // the Reviser; re-enrich pending enricher proposals against their real task.
  async function refreshPendingProposal(
    info: Parameters<DuplicateOfExistingHook>[0]
  ): Promise<void> {
    const result = await suggestionRefresher.refresh({
      existingTitle: info.existingTitle,
      captureText: info.captureText,
    })
    if (result.kind !== 'no-match') {
      const doneTag = 'doneSuspected' in result && result.doneSuspected ? ' (done-suspected)' : ''
      console.log(
        `[refresh] pending suggestion ${result.kind}${'proposalId' in result ? ` ${result.proposalId.slice(0, 8)}` : ''}${doneTag} for "${info.existingTitle.slice(0, 50)}"`
      )
      return
    }

    // No pending create-suggestion — try pending enricher proposals (modify/
    // split) whose origin-snapshot title matches. Re-run the enricher against
    // the proposal's real target task so the new evidence lands as a v2.
    const norm = (s: string) => buildSignature(s, null, null).split('|')[0]
    const wantedTitle = norm(info.existingTitle)
    const enricherPending = proposalStore.listPending({
      sourceAgent: SOURCE_AGENT_ENRICHER,
      limit: 300,
    })
    const enricherMatch = enricherPending.find((p) => {
      const snap = p.originSnapshot as { title?: unknown } | null
      const title = typeof snap?.title === 'string' ? snap.title : null
      return title !== null && norm(title) === wantedTitle
    })
    if (!enricherMatch) {
      console.log(
        `[refresh] no pending proposal matched "${info.existingTitle.slice(0, 50)}" — skip`
      )
      return
    }
    const taskId = enricherMatch.targetTaskIds[0]
    if (!taskId) return
    let task: Awaited<ReturnType<typeof mindwtr.getTask>>
    try {
      task = await mindwtr.getTask(taskId)
    } catch {
      console.log(
        `[refresh] enricher target ${taskId.slice(0, 8)} unreadable — skip`
      )
      return
    }
    const outcome = await enricherForReEnrich.run({
      taskId: task.id,
      taskTitle: task.title,
      taskTags: task.tags ?? [],
      taskDescription: task.description ?? '',
      taskStatus: task.status,
      text: task.title + (task.description ? '\n' + task.description : ''),
      newEvidence: info.captureText,
      sourceChannel: info.sourceChannel,
      sourceMeta: {
        ...(info.sourceMeta ?? {}),
        reenrich_trigger: 'duplicate-of-pending-enricher',
        proposer_reasoning: info.reasoning,
      },
      sourceCaptureId: info.sourceCaptureId,
    })
    console.log(
      `[refresh] re-enriched pending ${enricherMatch.id.slice(0, 8)} task ${task.id.slice(0, 8)} → ${outcome.kind}`
    )
  }
  // Identity anchor for role disambiguation. Empty USER_IDENTITY_NAME = no
  // anchor (Proposer reverts to "user = machine owner" heuristic).
  if (USER_IDENTITY_NAME) {
    commitmentPipeline.setUserIdentity({
      name: USER_IDENTITY_NAME,
      aliases: USER_IDENTITY_ALIASES,
    })
  }
  // Persons registry — Proposer normalizes who_to against canonical wiki
  // slugs so waiting-for tasks stay consistent across captures.
  if (personsProvider) {
    commitmentPipeline.setPersonsProvider(personsProvider)
  }
  // Glossary decoder ring — Proposer spells out project codenames / acronyms /
  // internal terms when they appear in a capture.
  if (glossaryProvider) {
    commitmentPipeline.setGlossaryProvider(glossaryProvider)
  }
  // Historical context from the memory module — when events are present,
  // top-K related events + active facts are passed to the Proposer as
  // RECENT_CONTEXT. Costs one embedding call per capture; SQL is local.
  if (embeddings) {
    commitmentPipeline.setMemoryContextProvider(
      new MemoryProposerContext({ store: memoryStore, retriever: memoryRetriever })
    )
  }
  // Procedural memory (FR85) — top-K relevant playbook chunks from the
  // shared-memory mirror surfaced as KNOWN_PLAYBOOK. Disabled when
  // SHARED_MEMORY_DIR is unset (legacy/dev environments without the rsync
  // job set up). One additional embedding call per capture when enabled.
  if (SHARED_MEMORY_DIR) {
    proceduralStore = new ProceduralStore({
      db: contextStore.rawDb,
      vecAvailable: contextStore.hasVectorSearch,
    })
    // Phase 0.5 (FR86): classify each chunk before it surfaces to the
    // Proposer. Heuristic runs at upsert (cheap regex); LLM batches what's
    // left as 'needs-review' each tick — capped at 10 chunks/tick so we
    // don't blow the budget on a fresh import.
    const procClassifier = new LlmChunkClassifier({ llm, model: LLM_MODEL_SONNET })
    proceduralReader = new ProceduralReader({
      store: proceduralStore,
      rootDir: SHARED_MEMORY_DIR,
      sources: [
        { subdir: 'openclaw', source: 'openclaw' },
        // Mined rules (Slack/Notion/Telegram → topic.md), one subdir per source.
        // Tolerates the directory being absent until the Playbook Miner runs.
        { subdir: 'mined', source: 'mined' },
        // Hand-written rules created via the AI Playbook UI. One file per rule
        // (user/<topic-slug>.md) keeps CRUD simple — delete = unlink.
        { subdir: 'user', source: 'user' },
      ],
      // Allow top-level *.md (openclaw/MEMORY.md) AND one level of nesting
      // (mined/<source>/<topic>.md) so the miner's per-source layout indexes.
      pathFilter: (rel) => /^([^/\\]+\.md|[^/\\]+[\\/][^/\\]+\.md)$/i.test(rel),
      embeddings,
      intervalMs: SHARED_MEMORY_REINDEX_INTERVAL_MS,
      llmClassifier: procClassifier,
      llmClassifyBatchSize: 10,
    })
    proceduralReader.start()
    const proceduralRetriever = new ProceduralRetriever(proceduralStore, embeddings)
    const playbookBlock = new ProceduralProposerBlock({ retriever: proceduralRetriever })
    commitmentPipeline.setProceduralContextProvider(playbookBlock)
    // FR89: record which playbook chunks fed each written proposal so
    // approve/reject can adjust their reliability_score.
    commitmentPipeline.setProceduralFeedback(proceduralStore)
    // The Enricher gets the same KNOWN_PLAYBOOK block — recorded procedures
    // and channel rules shape its title/description/tags/split suggestions.
    enricherPipeline.setProceduralContextProvider(playbookBlock)
    enricherPipeline.setProceduralFeedback(proceduralStore)
    console.log(
      `📖 Procedural memory enabled (root=${SHARED_MEMORY_DIR}, reindex=${SHARED_MEMORY_REINDEX_INTERVAL_MS}ms, chunks=${proceduralStore.countChunks()}, classifier=llm)`
    )

    // Phase 2c: distillation worker. Sweeps stopped, undistilled sessions
    // every 30s; the stop endpoint can also fire it immediately for the
    // freshly-stopped session via the hook in HttpServerConfig.recordings.
    recordingDistiller = new RecordingDistiller({
      llm,
      model: LLM_MODEL_OPUS,
      db: contextStore.rawDb,
      sessionStore: recordingStore,
      proceduralStore,
      proceduralReader: proceduralReader!,
      sharedMemoryDir: SHARED_MEMORY_DIR,
      log: (msg) => console.log(msg),
      onDraftReady: (session, chunkId) => {
        const label = session.taskTitle ?? session.taskId
        console.log(
          `🎙 Recording distilled: "${label}" → chunk ${chunkId?.slice(0, 8) ?? '(unindexed)'}`
        )
      },
    })
    setInterval(
      () =>
        void recordingDistiller!
          .distillPending()
          .catch((err: Error) => console.error('[distill] sweep failed:', err.message)),
      30_000
    )
    console.log('🎙 Recording distiller enabled (30s sweep)')
  }
  console.log(
    `🎯 Commitment Detector enabled (deny apps:${sourceDeny.apps.length}, deny urls:${sourceDeny.urlPatterns.length}, inbox-dedup on, identity:${USER_IDENTITY_NAME || 'unset'}, persons:${personsProvider ? 'wiki' : 'unset'})`
  )

  commentHandler = new CommentHandler({
    store: proposalStore,
    reviser,
    mindwtr,
    contextStore,
  })
  console.log('💬 Proposal dialogue enabled (Reviser)')

  // Memory module wire-up requires the same LLM client.
  const memoryExtractor = new UnifiedExtractor(llm, LLM_MODEL_SONNET)
  memoryIngest = new IngestService({
    store: memoryStore,
    embeddings,
    extractor: memoryExtractor,
    canonicalizer: slugCanonicalizer,
  })
  memoryFocusContext = new FocusContextAssembler({
    store: memoryStore,
    retriever: memoryRetriever,
    llm,
    model: LLM_MODEL_SONNET,
  })
  dailySummaryJob = new DailySummaryJob({
    store: memoryStore,
    llm,
    embeddings,
    model: LLM_MODEL_SONNET,
  })
  // Proactive runner — surfaces follow-up proposals from stale facts.
  // Source-agent='proactive-runner' on every proposal so UI / audit can
  // tell them apart from commitment-detector and enricher.
  proactiveRunner = new ProactiveRunner({
    memoryStore,
    proposalStore,
    llm,
    model: LLM_MODEL_OPUS,
    mindwtrClient: mindwtr,
    retriever: memoryRetriever,
  })
  console.log(
    `🧠 Memory module enabled (${memoryStore.vecAvailable ? 'vec+FTS' : 'FTS only'}, ${memoryStore.countEvents()} events, ${memoryStore.countFacts()} facts)`
  )

  // Entity layer (shadow mode) — registry + cards + facts + About + glossary
  // questions, caught up window-by-window from the events table. Nothing
  // consumes these tables yet; this runs to accumulate knowledge and let us
  // audit quality before wiring it into the Proposer.
  if (ENTITY_PIPELINE_ENABLED) {
    const entityRegistry = new EntityRegistryStore(contextStore.rawDb)
    const entityRegistrar = new EntityRegistrar({
      registry: entityRegistry,
      memory: memoryStore,
      llm,
      model: LLM_MODEL_OPUS,
    })
    entityPipeline = new EntityPipeline({
      db: contextStore.rawDb,
      memory: memoryStore,
      registry: entityRegistry,
      registrar: entityRegistrar,
      llm,
      model: LLM_MODEL_OPUS,
      ownerSlug: ENTITY_OWNER_SLUG,
      log: (msg) => console.log(msg),
    })
    console.log(
      `🗂 Entity pipeline enabled (shadow mode, owner=${ENTITY_OWNER_SLUG}, tick every ${Math.round(ENTITY_PIPELINE_INTERVAL_MS / 60000)}m, registry=${entityRegistry.count()}, cards=${entityPipeline.cardStore().count()})`
    )
  }

  // Two-stage pull pattern: after a Proposer create-proposal lands a task in
  // Mindwtr inbox, kick the Enricher pipeline on it so the user gets a
  // follow-up modify proposal with category/contexts/tags/SMART. Pull
  // becomes symmetric with push (TG → inbox task → Enricher → modify).
  const enricherForApplier = enricherPipeline
  if (enricherForApplier) {
    proposalApplier.setPostCreateHook((taskId, proposal) => {
      const payload = proposal.currentPayload as
        | { kind?: string; task?: { title?: string; description?: string; tags?: string[] }; traceback?: { sourceChannel?: string; sourceMeta?: Record<string, unknown> | null } }
        | null
      if (!payload || payload.kind !== 'create' || !payload.task) return
      const task = payload.task
      const text = (task.title ?? '') + (task.description ? '\n' + task.description : '')
      void enricherForApplier
        .run({
          taskId,
          taskTitle: task.title ?? '',
          taskTags: task.tags ?? [],
          taskDescription: task.description ?? '',
          text,
          sourceChannel: payload.traceback?.sourceChannel ?? 'screen_capture',
          sourceMeta: payload.traceback?.sourceMeta ?? null,
          sourceCaptureId: proposal.sourceCaptureId,
        })
        .catch((err) =>
          console.error(`[applier→enricher] failed for task ${taskId}:`, (err as Error).message)
        )
    })
    console.log('🔗 Applier→Enricher hook enabled (pull create → modify follow-up)')
  }
} else {
  console.warn('⚠️ LLM_BASE_URL or LLM_API_KEY not set — Enricher & Commitment Detector disabled')
}

// Batch high-volume Slack captures so the Commitment LLM runs on a cadence
// (default every SLACK_POLL_INTERVAL_MS) instead of once per message.
// envInt treats empty/0/NaN as "unset" — compose passes the var through as an
// empty string when not configured, which Number() turns into 0 (not NaN), so
// a plain ?? wouldn't fall back.
const envInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const COMMITMENT_BATCH_INTERVAL_MS = envInt(
  process.env.COMMITMENT_BATCH_INTERVAL_MS,
  SLACK_POLL_INTERVAL_MS
)
const COMMITMENT_BATCH_MAX = envInt(process.env.COMMITMENT_BATCH_MAX, 30)
const commitmentBatcher =
  commitmentPipeline
    ? new CommitmentBatcher(commitmentPipeline, {
        flushIntervalMs: COMMITMENT_BATCH_INTERVAL_MS,
        maxPerFlush: COMMITMENT_BATCH_MAX,
      })
    : null
if (commitmentBatcher) {
  commitmentBatcher.start()
  console.log(
    `🪣 Commitment batcher on (drain every ${COMMITMENT_BATCH_INTERVAL_MS}ms, max ${COMMITMENT_BATCH_MAX}/drain)`
  )
}

const capture = createCaptureSink({
  mindwtr,
  enricherPipeline,
  contextStore,
  commitmentPipeline,
  commitmentBatcher,
  memoryIngest,
})

// Bot is created at module load (Bot ctor doesn't connect — only bot.start() does)
// so we can wire handlers + notifier before main() spins up.
const bot = createBot(TELEGRAM_BOT_TOKEN, capture, {
  proposals: { store: proposalStore, webBaseUrl: MINDWTR_WEB_URL },
})

const proposalNotifier = new ProposalNotifier({
  bot,
  notifyChatId: TG_NOTIFY_CHAT_ID,
  webBaseUrl: MINDWTR_WEB_URL,
})
if (proposalNotifier.enabled) {
  console.log(`📣 TG proposal notifications → chat ${TG_NOTIFY_CHAT_ID} (links to ${MINDWTR_WEB_URL})`)
  commitmentPipeline?.setNotifier(proposalNotifier)
  enricherPipeline?.setNotifier(proposalNotifier)
} else if (TG_NOTIFY_CHAT_ID === '') {
  console.log('ℹ️ TG_NOTIFY_CHAT_ID not set — proposal notifications disabled')
}

// TG notifier for AI-agent stage transitions (review / error). Shares the
// same chat as proposal notifications. Wired into the task-changes webhook
// below so OpenClaw-driven PATCHes surface as live TG pings.
const reviewNotifier = TG_NOTIFY_CHAT_ID
  ? new ReviewNotifier({ bot, notifyChatId: TG_NOTIFY_CHAT_ID, webBaseUrl: MINDWTR_WEB_URL })
  : null
if (reviewNotifier) {
  console.log(`📣 TG ai-agent stage notifications → chat ${TG_NOTIFY_CHAT_ID}`)
}

// Publish LLM verdicts to the macOS widget. Disabled when LLM_STATUS_FILE
// is unset (typical for unit tests and non-Mac deploys).
const llmPublisher = LlmPublisher.fromEnv()
if (llmPublisher) {
  console.log(`📊 LLM status → ${process.env.LLM_STATUS_FILE}`)
  commitmentPipeline?.setLlmPublisher(llmPublisher)
  enricherPipeline?.setLlmPublisher(llmPublisher)
}

// AI-agent stale-claim watchdog. Reverts ai-stage:doing tasks abandoned by
// OpenClaw (crash, host offline) back to queued so the next OpenClaw tick
// can pick them up. Disabled when AI_AGENT_WATCHDOG=false (tests).
if (process.env.AI_AGENT_WATCHDOG !== 'false') {
  startAgentWatchdog(mindwtr, DEFAULT_AGENT_WATCHDOG_CONFIG)
  console.log(
    `🛡  ai-agent watchdog: revert doing→queued after ${Math.round(DEFAULT_AGENT_WATCHDOG_CONFIG.staleAfterMs / 60000)}m, max ${DEFAULT_AGENT_WATCHDOG_CONFIG.maxRetries} retries`
  )
}

function buildChannels(): { channels: Channel[]; slack: SlackChannel | null } {
  const channels: Channel[] = []
  let slack: SlackChannel | null = null

  const slackWorkspaces = [
    ...SLACK_USER_TOKENS.map((token) => ({ token })),
    ...SLACK_SESSION_TOKENS,
  ]
  // Build the Slack channel whenever ANY Slack path is enabled — env tokens
  // OR the session receiver (HTTP_AUTH_TOKEN gates the extension push). With
  // only the receiver, it starts idle and the extension fills it at runtime.
  if (slackWorkspaces.length > 0 || HTTP_AUTH_TOKEN) {
    const state = new FileStateStore(channelStateFile(DATA_DIR), 'slack')
    slack = new SlackChannel(
      {
        workspaces: slackWorkspaces,
        pollIntervalMs: SLACK_POLL_INTERVAL_MS,
        teamAllowlist: SLACK_TEAM_ALLOWLIST,
      },
      (item) => capture(item),
      state
    )
    channels.push(slack)
    const allowDesc = SLACK_TEAM_ALLOWLIST.size > 0 ? `${SLACK_TEAM_ALLOWLIST.size} allowlisted` : 'all teams'
    console.log(
      `💬 Slack channel enabled (${SLACK_USER_TOKENS.length} oauth + ${SLACK_SESSION_TOKENS.length} session env, ${allowDesc}, poll every ${SLACK_POLL_INTERVAL_MS}ms; extension push ${HTTP_AUTH_TOKEN ? 'on' : 'off'})`
    )
  }

  if (TELEGRAM_API_ID && TELEGRAM_API_HASH) {
    channels.push(
      new TelegramUserChannel(
        {
          apiId: TELEGRAM_API_ID,
          apiHash: TELEGRAM_API_HASH,
          sessionPath: join(DATA_DIR, 'telegram-user-session'),
        },
        (item) => capture(item)
      )
    )
    console.log('📨 Telegram user channel enabled (MTProto, DMs + groups)')
  }

  if (NOTION_API_KEY && NOTION_DATABASE_ID) {
    const state = new FileStateStore(channelStateFile(DATA_DIR), 'notion')
    channels.push(
      new NotionChannel(
        { apiKey: NOTION_API_KEY, databaseId: NOTION_DATABASE_ID, pollIntervalMs: NOTION_POLL_INTERVAL_MS },
        (item) => capture(item),
        state
      )
    )
    console.log(`📝 Notion channel enabled (poll every ${NOTION_POLL_INTERVAL_MS}ms)`)
  }

  return { channels, slack }
}

async function main() {
  // Wait for Mindwtr Cloud to be ready
  let retries = 10
  while (retries > 0) {
    const healthy = await mindwtr.healthCheck()
    if (healthy) break
    console.log(`Waiting for Mindwtr Cloud at ${MINDWTR_CLOUD_URL}...`)
    await new Promise((r) => setTimeout(r, 2000))
    retries--
  }

  if (retries === 0) {
    console.error(`Mindwtr Cloud not reachable at ${MINDWTR_CLOUD_URL}`)
    process.exit(1)
  }

  console.log(`✅ Connected to Mindwtr Cloud at ${MINDWTR_CLOUD_URL}`)

  // Periodic Context Store TTL purge (once per hour)
  const purgeTimer = setInterval(() => {
    try {
      const purged = contextStore.purgeExpired()
      if (purged > 0) console.log(`🧹 Context Store: purged ${purged} expired captures`)
    } catch (err) {
      console.error('[context-store] purge failed:', err)
    }
  }, 60 * 60 * 1000)

  // Daily Proposal expiry job (default 7-day idle window).
  const expiryJob = new ProposalExpiryJob(contextStore.rawDb, proposalStore)
  const expiryTimer = setInterval(
    () => {
      try {
        const result = expiryJob.run()
        if (result.expired.length > 0) {
          console.log(
            `⏳ Proposals: expired ${result.expired.length}/${result.scanned} pending (idle > 7d)`
          )
        }
      } catch (err) {
        console.error('[proposal-expiry] failed:', err)
      }
    },
    24 * 60 * 60 * 1000
  )

  // Guard every external-channel call at boot with a timeout. When makurdi's
  // outbound network blips, Slack/Notion start() can hang indefinitely — and
  // since this runs before the HTTP server, a hang takes down the capture
  // endpoint (ai.kurdy.uk 502, dropped captures). The timeout lets boot
  // proceed; the channel's own poller retries once the network recovers.
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ])

  // Start additional channels
  const { channels, slack: slackChannel } = buildChannels()
  for (const ch of channels) {
    try {
      await withTimeout(ch.start(), 15000, `channel ${ch.name} start`)
      console.log(`✅ ${ch.name} channel started`)
    } catch (err) {
      console.error(`Failed to start ${ch.name}:`, err)
    }
  }

  // Restore session workspaces pushed by the browser extension on a previous
  // run, so a restart doesn't require re-extracting. Best-effort per record:
  // a dead credential just logs invalid_auth and is skipped.
  const slackSessionStore = new SlackSessionStore(slackSessionFile(DATA_DIR))
  if (slackChannel) {
    const saved = await slackSessionStore.load()
    for (const rec of saved) {
      try {
        await withTimeout(
          slackChannel.upsertSessionWorkspace(rec.token, rec.cookie),
          15000,
          `slack session restore ${rec.teamName}`
        )
      } catch (err) {
        const reason = (err as { data?: { error?: string } })?.data?.error ?? (err as Error).message
        console.warn(`[slack] saved session for ${rec.teamName} no longer valid (${reason})`)
      }
    }
  }

  // bot is constructed at module load above; nothing to do here.

  const healthMonitor = new HealthMonitor({
    db: contextStore.rawDb,
    cloudHealthCheck: () => mindwtr.healthCheck(),
  })
  const healthAlerter = TG_NOTIFY_CHAT_ID
    ? new HealthAlerter({ bot, monitor: healthMonitor, notifyChatId: TG_NOTIFY_CHAT_ID })
    : null
  if (healthAlerter) {
    healthAlerter.start()
    console.log(`🩺 Health alerter → TG chat ${TG_NOTIFY_CHAT_ID} (5m interval, transition-only)`)
  }

  // Optional HTTP capture endpoint (used by desktop capture-agent and ad-hoc clients)
  let http: { stop: () => void } | null = null
  if (HTTP_AUTH_TOKEN) {
    const server = createHttpServer({
      port: HTTP_PORT,
      authToken: HTTP_AUTH_TOKEN,
      capture,
      contextStore,
      healthMonitor,
      corsOrigins: HTTP_CORS_ORIGINS,
      slackSession: slackChannel
        ? {
            upsert: async (token, cookie) => {
              const { teamId, teamName } = await slackChannel.upsertSessionWorkspace(token, cookie)
              // Persist only after auth succeeded so we never store a dead cred.
              // Non-allowlisted teams are persisted too (cheap, and lets the
              // allowlist change later without a re-push from the extension).
              await slackSessionStore.upsert({
                teamId,
                teamName,
                token,
                cookie,
                updatedAt: new Date().toISOString(),
              })
              return { teamId, teamName }
            },
          }
        : null,
      proposals: commentHandler
        ? {
            store: proposalStore,
            applier: proposalApplier,
            commentHandler,
            taskChangeProcessor,
            // Manual user adds in Mindwtr UI (and cross-device sync of new
            // tasks) reach us through this webhook. Hand them to the same
            // Enricher pipeline push captures use so the user gets an AI
            // suggestion on the manually-added card within a few seconds.
            onTaskEdited: reviewNotifier
              ? (taskId, fields) => void reviewNotifier!.onTaskEdit(taskId, fields)
              : undefined,
            onTaskCreated: enricherPipeline
              ? (taskId, fields) => {
                  const text = (fields.title ?? '') + (fields.description ? '\n' + fields.description : '')
                  void enricherPipeline!
                    .run({
                      taskId,
                      taskTitle: fields.title ?? '',
                      taskTags: Array.isArray(fields.tags) ? fields.tags : [],
                      taskDescription: fields.description ?? '',
                      taskStatus: typeof fields.status === 'string' ? fields.status : undefined,
                      text,
                      sourceChannel: 'manual',
                      sourceMeta: { origin: 'mindwtr-ui-or-sync' },
                      sourceCaptureId: null,
                    })
                    .catch((err) =>
                      console.error(`[webhook→enricher] failed for ${taskId}:`, (err as Error).message)
                    )
                }
              : undefined,
            // FR89: approve/reject routes push reliability signal to the
            // cited playbook chunks. null when procedural memory is off.
            proceduralFeedback: proceduralStore ?? undefined,
          }
        : null,
      persons: personsProvider,
      onboarding: onboardingExtractor
        ? {
            mindwtr,
            extractor: onboardingExtractor,
            glossary: glossaryStore,
          }
        : null,
      memory: memoryFocusContext
        ? {
            store: memoryStore,
            retriever: memoryRetriever,
            focusContext: memoryFocusContext,
            ingest: memoryIngest,
          }
        : null,
      procedural: proceduralStore
        ? {
            store: proceduralStore,
            userCrud:
              proceduralReader && SHARED_MEMORY_DIR
                ? {
                    sharedMemoryDir: SHARED_MEMORY_DIR,
                    scanNow: async () => {
                      await proceduralReader!.scanOnce()
                    },
                  }
                : undefined,
          }
        : null,
      recordings: recordingStore
        ? {
            store: recordingStore,
            onStopped: (_sessionId) => {
              // Fire-and-forget — distiller picks the session up by status.
              if (recordingDistiller) {
                void recordingDistiller.distillPending().catch((err: Error) => {
                  console.warn(`[distill] sweep after stop failed: ${err.message}`)
                })
              }
            },
          }
        : null,
      agentConfig,
    })
    http = server.serve()
    console.log(
      `📡 HTTP endpoint listening on :${HTTP_PORT} (capture, context search${
        commentHandler ? ', proposals' : ''
      }${personsProvider ? ', persons' : ''}${memoryFocusContext ? ', memory' : ''}${
        proceduralStore ? ', procedural' : ''
      })`
    )
  } else {
    console.warn('⚠️ HTTP_AUTH_TOKEN not set — HTTP endpoint disabled')
  }

  // Daily memory summary — one LLM call per day, summarizing yesterday's
  // events. Runs every hour so server restarts at odd times still catch
  // it; the job itself is idempotent (skips dates already summarized).
  const dailySummaryTimer = dailySummaryJob
    ? setInterval(
        () => {
          if (!dailySummaryJob) return
          dailySummaryJob
            .backfill(1)
            .then((results) => {
              const wrote = results.filter((r) => r.wrote).length
              if (wrote > 0) {
                console.log(
                  `📝 Daily summary: wrote ${wrote} new day(s) (${results.map((r) => r.date).join(', ')})`
                )
              }
            })
            .catch((err) => console.error('[daily-summary] failed:', err))
        },
        60 * 60 * 1000
      )
    : null

  // Proactive memory runner — scans stale active facts every N hours,
  // proposes follow-up actions through the same Proposal Store the
  // commitment-detector uses. Source-agent label distinguishes them.
  // Default cadence 6h (configurable via PROACTIVE_INTERVAL_MS).
  const proactiveIntervalMs = Number(process.env.PROACTIVE_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
  const proactiveTimer = proactiveRunner
    ? setInterval(
        () => {
          if (!proactiveRunner) return
          proactiveRunner
            .run()
            .then(({ forward, reverse }) => {
              const fwdNoise = forward.proposed > 0 || forward.errors > 0
              const revNoise = reverse && (reverse.proposed > 0 || reverse.errors > 0)
              if (fwdNoise) {
                console.log(
                  `🔮 Proactive forward: ${forward.proposed} proposed, ${forward.skipped} skipped, ${forward.errors} errors (${forward.elapsedMs}ms)`
                )
              }
              if (revNoise && reverse) {
                console.log(
                  `🔁 Proactive reverse: ${reverse.proposed} proposed, ${reverse.skipped} skipped, ${reverse.errors} errors (${reverse.elapsedMs}ms)`
                )
              }
            })
            .catch((err) => console.error('[proactive] failed:', err))
        },
        proactiveIntervalMs
      )
    : null

  // Entity pipeline — catches the entity layer up with the events table.
  // Tick is serialized internally; each tick processes at most a few windows
  // so a long backlog drains gradually without hogging the LLM budget.
  const entityPipelineTimer = entityPipeline
    ? setInterval(
        () => {
          if (!entityPipeline) return
          entityPipeline
            .tick()
            .catch((err) => console.error('[entity-pipeline] tick failed:', (err as Error).message))
        },
        ENTITY_PIPELINE_INTERVAL_MS
      )
    : null
  if (entityPipeline) {
    // Kick one tick at boot so a fresh deploy starts catching up immediately.
    void entityPipeline
      .tick()
      .catch((err) => console.error('[entity-pipeline] initial tick failed:', (err as Error).message))
  }

  const shutdown = async () => {
    console.log('🛑 Shutting down...')
    clearInterval(purgeTimer)
    clearInterval(expiryTimer)
    if (healthAlerter) healthAlerter.stop()
    if (dailySummaryTimer) clearInterval(dailySummaryTimer)
    if (proactiveTimer) clearInterval(proactiveTimer)
    if (entityPipelineTimer) clearInterval(entityPipelineTimer)
    if (http) http.stop()
    for (const ch of channels) {
      try {
        await ch.stop()
      } catch (err) {
        console.error(`Failed to stop ${ch.name}:`, err)
      }
    }
    await bot.stop()
    contextStore.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  console.log('🤖 AI Service starting...')
  await bot.start({
    onStart: () => console.log('🚀 Bot is running'),
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
