/**
 * Agent runner — executes inbox agent runs on the host.
 *
 *   poll ai-service → claim queued runs (up to `concurrency`) → for each, run
 *   one agent turn with the Claude Agent SDK, streaming its steps back as
 *   events → report how the turn ended (question / confirm / done / stopped /
 *   error). A parked run is resumed later in the SAME session when the user
 *   replies, so nothing stays open while they are away.
 *
 * Runs on the host, not in Docker: the agent needs the real `claude` runtime,
 * ~/.claude sessions, repos, docker and whatever else the user is logged into.
 */

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type HookCallback,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { RunsApi } from './client'
import { filterOrphanResults, mapMessage, type SdkMessageLike } from './events'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  accessConfigReason,
  accessDenyMessage,
  denyMessage,
  outwardReason,
  secretsFileReason,
  type GuardContext,
} from './guard'
import {
  PROVISION_APPEND,
  SYSTEM_APPEND,
  buildFirstPrompt,
  buildFollowUpPrompt,
  buildProvisionPrompt,
  buildResumePrompt,
} from './prompt'
import type {
  AccessRecord,
  ClaimedRun,
  FinishBody,
  PendingRequest,
  RunEventInput,
  RunReply,
  RunResult,
} from './protocol'
import { SecretsFile, redact } from './secrets'
import { QuotaMeter as QuotaMeterImpl, type QuotaMeter } from './quota'
import { LOOPBACK_REDIRECT, OAUTH_CODE_PREFIX, OAUTH_NAME, OAuthProxy, OAuthVault, startLoopbackCallback } from './oauth'

export interface RunnerConfig {
  /** Shown as claimed_by; one name per machine. */
  name: string
  concurrency: number
  pollMs: number
  /** How often buffered events are pushed (doubles as the heartbeat). */
  flushMs: number
  /** Working directory for fresh sessions. A resumed run keeps its own. */
  cwd: string
  model?: string
  /** Per-turn spend cap handed to the SDK. 0 = none. */
  maxBudgetUsd: number
  turnTimeoutMs: number
  /** Give the agents the user's Chrome through the Claude in Chrome extension. */
  chrome?: boolean
  /** Where long-lived secrets for the agents are kept. Default: ~/.config/gtd-agents/secrets.env */
  secretsFile?: string
  /** Where screenshots attached to replies are saved. Default: ~/.cache/gtd-agents/attachments */
  attachmentsDir?: string
  /** Where browser sign-ins the runner owns are kept. Default: ~/.config/gtd-agents/oauth */
  oauthDir?: string
  /** How many times to try reporting the end of a turn (tests lower it). Default: 40. */
  finishAttempts?: number
  /** Measure the weekly subscription quota each turn uses. Default: on. */
  quota?: boolean
  env: Record<string, string | undefined>
}

/** What a turn needs to know about accesses the user has granted so far. */
export interface TurnContext {
  accesses: AccessRecord[]
  secrets: SecretsFile
  /** Measures the share of the weekly subscription quota each turn uses. */
  quota?: QuotaMeter
  /** Browser sign-ins the runner owns, and the local proxy that serves them to agents. */
  oauth?: { vault: OAuthVault; proxy: OAuthProxy; redirectUri: string }
}

export const DEFAULT_ATTACHMENTS_DIR = join(homedir(), '.cache', 'gtd-agents', 'attachments')

type Log = (msg: string) => void

/** What the control tools captured during a turn. */
export interface TurnBox {
  pending: PendingRequest | null
  result: RunResult | null
}

type AgentMessage = SdkMessageLike & {
  session_id?: string
  subtype?: string
  result?: string
  total_cost_usd?: number
}

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<AgentMessage>

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const ALREADY_WAITING =
  'Запрос пользователю уже отправлен в этом ходе, второй не принят. Заверши ход прямо сейчас и ничего больше не вызывай.'
const STOP_NOW = 'Заверши ход прямо сейчас: больше ничего не делай и не вызывай инструменты. Ответ придёт следующим сообщением.'

/** Keep the control tools in context — no discovery step before using them. */
const ALWAYS_LOADED = { alwaysLoad: true }

const taskReport = (box: TurnBox) =>
  tool(
    'report_result',
    'Итог работы по задаче. Вызывай один раз в самом конце, когда работа завершена или задача разложена.',
    {
      summary: z.string().describe('Что сделано или выяснено, 1–3 предложения'),
      evidence: z.array(z.string()).max(8).optional().describe('На что опирается итог: ссылки, вывод команд, найденные сообщения'),
      changes: z
        .object({
          title: z.string().optional().describe('Новый заголовок, если текущий неясен'),
          status: z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done']).optional(),
          contexts: z.array(z.string()).optional().describe('Контексты, например @покупки'),
          addTags: z.array(z.string()).optional(),
          project: z.string().optional().describe('Название существующего проекта'),
          descriptionAppend: z.string().optional().describe('Текст, который добавить в описание: черновик, конспект, найденные детали'),
        })
        .optional()
        .describe('Изменения в задаче; применятся, когда пользователь примет результат'),
      lessons: z
        .array(
          z.object({
            statement: z.string().describe('Факт одним предложением, понятный без этой задачи: «Инвойсы HiQ выставляются через PayPal, не через Remote»'),
            entity: z.string().optional().describe('О каком проекте, человеке или сервисе факт: «HiQ». Пусто, если это общее правило'),
          })
        )
        .max(5)
        .optional()
        .describe('Что стоит запомнить на будущее. Только то, что пользователь прямо сказал или подтвердил в этом прогоне (поправил тебя, ответил на вопрос, уточнил порядок работы). Свои выводы и находки сюда не клади.'),
    },
    async (a) => {
      const lessons = (a.lessons ?? []).map((l) => ({ statement: l.statement, entity: l.entity ?? '' }))
      box.result = { summary: a.summary, evidence: a.evidence ?? [], changes: a.changes ?? {}, ...(lessons.length ? { lessons } : {}) }
      return text('Итог записан. Заверши ход.')
    },
    ALWAYS_LOADED
  )

const requestAccess = (box: TurnBox) =>
  tool(
    'request_access',
    'Попросить доступ к внешнему сервису, которого у агентов нет (API, MCP, сервер). Сам доступ не настраивай. После вызова сразу заверши ход.',
    {
      service: z.string().describe('Название сервиса или сервера, как его назвал бы пользователь'),
      purpose: z.string().describe('Зачем он нужен для этой задачи, одной фразой'),
      scope: z.enum(['read', 'write']).describe('read — только смотреть; write — ещё и менять что-то в сервисе'),
    },
    async (a) => {
      if (box.pending) return text(ALREADY_WAITING)
      box.pending = { kind: 'access', service: a.service, purpose: a.purpose, scope: a.scope }
      return text(`Запрос доступа передан пользователю. ${STOP_NOW}`)
    },
    ALWAYS_LOADED
  )

const requestSecret = (box: TurnBox) =>
  tool(
    'request_secret',
    'Попросить у пользователя ключ или токен. Он введёт его в защищённое поле; значение появится в окружении под указанным именем и не попадёт в переписку. После вызова сразу заверши ход.',
    {
      name: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).describe('Имя переменной окружения, например REMOTE_API_TOKEN'),
      label: z.string().describe('Что это за ключ, по-человечески: «API-токен Remote (только чтение)»'),
      hint: z.string().describe('Где его взять и какие права выбрать, по шагам'),
      url: z.string().optional().describe('Ссылка на страницу, где создаётся ключ (https://…)'),
    },
    async (a) => {
      if (box.pending) return text(ALREADY_WAITING)
      box.pending = { kind: 'secret', name: a.name, label: a.label, hint: a.hint, url: a.url ?? '' }
      return text(
        `Запрос ключа передан пользователю. Значения в окружении ещё нет и в этом ходе не будет: не проверяй его. ${STOP_NOW}`
      )
    },
    ALWAYS_LOADED
  )

const requestOAuth = (box: TurnBox, oauth: TurnContext['oauth']) =>
  tool(
    'request_oauth',
    'Подключить сервис, у которого вход только через браузер (OAuth): удалённый MCP-сервер. Раннер сам зарегистрируется у сервиса, пользователь получит кнопку входа, а токены останутся на этом компьютере и будут обновляться сами. После успешного входа инструменты сервера появятся у тебя как mcp__<name>__*. После вызова сразу заверши ход.',
    {
      name: z.string().regex(OAUTH_NAME).describe('Короткое имя сервиса латиницей: remote, notion, linear'),
      label: z.string().describe('Название сервиса для пользователя: «Remote.com»'),
      serverUrl: z.string().regex(/^https:\/\//).describe('Адрес MCP-сервера, например https://mcp.remote.com/mcp'),
      hint: z.string().describe('Под каким аккаунтом входить и какие права давать, одной-двумя фразами'),
    },
    async (a) => {
      if (box.pending) return text(ALREADY_WAITING)
      if (!oauth) return text('Вход через браузер на этом раннере не настроен. Выбери другой способ подключения.')
      try {
        const { url, state, redirectUri } = await oauth.vault.begin(a.name, a.serverUrl, [oauth.redirectUri, LOOPBACK_REDIRECT])
        box.pending = { kind: 'oauth', name: a.name, label: a.label, url, state, hint: a.hint, local: redirectUri === LOOPBACK_REDIRECT }
        return text(`Ссылка для входа передана пользователю. Инструментов сервера в этом ходе не будет. ${STOP_NOW}`)
      } catch (err) {
        return text(`Начать вход не удалось: ${(err as Error).message}. Выбери другой способ подключения или спроси пользователя.`)
      }
    },
    ALWAYS_LOADED
  )

const provisionReport = (box: TurnBox) =>
  tool(
    'report_result',
    'Итог подключения доступа. Вызывай один раз в самом конце. Поле access заполняй только если доступ реально работает.',
    {
      summary: z.string().describe('Что подключено и как проверено, 1–3 предложения'),
      evidence: z.array(z.string()).max(8).optional().describe('Чем подтверждается: вывод проверочного запроса (без секретов)'),
      access: z
        .object({
          name: z.string().describe('Короткое имя латиницей, совпадает с именем скилла: remote, hetzner-prod'),
          kind: z.enum(['mcp', 'cli', 'http', 'ssh', 'other']),
          scope: z.enum(['read', 'write']),
          hosts: z.array(z.string()).optional().describe('Хосты сервиса без схемы: api.example.com'),
          envVars: z.array(z.string()).optional().describe('Имена переменных с секретами'),
          mcpServer: z.string().optional().describe('Имя MCP-сервера, если подключён через MCP'),
          skill: z.string().optional().describe('Имя папки скилла в ~/.claude/skills'),
          notes: z.string().describe('Одна-две строки для других агентов: как этим пользоваться'),
        })
        .optional(),
    },
    async (a) => {
      box.result = {
        summary: a.summary,
        evidence: a.evidence ?? [],
        changes: {},
        ...(a.access
          ? {
              access: {
                name: a.access.name,
                kind: a.access.kind,
                scope: a.access.scope,
                hosts: a.access.hosts ?? [],
                envVars: a.access.envVars ?? [],
                mcpServer: a.access.mcpServer ?? '',
                skill: a.access.skill ?? '',
                notes: a.access.notes,
              },
            }
          : {}),
      }
      return text('Итог записан. Заверши ход.')
    },
    ALWAYS_LOADED
  )

/**
 * The tools through which a run talks to the Inbox UI. A task run can ask for
 * an access; only a provisioning run can ask for a secret and register one.
 */
export function buildControlTools(box: TurnBox, kind: 'task' | 'provision' = 'task', oauth?: TurnContext['oauth']) {
  return createSdkMcpServer({
    name: 'gtd',
    version: '1.0.0',
    tools: [
      ...(kind === 'provision' ? [requestSecret(box), requestOAuth(box, oauth), provisionReport(box)] : [requestAccess(box), taskReport(box)]),
      tool(
        'ask_user',
        'Остановиться и задать пользователю один вопрос, когда не уверен, как правильно поступить, или не хватает данных. После вызова сразу заверши ход.',
        {
          question: z.string().describe('Один конкретный вопрос, понятный без чтения хода работы'),
          options: z.array(z.string()).max(4).optional().describe('2–4 готовых варианта ответа'),
        },
        async (a) => {
          if (box.pending) return text(ALREADY_WAITING)
          box.pending = { kind: 'question', question: a.question, options: a.options ?? [] }
          return text(`Вопрос передан пользователю. ${STOP_NOW}`)
        },
        ALWAYS_LOADED
      ),
      tool(
        'request_confirmation',
        'Запросить подтверждение перед внешним или необратимым действием (сообщение, письмо, платёж, push, деплой, удаление). После вызова сразу заверши ход; само действие не выполняй.',
        {
          action: z.string().describe('Что будет сделано, одной фразой: «Отправить сообщение в Slack»'),
          target: z.string().describe('Куда или кому: канал, человек, репозиторий, сервер'),
          draft: z.string().describe('Точный текст сообщения или точная команда, которая будет выполнена'),
        },
        async (a) => {
          if (box.pending) return text(ALREADY_WAITING)
          box.pending = { kind: 'confirm', action: a.action, target: a.target, draft: a.draft }
          return text(`Запрос подтверждения передан пользователю. ${STOP_NOW}`)
        },
        ALWAYS_LOADED
      ),
    ],
  })
}

/** How a finished turn maps onto run state. Pure — unit-tested. */
export function decideOutcome(box: TurnBox, resultText: string): FinishBody {
  if (box.pending) {
    // A secret is a question to the user; an access request is something to approve.
    const state = box.pending.kind === 'question' || box.pending.kind === 'secret' || box.pending.kind === 'oauth' ? 'question' : 'confirm'
    return { state, pending: box.pending }
  }
  if (box.result) return { state: 'done', result: box.result }
  const summary = resultText.trim() || 'Агент завершил ход без отчёта.'
  return { state: 'done', result: { summary: summary.slice(0, 4000), evidence: [], changes: {} } }
}

const ERROR_TEXT: Record<string, string> = {
  error_max_turns: 'Достигнут лимит шагов за ход.',
  error_max_budget_usd: 'Достигнут лимит расходов на один ход.',
  error_during_execution: 'Агент завершился с ошибкой.',
  error_max_structured_output_retries: 'Агент не смог сформировать ответ.',
}

function guardHook(
  lifted: () => boolean,
  provisioning: boolean,
  ctx: GuardContext,
  waiting: () => boolean
): HookCallback {
  const deny = (message: string) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: message,
    },
  })
  return async (input) => {
    const i = input as { tool_name?: string; tool_input?: unknown }
    if (!i.tool_name) return {}
    // The agent has asked the user something: the turn is over, whatever it tries next.
    if (waiting()) return deny(ALREADY_WAITING)
    // Who may change what agents can reach is not up for approval mid-run.
    const config = provisioning ? secretsFileReason(i.tool_name, i.tool_input) : accessConfigReason(i.tool_name, i.tool_input)
    if (config) return deny(accessDenyMessage(config))
    if (lifted()) return {}
    const reason = outwardReason(i.tool_name, i.tool_input, ctx)
    return reason ? deny(denyMessage(reason)) : {}
  }
}

/** Write-scope accesses the user granted: the guard lets writes to them through. */
export function guardContextOf(accesses: AccessRecord[]): GuardContext {
  const granted = accesses.filter((a) => a.status === 'active' && a.scope === 'write')
  return {
    trustedHosts: granted.flatMap((a) => a.hosts),
    trustedMcp: granted.map((a) => a.mcpServer).filter(Boolean),
  }
}

type Exec = (file: string, args: string[]) => Promise<void>
const execQuiet: Exec = (file, args) =>
  new Promise((resolve) => execFile(file, args, { timeout: 30_000 }, () => resolve()))

/**
 * Take a revoked access off this host: its secrets, its MCP server, its skill.
 * Deterministic on purpose — removing access is not a job for a model.
 */
export async function revokeOnHost(
  access: AccessRecord,
  secrets: SecretsFile,
  exec: Exec = execQuiet,
  skillsDir = join(homedir(), '.claude', 'skills'),
  vault?: OAuthVault
): Promise<void> {
  secrets.remove(access.envVars)
  if (access.mcpServer && OAUTH_NAME.test(access.mcpServer) && vault?.has(access.mcpServer)) {
    // A sign-in the runner owns: dropping its tokens is the whole revoke.
    vault.remove(access.mcpServer)
  } else if (access.mcpServer) {
    await exec('claude', ['mcp', 'remove', '-s', 'user', access.mcpServer])
  }
  // A bare directory name only: never a path that could point outside the skills dir.
  if (/^[A-Za-z0-9._-]+$/.test(access.skill) && !access.skill.startsWith('.')) {
    await rm(join(skillsDir, access.skill), { recursive: true, force: true })
  }
}

/** Skills that ship with the runner, for accesses ai-service provides itself (Telegram). */
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, '..', 'skills')
const SKILLS_DIR = join(homedir(), '.claude', 'skills')

/**
 * Put the bundled skill of every active access where the agents find it.
 * `installed` remembers what this process already checked; an access that
 * stops being active is forgotten, so granting it again installs the skill
 * anew (revoking removes it, see revokeOnHost).
 */
export function installBundledSkills(
  accesses: AccessRecord[],
  installed: Set<string>,
  log: Log = () => {},
  skillsDir = SKILLS_DIR,
  bundledDir = BUNDLED_SKILLS_DIR
): void {
  for (const a of accesses) {
    if (!/^[A-Za-z0-9._-]+$/.test(a.skill) || a.skill.startsWith('.')) continue
    if (a.status !== 'active') {
      installed.delete(a.skill)
      continue
    }
    if (installed.has(a.skill)) continue
    installed.add(a.skill)
    const source = join(bundledDir, a.skill, 'SKILL.md')
    if (!existsSync(source)) continue
    try {
      const body = readFileSync(source, 'utf8')
      const target = join(skillsDir, a.skill, 'SKILL.md')
      if (existsSync(target) && readFileSync(target, 'utf8') === body) continue
      mkdirSync(join(skillsDir, a.skill), { recursive: true })
      writeFileSync(target, body)
      log(`skill "${a.skill}" installed`)
    } catch (err) {
      installed.delete(a.skill)
      log(`skill "${a.skill}" not installed: ${(err as Error).message}`)
    }
  }
}

/** Run one turn of a claimed run to completion and report it. Never throws. */
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * Screenshots attached to a reply are saved on this host and named in the
 * message, so the agent opens them with Read like any other image file.
 */
export async function withImages(api: RunsApi, runId: string, reply: RunReply, dir: string, log: Log = () => {}): Promise<RunReply> {
  if (!reply.images?.length) return reply
  const paths: string[] = []
  let failed = 0
  for (const img of reply.images) {
    try {
      if (!api.attachment) throw new Error('attachments are not supported by this server client')
      const bytes = await api.attachment(runId, img.id)
      const target = join(dir, runId)
      mkdirSync(target, { recursive: true, mode: 0o700 })
      const file = join(target, `${img.id}.${IMAGE_EXT[img.mime] ?? 'png'}`)
      writeFileSync(file, bytes, { mode: 0o600 })
      paths.push(file)
    } catch (err) {
      failed++
      log(`${runId.slice(0, 8)} attachment ${img.id.slice(0, 8)} not saved: ${(err as Error).message}`)
    }
  }
  const note = [
    paths.length ? `Пользователь приложил изображения — обязательно открой каждое инструментом Read:\n${paths.map((p) => `- ${p}`).join('\n')}` : '',
    failed ? `Ещё ${failed} изобр. не удалось получить — скажи об этом пользователю, если без них не обойтись.` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return { ...reply, text: [reply.text.trim(), note].filter(Boolean).join('\n\n') }
}

export async function executeTurn(
  api: RunsApi,
  cfg: RunnerConfig,
  claimed: ClaimedRun,
  log: Log,
  queryFn: QueryFn = sdkQuery as unknown as QueryFn,
  ctx: TurnContext = { accesses: [], secrets: new SecretsFile(cfg.secretsFile) }
): Promise<void> {
  const { run } = claimed
  const tag = run.id.slice(0, 8)
  const attachmentsDir = cfg.attachmentsDir ?? DEFAULT_ATTACHMENTS_DIR
  let reply = claimed.reply ? await withImages(api, run.id, claimed.reply, attachmentsDir, log) : null
  const cwd = run.cwd ?? cfg.cwd
  const provisioning = run.kind === 'provision'
  // An approval lifts the outward-action guard for this turn only.
  const guardLifted = reply?.kind === 'approve'
  const guardCtx = guardContextOf(ctx.accesses)

  // Keys the user just typed for this run go to the host file before the turn.
  let signInNote = ''
  for (const s of claimed.secrets ?? []) {
    if (s.name.startsWith(OAUTH_CODE_PREFIX)) {
      // The code a browser sign-in brought back: redeem it, keep only the tokens.
      const name = s.name.slice(OAUTH_CODE_PREFIX.length)
      try {
        if (!ctx.oauth) throw new Error('вход через браузер на этом раннере не настроен')
        const { scope } = await ctx.oauth.vault.complete(name, s.value)
        signInNote = `Вход в «${name}» выполнен${scope ? ` (права: ${scope})` : ''}. Инструменты сервиса доступны тебе как mcp__${name}__*: найди их поиском инструментов и проверь доступ чтением.`
        log(`${tag} sign-in ${name} completed`)
      } catch (err) {
        signInNote = `Вход в «${name}» не завершён: ${(err as Error).message}. Расскажи об этом пользователю и предложи повторить вход.`
        log(`${tag} sign-in ${name} failed: ${(err as Error).message}`)
      }
      continue
    }
    try {
      ctx.secrets.set(s.name, s.value)
      log(`${tag} secret ${s.name} stored`)
    } catch (err) {
      log(`${tag} secret ${s.name} not stored: ${(err as Error).message}`)
    }
  }
  const secretValues = ctx.secrets.load()
  if (signInNote) reply = { kind: reply?.kind ?? 'answer', text: [reply?.text.trim(), signInNote].filter(Boolean).join('\n\n') }
  await ctx.quota?.turnStarted().catch(() => undefined)

  let sessionId = run.sessionId
  let cost = run.costUsd
  const first = provisioning ? buildProvisionPrompt(run, ctx.accesses) : buildFirstPrompt(run, ctx.accesses, claimed.context ?? '')
  let prompt = run.sessionId
    ? buildResumePrompt(reply)
    : first + (reply?.text.trim() ? `\n\nКомментарий пользователя: ${reply.text.trim()}` : '')

  const box: TurnBox = { pending: null, result: null }
  const shown = new Set<string>()
  const abort = new AbortController()
  let buffer: RunEventInput[] = []
  let midMessages: RunReply[] = []
  let stopRequested = false
  let timedOut = false

  let chain: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    chain = chain.then(async () => {
      // Nothing a secret appears in leaves the host, whatever the agent printed.
      const batch = redact(buffer, secretValues)
      buffer = []
      try {
        const hb = await api.sendEvents(run.id, batch, { sessionId, costUsd: cost, cwd })
        for (const m of hb.messages) midMessages.push(await withImages(api, run.id, m, attachmentsDir, log))
        if (hb.stop && !stopRequested) {
          stopRequested = true
          abort.abort()
        }
      } catch (err) {
        buffer = batch.concat(buffer) // retry with the next flush
        log(`${tag} flush failed: ${(err as Error).message}`)
      }
    })
    return chain
  }
  const timer = setInterval(() => void flush(), cfg.flushMs)
  const timeout = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, cfg.turnTimeoutMs)

  let outcome: FinishBody
  try {
    for (;;) {
      box.pending = null
      box.result = null
      let resultText = ''
      let errorText: string | null = null

      const options: Options = {
        cwd,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.maxBudgetUsd > 0 ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
        abortController: abort,
        mcpServers: {
          ...(ctx.oauth?.proxy.mcpServers() ?? {}),
          gtd: buildControlTools(box, provisioning ? 'provision' : 'task', ctx.oauth),
        },
        // The built-in question dialog has nobody to answer it here.
        disallowedTools: ['AskUserQuestion'],
        permissionMode: 'default',
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        hooks: { PreToolUse: [{ hooks: [guardHook(() => guardLifted, provisioning, guardCtx, () => box.pending !== null)] }] },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: provisioning ? PROVISION_APPEND : SYSTEM_APPEND,
        },
        // Same switch as `claude --chrome`; the SDK runs the Claude Code binary.
        ...(cfg.chrome ? { extraArgs: { chrome: null } } : {}),
        // The run id lets server-side actions (sending a Telegram message) be
        // tied to the confirmation the user approved for this very run.
        env: { ...cfg.env, ...secretValues, AGENT_RUN_ID: run.id },
      }

      for await (const msg of queryFn({ prompt, options })) {
        if (typeof msg.session_id === 'string' && msg.session_id) sessionId = msg.session_id
        buffer.push(...filterOrphanResults(mapMessage(msg), shown))
        if (msg.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') cost = Math.max(cost, msg.total_cost_usd)
          if (msg.subtype === 'success') resultText = msg.result ?? ''
          else errorText = ERROR_TEXT[msg.subtype ?? ''] ?? `Агент завершился: ${msg.subtype}`
        }
      }

      await flush() // also collects a stop or messages sent during the turn
      if (stopRequested || timedOut) break
      if (errorText) {
        buffer.push({ kind: 'error', payload: { text: errorText } })
        outcome = { state: 'error', error: errorText }
        break
      }
      if (midMessages.length) {
        prompt = buildFollowUpPrompt(midMessages)
        midMessages = []
        continue
      }
      outcome = decideOutcome(box, resultText)
      if (outcome.state === 'done' && outcome.result) {
        buffer.push({ kind: 'done', payload: { text: outcome.result.summary } })
      }
      break
    }
  } catch (err) {
    if (!stopRequested && !timedOut) {
      const message = (err as Error).message || String(err)
      buffer.push({ kind: 'error', payload: { text: `Сбой раннера: ${message.slice(0, 500)}` } })
      outcome = { state: 'error', error: message.slice(0, 1000) }
    }
  } finally {
    clearInterval(timer)
    clearTimeout(timeout)
  }

  if (timedOut && !stopRequested) {
    const mins = Math.round(cfg.turnTimeoutMs / 60_000)
    buffer.push({ kind: 'error', payload: { text: `Ход прерван: дольше ${mins} мин. Прогон можно продолжить.` } })
    outcome = { state: 'stopped', error: 'turn timeout' }
  } else if (stopRequested) {
    outcome = { state: 'stopped' }
  }
  outcome ??= { state: 'error', error: 'turn ended without an outcome' }

  await flush()
  const quotaPct = (await ctx.quota?.turnEnded().catch(() => null)) ?? null
  const body: FinishBody = redact(
    { ...outcome, sessionId, cwd, costUsd: cost, ...(quotaPct !== null ? { quotaPct } : {}) },
    secretValues
  )
  // The server may be down or starved for minutes (a deploy, a rebuild): keep
  // trying for about a quarter of an hour before giving the result up.
  const attempts = cfg.finishAttempts ?? 40
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await api.finish(run.id, body)
      log(`${tag} → ${body.state} ($${cost.toFixed(2)}${quotaPct !== null ? `, ${quotaPct}% of the week` : ''})`)
      return
    } catch (err) {
      log(`${tag} finish attempt ${attempt} failed: ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2000, 30_000) * (cfg.finishAttempts ? 0 : 1)))
    }
  }
}

export function startRunner(api: RunsApi, cfg: RunnerConfig, log: Log = (m) => console.log(`[agent-runner] ${m}`)) {
  const active = new Map<string, Promise<void>>()
  let stopped = false
  let lastError = ''
  let wasOverBudget = false
  const secrets = new SecretsFile(cfg.secretsFile)
  const revoking = new Set<string>()
  const installedSkills = new Set<string>()
  const quota = cfg.quota === false ? undefined : new QuotaMeterImpl()
  const vault = new OAuthVault(cfg.oauthDir)
  const proxy = new OAuthProxy(vault)
  const loopback = cfg.env.AI_SERVICE_URL ? startLoopbackCallback(cfg.env.AI_SERVICE_URL, log) : null

  const revoke = async (access: AccessRecord) => {
    if (revoking.has(access.name)) return
    revoking.add(access.name)
    try {
      await revokeOnHost(access, secrets, undefined, undefined, vault)
      await api.accessRevoked?.(access.name)
      log(`access "${access.name}" revoked on this host`)
    } catch (err) {
      log(`access "${access.name}" revoke failed: ${(err as Error).message}`)
    } finally {
      revoking.delete(access.name)
    }
  }

  const tick = async () => {
    if (stopped) return
    try {
      // Claim even at zero capacity: it is also the "runner is alive" ping.
      const { items, overBudget, accesses = [], publicUrl = '' } = await api.claim(cfg.name, Math.max(0, cfg.concurrency - active.size))
      for (const a of accesses) if (a.status === 'revoking') void revoke(a)
      installBundledSkills(accesses, installedSkills, log)
      if (overBudget !== wasOverBudget) {
        log(overBudget ? 'daily limit reached — new runs are on hold' : 'daily limit lifted')
        wasOverBudget = overBudget
      }
      lastError = ''
      for (const claimed of items) {
        const id = claimed.run.id
        log(`${id.slice(0, 8)} start "${claimed.run.taskTitle.slice(0, 60)}"${claimed.run.sessionId ? ' (resume)' : ''}`)
        const p = executeTurn(api, cfg, claimed, log, undefined, {
          accesses,
          secrets,
          quota,
          oauth: { vault, proxy, redirectUri: publicUrl ? `${publicUrl.replace(/\/$/, '')}/oauth/callback` : '' },
        })
          .catch((err) => log(`${id.slice(0, 8)} crashed: ${(err as Error).message}`))
          .finally(() => active.delete(id))
        active.set(id, p)
      }
    } catch (err) {
      const message = (err as Error).message
      if (message !== lastError) log(`claim failed: ${message}`) // log once per distinct failure
      lastError = message
    }
  }

  log(`started as "${cfg.name}", concurrency=${cfg.concurrency}, cwd=${cfg.cwd}`)
  void tick()
  const timer = setInterval(() => void tick(), cfg.pollMs)
  return {
    stop: () => {
      proxy.stop()
      loopback?.stop()
      stopped = true
      clearInterval(timer)
    },
    activeCount: () => active.size,
  }
}
