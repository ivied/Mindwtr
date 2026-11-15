/**
 * Gateway: the public face of ai-service.
 *
 * The full service (index.ts) ingests captures, runs the LLM pipelines, polls
 * Slack and Telegram and maintains memory on one thread next to a synchronous
 * database. When that work is heavy, nothing else in the process answers — and
 * the agent runner, whose claims and heartbeats time out, loses its runs.
 *
 * This process holds only what agent runs need — their tables, the task
 * memory block, the sessions on other computers — and answers those requests
 * itself. Everything else it passes to the full service, which listens on an
 * internal address. Both open the same database file.
 */
import { join } from 'node:path'
import { MindwtrClient } from './api/mindwtr-client'
import { buildAgentRunsMemory } from './agent-runs/memory-wiring'
import { SessionStore } from './agent-runs/session-routes'
import { AgentRunStore } from './agent-runs/store'
import { openDb } from './context-store/db'
import { OpenAIEmbeddings } from './context-store/embeddings'
import { createHttpServer } from './http/server'
import { HybridRetriever, MemoryStore } from './memory'
import type { HealthReport } from './status/health'

const env = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim()
const number = (name: string, fallback: number): number => {
  const raw = env(name)
  const n = raw === '' ? fallback : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const WORKER_URL = env('AI_WORKER_URL', 'http://ai-worker:3030').replace(/\/$/, '')
const HTTP_AUTH_TOKEN = env('HTTP_AUTH_TOKEN')
const MINDWTR_AUTH_TOKEN = env('MINDWTR_AUTH_TOKEN')
if (!HTTP_AUTH_TOKEN || !MINDWTR_AUTH_TOKEN) {
  console.error('gateway: HTTP_AUTH_TOKEN and MINDWTR_AUTH_TOKEN are required')
  process.exit(1)
}

// This process shares the worker's environment but needs far less of the
// database in memory, and it should wait for the worker's writes rather than
// fail a claim or a heartbeat.
process.env.SQLITE_CACHE_KB ??= '100000'
process.env.SQLITE_READER_CACHE_KB ??= '600000'
process.env.SQLITE_BUSY_MS ??= '30000'

// The full service owns the schema and the vector-table maintenance.
const { db, vecAvailable } = openDb(join(env('DATA_DIR', '/app/data'), 'context.db'), { maintainVec: false })
const store = new AgentRunStore(db)
const sessions = new SessionStore(db)
const memoryStore = new MemoryStore({ db, vecAvailable })
const embeddings = env('OPENAI_API_KEY')
  ? new OpenAIEmbeddings({
      apiKey: env('OPENAI_API_KEY'),
      model: env('EMBEDDINGS_MODEL', 'text-embedding-3-small'),
      baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    })
  : null
const retriever = new HybridRetriever(memoryStore, embeddings)

/** /health reports the full service; when that is silent, say so instead of hanging. */
async function workerHealth(): Promise<HealthReport> {
  const checkedAt = new Date().toISOString()
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(5000) })
    const report = (await res.json()) as HealthReport
    return { ...report, components: { ...report.components, gateway: { ok: true } } as HealthReport['components'] }
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      components: { gateway: { ok: true }, worker: { ok: false, detail: `no answer: ${(err as Error).message}` } } as HealthReport['components'],
    }
  }
}

const server = createHttpServer({
  port: number('HTTP_PORT', 3030),
  authToken: HTTP_AUTH_TOKEN,
  corsOrigins: env('HTTP_CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  capture: async () => {
    throw new Error('captures are handled by the full service')
  },
  contextStore: null,
  proposals: null,
  persons: null,
  healthMonitor: { check: workerHealth },
  proxyTo: WORKER_URL,
  agentRuns: {
    store,
    sessions,
    mindwtr: new MindwtrClient({ baseUrl: env('MINDWTR_CLOUD_URL', 'http://localhost:8787'), authToken: MINDWTR_AUTH_TOKEN }),
    dailyBudgetUsd: number('AGENT_RUNS_DAILY_BUDGET_USD', 100),
    dailyQuotaPct: number('AGENT_RUNS_DAILY_QUOTA_PCT', 10),
    publicUrl: env('AI_SERVICE_PUBLIC_URL') || undefined,
    runnerToken: env('AGENT_RUNNER_TOKEN') || undefined,
    memory: buildAgentRunsMemory({
      db,
      store: memoryStore,
      searchEvents: (query, limit, withinDays) => retriever.retrieve({ query, limit, withinDays }),
    }),
    // The account's client lives in the full service, which also serves
    // /v1/telegram/* and /v1/assistant/*; here it is enough to know it exists.
    telegramElsewhere: !!env('TELEGRAM_API_ID') && !!env('TELEGRAM_API_HASH'),
  },
})

const http = server.serve()
console.log(`🚪 Gateway listening on :${number('HTTP_PORT', 3030)} — agent runs here, the rest → ${WORKER_URL}`)

const shutdown = () => {
  http.stop()
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
