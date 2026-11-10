/**
 * Pure view-model helpers for the Inbox agent runs zone. No React, no fetch —
 * everything here is unit-tested.
 */

import type { AgentRun, AgentRunEvent, AgentRunList, AgentRunState, HoldReason } from '../../lib/agent-runs-client';

export type Lane = 'queued' | 'running' | 'you';

export const STATE_LABEL: Record<AgentRunState, string> = {
    queued: 'в очереди',
    running: 'работает',
    question: 'ждёт ответа',
    confirm: 'просит подтвердить',
    done: 'готово',
    stopped: 'остановлен',
    error: 'ошибка',
    closed: 'закрыто',
};

export const LANES: Array<{ lane: Lane; title: string }> = [
    { lane: 'queued', title: 'В очереди' },
    { lane: 'running', title: 'Работают' },
    { lane: 'you', title: 'Ждут вас' },
];

export function laneOf(state: AgentRunState): Lane | null {
    if (state === 'queued') return 'queued';
    if (state === 'running') return 'running';
    if (state === 'closed') return null;
    return 'you';
}

/** Order in which parked runs are offered: blockers first, finished work last. */
const YOU_ORDER: Partial<Record<AgentRunState, number>> = {
    question: 0,
    confirm: 1,
    error: 2,
    stopped: 3,
    done: 4,
};

/** Lane of a run: one whose access is being connected waits on an agent, not on the user. */
export function laneOfRun(run: AgentRun): Lane | null {
    return waitsOnProvision(run) ? 'queued' : laneOf(run.state);
}

export function needsYou(runs: AgentRun[]): AgentRun[] {
    return runs
        .filter((r) => laneOfRun(r) === 'you')
        .sort(
            (a, b) =>
                (YOU_ORDER[a.state] ?? 9) - (YOU_ORDER[b.state] ?? 9) || a.updatedAt.localeCompare(b.updatedAt),
        );
}

/** Active time of a run; a turn in flight keeps counting against the server clock. */
export function elapsedMs(run: AgentRun, serverNowMs: number): number {
    const live =
        run.state === 'running' && run.turnStartedAt ? Math.max(0, serverNowMs - Date.parse(run.turnStartedAt)) : 0;
    return run.durationMs + live;
}

export function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

export type StepKind = 'say' | 'tool' | 'user' | 'done' | 'error';

export interface LogStep {
    seq: number;
    kind: StepKind;
    text: string;
    /** tool steps */
    tool?: string;
    call?: string;
    input?: string;
    output?: string;
    isError?: boolean;
    /** True until the matching tool_result arrives. */
    waiting?: boolean;
    /** Produced by a subagent (rendered nested). */
    nested: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Fold the raw event log into display steps: tool results join their call. */
export function buildSteps(events: AgentRunEvent[]): LogStep[] {
    const steps: LogStep[] = [];
    const byToolUse = new Map<string, LogStep>();
    for (const e of events) {
        const p = e.payload;
        if (e.kind === 'tool_result') {
            const step = byToolUse.get(str(p.toolUseId));
            if (step) {
                step.output = str(p.output);
                step.isError = p.isError === true;
                step.waiting = false;
            }
            continue;
        }
        const nested = typeof p.parent === 'string' && p.parent.length > 0;
        if (e.kind === 'tool') {
            const step: LogStep = {
                seq: e.seq,
                kind: 'tool',
                text: '',
                tool: str(p.tool) || str(p.name),
                call: str(p.call),
                input: str(p.input),
                waiting: true,
                nested,
            };
            byToolUse.set(str(p.toolUseId), step);
            steps.push(step);
        } else {
            const images = e.kind === 'user' && Array.isArray(p.images) ? p.images.length : 0;
            const text = [str(p.text), images ? `[изображений: ${images}]` : ''].filter(Boolean).join(' ');
            steps.push({ seq: e.seq, kind: e.kind, text, nested });
        }
    }
    return steps;
}

/** What a queued run is waiting for. A run that already started is never held by the daily limit. */
export function queuedLine(run: AgentRun, hold: HoldReason | null = null): string {
    if (run.sessionId) return 'Продолжит, как только освободится агент';
    if (hold === 'quota') return 'Дневная доля недельной нормы израсходована — стартует завтра';
    if (hold === 'budget') return 'Дневной лимит израсходован — стартует завтра';
    return 'Ждёт свободного агента';
}

/** Today's usage for the zone header: share of the weekly quota when it is metered, the dollar estimate otherwise. */
export function usageLine(list: Pick<AgentRunList, 'spentTodayUsd' | 'dailyBudgetUsd' | 'quotaTodayPct' | 'dailyQuotaPct'>): string {
    const usd = formatUsd(list.spentTodayUsd);
    if ((list.dailyQuotaPct ?? 0) > 0) {
        return `сегодня ${Math.round(list.quotaTodayPct ?? 0)}% из ${list.dailyQuotaPct}% недельной нормы · ≈${usd}`;
    }
    return `сегодня ${usd}${list.dailyBudgetUsd > 0 ? ` из ${formatUsd(list.dailyBudgetUsd)}` : ''}`;
}

/** The one line a collapsed run shows: what it is doing or what it needs. */
export function nowLine(run: AgentRun, steps: LogStep[] = [], hold: HoldReason | null = null): string {
    switch (run.state) {
        case 'question':
            if (run.pending?.kind === 'secret') return `Нужен ключ: ${run.pending.label}`;
            if (run.pending?.kind === 'oauth') return `Нужен вход: ${run.pending.label}`;
            return run.pending?.kind === 'question' ? run.pending.question : 'Ждёт ответа';
        case 'confirm':
            if (run.pending?.kind === 'access') {
                return run.pending.provisionRunId
                    ? `Доступ к «${run.pending.service}» подключается`
                    : `Просит доступ: ${run.pending.service} (${scopeLabel(run.pending.scope)})`;
            }
            return run.pending?.kind === 'confirm' ? `${run.pending.action} → ${run.pending.target}` : 'Просит подтверждение';
        case 'done':
        case 'closed':
            return run.result?.summary ?? '';
        case 'queued':
            return queuedLine(run, hold);
        case 'stopped':
            return run.error === 'runner lost' ? 'Раннер перестал отвечать' : 'Остановлен';
        case 'error':
            return run.error ?? 'Ошибка';
        case 'running': {
            const last = steps[steps.length - 1];
            if (!last) return 'Запускается';
            return last.kind === 'tool' ? `${last.tool}: ${last.call}` : last.text;
        }
    }
}

export function scopeLabel(scope: 'read' | 'write'): string {
    return scope === 'write' ? 'чтение и запись' : 'только чтение';
}

const ACCESS_KIND_LABEL: Record<string, string> = { mcp: 'MCP', cli: 'CLI', http: 'HTTP API', ssh: 'SSH', other: 'другое' };

export function accessKindLabel(kind: string): string {
    return ACCESS_KIND_LABEL[kind] ?? kind;
}

/**
 * A run whose access is being connected is waiting on another agent, not on
 * the user — it must not sit in the decision queue.
 */
export function waitsOnProvision(run: AgentRun): boolean {
    return run.state === 'confirm' && run.pending?.kind === 'access' && Boolean(run.pending.provisionRunId);
}

/** What the agent last said before stopping — the context line of a decision card. */
export function lastSaid(steps: LogStep[]): string {
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]!;
        if (s.kind === 'say' && !s.nested) return s.text;
    }
    return '';
}

/** Runner is considered offline when it hasn't polled for this long. */
export const RUNNER_OFFLINE_AFTER_MS = 30_000;

export function runnerOnline(runnerSeenAt: string | null, serverNowMs: number): boolean {
    return runnerSeenAt !== null && serverNowMs - Date.parse(runnerSeenAt) < RUNNER_OFFLINE_AFTER_MS;
}

const STATUS_LABEL: Record<string, string> = {
    inbox: 'Inbox',
    next: 'Следующие',
    waiting: 'Ожидание',
    someday: 'Когда-нибудь',
    reference: 'Справочное',
    done: 'Готово',
};

/** Human rows for "what will change in the task" on a result card. */
export function changeRows(run: AgentRun): Array<[string, string]> {
    const c = run.result?.changes;
    if (!c) return [];
    const rows: Array<[string, string]> = [];
    if (c.title) rows.push(['Заголовок', c.title]);
    if (c.status) rows.push(['Статус', `Inbox → ${STATUS_LABEL[c.status] ?? c.status}`]);
    if (c.project) rows.push(['Проект', c.project]);
    if (c.contexts?.length) rows.push(['Контексты', c.contexts.join(', ')]);
    if (c.addTags?.length) rows.push(['Теги', c.addTags.join(', ')]);
    if (c.descriptionAppend) rows.push(['В описание', c.descriptionAppend]);
    return rows;
}

/** Shell command that opens the run's session in a terminal. */
export function resumeCommand(run: AgentRun): string | null {
    if (!run.sessionId) return null;
    return run.cwd ? `cd ${run.cwd} && claude --resume ${run.sessionId}` : `claude --resume ${run.sessionId}`;
}
