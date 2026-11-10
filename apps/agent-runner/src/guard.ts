/**
 * Outward-action guard.
 *
 * The agent has full access to the machine, but anything that reaches other
 * people or can't be undone has to go through request_confirmation first. The
 * system prompt states the rule; this is the backstop for the obvious cases.
 * It is a heuristic over tool names, shell text and the agent's own description
 * of its browser actions, not a sandbox: it catches
 * the common ways to send / publish / deploy / destroy, and the turn that
 * follows an explicit user approval runs with the guard lifted.
 */

interface ShellRule {
  re: RegExp
  why: string
}

const SHELL_RULES: ShellRule[] = [
  { re: /\bgit\s+push\b/, why: 'git push публикует изменения' },
  { re: /\bgh\s+(pr\s+(merge|close|create)|release\s+create|issue\s+(create|close|comment))\b/, why: 'действие в GitHub' },
  { re: /\bhermes\s+send\b/, why: 'отправка сообщения через Hermes' },
  { re: /\bdocker(\s+compose|-compose)?\b[^|;&\n]*?\s(up|down|restart|stop|rm|kill)\b/, why: 'перезапуск или остановка контейнеров' },
  { re: /\bcolima\s+(stop|delete|restart)\b/, why: 'остановка Colima' },
  { re: /\blaunchctl\s+(bootout|unload|remove|kickstart)\b/, why: 'изменение сервисов launchd' },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b/, why: 'рекурсивное удаление' },
  { re: /\b(chat\.postMessage|chat\.update|chat\.delete|conversations\.(invite|kick|archive))\b/, why: 'запись в Slack' },
  { re: /api\.telegram\.org\/bot[^/\s]*\/(send|delete|edit|forward)/i, why: 'отправка в Telegram' },
  // The user's own account through ai-service. The server checks the approval
  // itself; this only tells the agent so before it tries.
  { re: /\/v1\/telegram\/send\b/, why: 'отправка сообщения в Telegram от имени пользователя' },
  { re: /\b(sendmail|mail\s+-s|msmtp)\b/, why: 'отправка письма' },
  { re: /\bosascript\b[\s\S]*\b(send|make new outgoing message)\b/i, why: 'отправка через приложение macOS' },
  { re: /\b(npm|bun|pnpm|yarn)\s+publish\b/, why: 'публикация пакета' },
  { re: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, why: 'удаление данных в базе' },
]

/** `rm -r…` whose every path argument lives under a temp dir. */
const RM_TMP_ONLY = /^\s*rm\s+(-[a-zA-Z]+\s+)+((\/private)?\/tmp\/\S+|\$TMPDIR\/?\S+)(\s+((\/private)?\/tmp\/\S+|\$TMPDIR\/?\S+))*\s*$/

const CURL_WRITE =/\bcurl\b[^|;&\n]*?(-X\s*['"]?(POST|PUT|PATCH|DELETE)\b|--request\s+['"]?(POST|PUT|PATCH|DELETE)\b|\s(-d|--data(-raw|-binary|-urlencode)?|-F|--form|--json)\s)/i
const LOCAL_HOST = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b|\$\{?(AI_SERVICE_URL|MINDWTR_CLOUD_URL)\b/

const MCP_WRITE = /(^|_)(send|post|reply|schedule|create|update|delete|remove|write|publish|invite|archive|add|set|move|rename|upload)(_|$)/i

/**
 * Claude in Chrome acts in the user's real browser with their logins, so the
 * page is as outward as a shell. Reading, navigating and opening menus are
 * free. What is held back: scripts and uploads always; clicks, key presses and
 * text entry by what the agent itself says they do (`action_summary`, which
 * the tool requires on each of them); Enter unless it runs a search.
 */
const CHROME_PREFIX = 'mcp__claude-in-chrome__'
const CHROME_ALWAYS: Record<string, string> = {
  javascript_tool: 'выполнение скрипта на странице',
  file_upload: 'загрузка файла на сайт',
  upload_image: 'загрузка изображения на сайт',
}
const CHROME_DESCRIBED = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag', 'key', 'type'])
const OUTWARD_SUMMARY =
  /\b(send|sends|sending|post|posts|publish\w*|repl(y|ies)|submit\w*|delet\w*|remov\w*|archiv\w*|pay\w*|buy\w*|purchas\w*|order\w*|checkout|merg\w*|approv\w*|invit\w*|shar\w*|upload\w*|sav(e|es|ing)|confirm\w*|accept\w*|declin\w*|reject\w*|cancel\w*|unsubscrib\w*|subscrib\w*|book(s|ed|ing)?|transfer\w*|sign(s|ing)?\s+(up|out|off)|log(s|ging)?\s+out)\b|отправ|опублик|ответ(ить|ит|ил)|удал|архив|оплат|купи|покуп|заказ|подтвер|сохран|приглас|отмен|подпис|брониру|перевод|выйти|выход/i
const SEARCH_SUMMARY = /\b(search\w*|find\w*|filter\w*|quer\w*|look\w*\s+up)\b|поиск|иска|найти|фильтр/i
const ENTER_KEY = /\b(enter|return)\b/i

function chromeReason(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'browser_batch') {
    const actions = Array.isArray(args.actions) ? args.actions : []
    for (const item of actions) {
      const a = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const input = a.input && typeof a.input === 'object' ? (a.input as Record<string, unknown>) : {}
      const reason = chromeReason(typeof a.name === 'string' ? a.name.replace(CHROME_PREFIX, '') : '', input)
      if (reason) return reason
    }
    return null
  }
  if (CHROME_ALWAYS[tool]) return CHROME_ALWAYS[tool]!
  if (tool === 'navigate') {
    return /^\s*javascript:/i.test(typeof args.url === 'string' ? args.url : '') ? CHROME_ALWAYS.javascript_tool! : null
  }

  const action = typeof args.action === 'string' ? args.action : ''
  const described = tool === 'form_input' || (tool === 'computer' && CHROME_DESCRIBED.has(action))
  if (!described) return null

  const summary = typeof args.action_summary === 'string' ? args.action_summary.trim() : ''
  if (!summary) return 'действие в браузере без описания (заполни action_summary)'
  const searching = SEARCH_SUMMARY.test(summary)
  if (action === 'key' && ENTER_KEY.test(typeof args.text === 'string' ? args.text : '') && !searching) {
    return `Enter в браузере: ${summary}`
  }
  if (OUTWARD_SUMMARY.test(summary) && !(searching && /submit/i.test(summary) && !/\b(send|post|repl|delet|pay|order)/i.test(summary))) {
    return `действие в браузере: ${summary}`
  }
  return null
}

export interface GuardContext {
  /** Hosts of accesses the user granted with write scope: writes to them pass. */
  trustedHosts?: string[]
  /** MCP servers granted with write scope. */
  trustedMcp?: string[]
}

const mentionsHost = (line: string, hosts: string[]) => {
  const lower = line.toLowerCase()
  return hosts.some((h) => {
    const at = lower.indexOf(h.toLowerCase())
    if (at < 0) return false
    const before = at === 0 ? '/' : lower[at - 1]!
    const after = lower[at + h.length] ?? '/'
    // A whole host, not a suffix of another one (evil-api.example.com).
    return /[\s/@'"]/.test(before) && /[\s/:?'"]/.test(after)
  })
}

/**
 * Returns why a tool call needs confirmation, or null when it may proceed.
 */
export function outwardReason(toolName: string, input: unknown, ctx: GuardContext = {}): string | null {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  if (toolName === 'Bash') {
    const cmd = typeof args.command === 'string' ? args.command : ''
    for (const rule of SHELL_RULES) {
      if (!rule.re.test(cmd)) continue
      // Cleaning up its own temp files is not worth a confirmation round-trip.
      if (rule.why === 'рекурсивное удаление' && RM_TMP_ONLY.test(cmd)) continue
      return rule.why
    }
    // Writes over HTTP to anything but the local GTD stack.
    for (const line of cmd.split(/\n|&&|\|\||;/)) {
      if (CURL_WRITE.test(line) && !LOCAL_HOST.test(line) && !mentionsHost(line, ctx.trustedHosts ?? [])) return 'HTTP-запрос на запись во внешний сервис'
    }
    return null
  }

  if (toolName.startsWith(CHROME_PREFIX)) return chromeReason(toolName.slice(CHROME_PREFIX.length), args)

  if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__gtd__')) {
    const action = toolName.split('__').slice(2).join('__')
    if ((ctx.trustedMcp ?? []).includes(toolName.split('__')[1] ?? '')) return null
    if (MCP_WRITE.test(action)) return `запись через ${toolName.split('__')[1] ?? 'MCP'}`
  }
  return null
}

/**
 * What agents are allowed to reach is decided by the user and set up by a
 * provisioning run. A task agent works from text that arrives from outside
 * (mail, chats, the task itself), so it must not be able to widen its own
 * access: MCP servers, skills, Claude settings and the secrets file are off
 * limits to it. Never lifted, not even after an approval.
 */
const SECRETS_PATH = /gtd-agents\/secrets|\.config\/gtd-agents/
const AGENT_CONFIG_PATH =
  /\.claude\/(skills|settings[\w.]*\.json|agents|commands|plugins)|\.claude\.json|\.mcp\.json|LaunchAgents\/uk\.kurdy\.gtd-agent-runner/
const MCP_ADMIN = /\bclaude\s+mcp\s+(add|add-json|add-from-claude-desktop|remove|import)\b/
const SHELL_WRITES =
  /(>|\btee\b|\bsed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\b(mv|cp|rm|mkdir|touch|ln|chmod|install|rsync|python3?|node|bun|perl|ruby|dd)\b)/

export function accessConfigReason(toolName: string, input: unknown): string | null {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (toolName === 'Bash') {
    const cmd = typeof args.command === 'string' ? args.command : ''
    if (MCP_ADMIN.test(cmd)) return 'изменение MCP-серверов'
    if (SECRETS_PATH.test(cmd)) return 'обращение к файлу секретов'
    if (AGENT_CONFIG_PATH.test(cmd) && SHELL_WRITES.test(cmd)) return 'изменение конфигурации агентов'
    return null
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit' || toolName === 'Read') {
    const path =
      typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : ''
    if (SECRETS_PATH.test(path)) return 'обращение к файлу секретов'
    if (toolName !== 'Read' && AGENT_CONFIG_PATH.test(path)) return 'изменение конфигурации агентов'
  }
  return null
}

/** The provisioning agent sets things up, but still has no business in the secrets file itself. */
export function secretsFileReason(toolName: string, input: unknown): string | null {
  const reason = accessConfigReason(toolName, input)
  return reason === 'обращение к файлу секретов' ? reason : null
}

export function accessDenyMessage(reason: string): string {
  return (
    `Заблокировано: ${reason}. Доступы и конфигурацию агентов настраивает отдельный прогон с разрешения пользователя. ` +
    'Если для задачи нужен сервис, к которому доступа нет, вызови mcp__gtd__request_access и заверши ход.'
  )
}

export function denyMessage(reason: string): string {
  return (
    `Заблокировано: ${reason}. Это внешнее или необратимое действие. ` +
    'Вызови mcp__gtd__request_confirmation с точным текстом или командой и заверши ход. ' +
    'После подтверждения пользователя действие можно будет выполнить.'
  )
}
