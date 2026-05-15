import { join } from 'node:path'
import { MindwtrClient } from './api/mindwtr-client'
import { LLMClient } from './ai/client'
import { ContextRetriever } from './ai/retriever'
import { createBot } from './bot'
import { createCaptureSink } from './capture/sink'
import type { Channel } from './channels/types'
import { SlackChannel } from './channels/slack'
import { NotionChannel } from './channels/notion'
import { FileStateStore, channelStateFile } from './channels/state-store'
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
import { Reviser } from './commitment/reviser'
import { ProposalWriter } from './commitment/writer'
import { CommitmentPipeline, DEFAULT_PIPELINE_CONFIG } from './commitment/pipeline'
import { denyConfigFromEnv } from './commitment/source-deny'
import { MindwtrInboxTitles } from './commitment/inbox-titles'
import { WikiPersonsProvider } from './wiki/persons-reader'
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
import {
  ProceduralStore,
  ProceduralReader,
  ProceduralRetriever,
  ProceduralProposerBlock,
  LlmChunkClassifier,
} from './memory/procedural'

const MINDWTR_CLOUD_URL = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
const MINDWTR_AUTH_TOKEN = process.env.MINDWTR_AUTH_TOKEN ?? ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? ''
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'cc/claude-opus-4-6'

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

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

// --- AI Enricher (push) + Commitment Detector (pull) + Reviser ---
let enricherPipeline: EnricherPipeline | null = null
let commitmentPipeline: CommitmentPipeline | null = null
let commentHandler: CommentHandler | null = null
if (LLM_BASE_URL && LLM_API_KEY) {
  const llm = new LLMClient(LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)
  const retriever = new ContextRetriever(contextStore)

  const enricher = new Enricher(llm)
  enricherPipeline = new EnricherPipeline({
    enricher,
    proposalStore,
    retriever,
  })
  console.log(`🪄 Enricher enabled (${LLM_MODEL}) — push captures → modify/split proposals`)

  const proposer = new Proposer(llm)
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
    const proceduralStore = new ProceduralStore({
      db: contextStore.rawDb,
      vecAvailable: contextStore.hasVectorSearch,
    })
    // Phase 0.5 (FR86): classify each chunk before it surfaces to the
    // Proposer. Heuristic runs at upsert (cheap regex); LLM batches what's
    // left as 'needs-review' each tick — capped at 10 chunks/tick so we
    // don't blow the budget on a fresh import.
    const procClassifier = new LlmChunkClassifier({ llm, model: LLM_MODEL })
    const proceduralReader = new ProceduralReader({
      store: proceduralStore,
      rootDir: SHARED_MEMORY_DIR,
      sources: [{ subdir: 'openclaw', source: 'openclaw' }],
      embeddings,
      intervalMs: SHARED_MEMORY_REINDEX_INTERVAL_MS,
      llmClassifier: procClassifier,
      llmClassifyBatchSize: 10,
    })
    proceduralReader.start()
    const proceduralRetriever = new ProceduralRetriever(proceduralStore, embeddings)
    commitmentPipeline.setProceduralContextProvider(
      new ProceduralProposerBlock({ retriever: proceduralRetriever })
    )
    console.log(
      `📖 Procedural memory enabled (root=${SHARED_MEMORY_DIR}, reindex=${SHARED_MEMORY_REINDEX_INTERVAL_MS}ms, chunks=${proceduralStore.countChunks()}, classifier=llm)`
    )
  }
  console.log(
    `🎯 Commitment Detector enabled (deny apps:${sourceDeny.apps.length}, deny urls:${sourceDeny.urlPatterns.length}, inbox-dedup on, identity:${USER_IDENTITY_NAME || 'unset'}, persons:${personsProvider ? 'wiki' : 'unset'})`
  )

  const reviser = new Reviser(llm)
  commentHandler = new CommentHandler({
    store: proposalStore,
    reviser,
    mindwtr,
    contextStore,
  })
  console.log('💬 Proposal dialogue enabled (Reviser)')

  // Memory module wire-up requires the same LLM client.
  const memoryExtractor = new UnifiedExtractor(llm)
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
  })
  dailySummaryJob = new DailySummaryJob({
    store: memoryStore,
    llm,
    embeddings,
  })
  // Proactive runner — surfaces follow-up proposals from stale facts.
  // Source-agent='proactive-runner' on every proposal so UI / audit can
  // tell them apart from commitment-detector and enricher.
  proactiveRunner = new ProactiveRunner({
    memoryStore,
    proposalStore,
    llm,
    mindwtrClient: mindwtr,
    retriever: memoryRetriever,
  })
  console.log(
    `🧠 Memory module enabled (${memoryStore.vecAvailable ? 'vec+FTS' : 'FTS only'}, ${memoryStore.countEvents()} events, ${memoryStore.countFacts()} facts)`
  )

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

const capture = createCaptureSink({
  mindwtr,
  enricherPipeline,
  contextStore,
  commitmentPipeline,
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

function buildChannels(): Channel[] {
  const channels: Channel[] = []

  if (SLACK_APP_TOKEN && SLACK_BOT_TOKEN) {
    channels.push(
      new SlackChannel(
        { appToken: SLACK_APP_TOKEN, botToken: SLACK_BOT_TOKEN },
        (item) => capture(item)
      )
    )
    console.log('💬 Slack channel enabled')
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

  return channels
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

  // Start additional channels
  const channels = buildChannels()
  for (const ch of channels) {
    try {
      await ch.start()
      console.log(`✅ ${ch.name} channel started`)
    } catch (err) {
      console.error(`Failed to start ${ch.name}:`, err)
    }
  }

  // bot is constructed at module load above; nothing to do here.

  // Optional HTTP capture endpoint (used by desktop capture-agent and ad-hoc clients)
  let http: { stop: () => void } | null = null
  if (HTTP_AUTH_TOKEN) {
    const server = createHttpServer({
      port: HTTP_PORT,
      authToken: HTTP_AUTH_TOKEN,
      capture,
      contextStore,
      corsOrigins: HTTP_CORS_ORIGINS,
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
            onTaskCreated: enricherPipeline
              ? (taskId, fields) => {
                  const text = (fields.title ?? '') + (fields.description ? '\n' + fields.description : '')
                  void enricherPipeline!
                    .run({
                      taskId,
                      taskTitle: fields.title ?? '',
                      taskTags: Array.isArray(fields.tags) ? fields.tags : [],
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
          }
        : null,
      persons: personsProvider,
      memory: memoryFocusContext
        ? {
            store: memoryStore,
            retriever: memoryRetriever,
            focusContext: memoryFocusContext,
            ingest: memoryIngest,
          }
        : null,
    })
    http = server.serve()
    console.log(
      `📡 HTTP endpoint listening on :${HTTP_PORT} (capture, context search${
        commentHandler ? ', proposals' : ''
      }${personsProvider ? ', persons' : ''}${memoryFocusContext ? ', memory' : ''})`
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

  const shutdown = async () => {
    console.log('🛑 Shutting down...')
    clearInterval(purgeTimer)
    clearInterval(expiryTimer)
    if (dailySummaryTimer) clearInterval(dailySummaryTimer)
    if (proactiveTimer) clearInterval(proactiveTimer)
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
