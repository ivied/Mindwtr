/**
 * Inbox agent runs zone — sits at the top of the Inbox view.
 *
 * Every inbox item can get a full agent (apps/agent-runner on the host). This
 * zone is where the user follows that work and answers when an agent stops:
 *
 *   lanes      queue → working → waiting for you; one dot per run, the working
 *              ones pulse. The aggregate is always visible, details on demand.
 *   focus card one run at a time. By default it walks the runs that wait for a
 *              decision (question, confirmation, result); picking any dot or
 *              row shows that run instead, with its live work log.
 *   all runs   collapsed list for jumping to a specific run.
 *
 * Silent when AI Service is not configured.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentKnowledge } from './AgentKnowledge';
import { Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, KeyRound, Loader2, Play, Terminal, X } from 'lucide-react';
import { useTaskStore } from '@mindwtr/core';
import {
    acceptRun,
    dismissRun,
    decideAccess,
    getAgentRun,
    isAgentRunsAvailable,
    listAgentRuns,
    replyToRun,
    revokeAccess,
    sendSecret,
    sendSignInUrl,
    startInboxRuns,
    startProvision,
    stopRun,
    type AccessScope,
    type AgentRun,
    type AgentRunEvent,
    type AgentRunList,
    type ReplyImage,
    type ReplyKind,
} from '../../lib/agent-runs-client';
import { SyncService } from '../../lib/sync-service';
import { cn } from '../../lib/utils';
import { AgentRunActions, AgentRunLog, StateChip, TONE } from './AgentRunParts';
import {
    LANES,
    accessKindLabel,
    buildSteps,
    elapsedMs,
    formatElapsed,
    formatUsd,
    usageLine,
    laneOfRun,
    lastSaid,
    needsYou,
    nowLine,
    resumeCommand,
    runnerOnline,
    scopeLabel,
} from './model';

const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;
const POLL_LOG_MS = 1_500;
const COLLAPSED_KEY = 'mindwtr.agentRuns.collapsed';

export function InboxAgentRunsZone() {
    const available = isAgentRunsAvailable();
    const tasks = useTaskStore((s) => s.tasks);

    const [list, setList] = useState<AgentRunList | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Server clock minus local clock, so timers don't drift with the browser's clock. */
    const [skewMs, setSkewMs] = useState(0);
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [starting, setStarting] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const [showLog, setShowLog] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [showAccesses, setShowAccesses] = useState(false);
    const [knowledgeTick, setKnowledgeTick] = useState(0);
    const [newService, setNewService] = useState('');
    const [newScope, setNewScope] = useState<AccessScope>('read');
    /** Name of the access whose "revoke" was clicked once and awaits the second click. */
    const [revokeArmed, setRevokeArmed] = useState<string | null>(null);
    // Collapsed = header + lanes only, so the task list keeps its room.
    const [collapsed, setCollapsed] = useState<boolean>(() => {
        try {
            return localStorage.getItem(COLLAPSED_KEY) === '1';
        } catch {
            return false;
        }
    });
    const toggleCollapsed = () =>
        setCollapsed((v) => {
            try {
                localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1');
            } catch {
                /* private mode — the choice just won't persist */
            }
            return !v;
        });
    const [, setClock] = useState(0);

    const refresh = useCallback(async () => {
        try {
            const data = await listAgentRuns();
            setList(data);
            setSkewMs(Date.parse(data.now) - Date.now());
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    const runs = useMemo(() => list?.items ?? [], [list]);
    const anyActive = runs.some((r) => r.state === 'running' || r.state === 'queued');

    // Poll the list: fast while agents work, slow otherwise, never while hidden.
    useEffect(() => {
        if (!available) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loop = async () => {
            if (stopped) return;
            if (!document.hidden) await refresh();
            timer = setTimeout(loop, anyActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        };
        void loop();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [available, anyActive, refresh]);

    // Tick once a second so the timers of working runs advance between polls.
    useEffect(() => {
        if (!runs.some((r) => r.state === 'running')) return;
        const t = setInterval(() => setClock((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [runs]);

    const waiting = useMemo(() => needsYou(runs), [runs]);
    const focus: AgentRun | null =
        (picked ? runs.find((r) => r.id === picked) : null) ?? waiting[0] ?? runs.find((r) => r.state === 'running') ?? null;
    const focusId = focus?.id ?? null;
    const focusState = focus?.state ?? null;
    const focusUpdatedAt = focus?.updatedAt ?? null;

    // Work log of the focused run, fetched incrementally by sequence number.
    const [events, setEvents] = useState<AgentRunEvent[]>([]);
    const logFor = useRef<{ id: string | null; lastSeq: number }>({ id: null, lastSeq: 0 });
    useEffect(() => {
        if (!focusId) {
            logFor.current = { id: null, lastSeq: 0 };
            setEvents([]);
            return;
        }
        if (logFor.current.id !== focusId) {
            logFor.current = { id: focusId, lastSeq: 0 };
            setEvents([]);
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pull = async () => {
            if (stopped) return;
            try {
                const { events: fresh } = await getAgentRun(focusId, logFor.current.lastSeq);
                if (stopped || logFor.current.id !== focusId) return;
                if (fresh.length > 0) {
                    logFor.current.lastSeq = fresh[fresh.length - 1]!.seq;
                    setEvents((prev) => {
                        const last = prev.length > 0 ? prev[prev.length - 1]!.seq : 0;
                        return [...prev, ...fresh.filter((e) => e.seq > last)];
                    });
                }
            } catch {
                /* the list poll surfaces connectivity errors */
            }
            if (focusState === 'running' && !stopped) timer = setTimeout(pull, POLL_LOG_MS);
        };
        void pull();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
        // focusUpdatedAt: re-pull once whenever the run changes while not running.
    }, [focusId, focusState, focusUpdatedAt]);

    const steps = useMemo(() => buildSteps(events), [events]);

    const act = useCallback(
        async (fn: () => Promise<unknown>) => {
            setBusy(true);
            try {
                await fn();
                setError(null);
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setBusy(false);
                void refresh();
            }
        },
        [refresh],
    );

    const inboxWithoutRun = useMemo(() => {
        const covered = new Set(runs.filter((r) => r.kind !== 'provision').map((r) => r.taskId));
        return tasks.filter((t) => t.status === 'inbox' && !t.deletedAt && !covered.has(t.id)).length;
    }, [tasks, runs]);

    if (!available) return null;

    const serverNow = Date.now() + skewMs;
    const online = list ? runnerOnline(list.runnerSeenAt, serverNow) : true;
    const waitingIndex = focus ? waiting.findIndex((r) => r.id === focus.id) : -1;
    const step = (delta: number) => {
        const next = waiting[waitingIndex + delta];
        if (next) setPicked(next.id);
    };

    const onReply = (kind: ReplyKind, text = '', images: ReplyImage[] = []) =>
        focus && void act(() => replyToRun(focus.id, kind, text, images));
    const onStop = () => focus && void act(() => stopRun(focus.id));
    const onAccess = (decision: 'grant' | 'deny', scope?: AccessScope) =>
        focus &&
        void act(async () => {
            const res = await decideAccess(focus.id, decision, scope);
            // Follow the agent that is now connecting the access.
            if (res.provision) setPicked(res.provision.id);
        });
    const onSecret = (value: string) => focus && void act(() => sendSecret(focus.id, value));
    const onSignInUrl = (url: string) => focus && void act(() => sendSignInUrl(focus.id, url));

    const accesses = list?.accesses ?? [];
    const connect = () => {
        const service = newService.trim();
        if (!service) return;
        void act(async () => {
            const res = await startProvision(service, newScope);
            setNewService('');
            if (res.items[0]) setPicked(res.items[0].id);
        });
    };
    const revoke = (name: string) => {
        if (revokeArmed !== name) {
            setRevokeArmed(name);
            return;
        }
        setRevokeArmed(null);
        void act(() => revokeAccess(name));
    };
    const onDismiss = () =>
        focus &&
        void act(async () => {
            await dismissRun(focus.id);
            setPicked(null);
        });
    const onAccept = (apply: boolean, lessons?: number[]) =>
        focus &&
        void act(async () => {
            const res = await acceptRun(focus.id, apply, lessons);
            if (res.remembered) setKnowledgeTick((n) => n + 1);
            setPicked(null);
            if (res.applied) {
                // The task changed in the cloud; pull it so the Inbox reflects it.
                try {
                    await SyncService.performSync();
                } catch (syncErr) {
                    console.warn('[agent-runs] post-accept sync failed:', (syncErr as Error).message);
                }
            }
        });

    const startAll = async () => {
        setStarting(true);
        try {
            await startInboxRuns();
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setStarting(false);
            void refresh();
        }
    };

    const copyResume = async (run: AgentRun) => {
        const cmd = resumeCommand(run);
        if (!cmd) return;
        try {
            await navigator.clipboard.writeText(cmd);
            setCopied('Команда скопирована');
        } catch {
            setCopied(cmd);
        }
        setTimeout(() => setCopied(null), 4000);
    };

    const logOpen = showLog || focus?.state === 'running';

    return (
        <section className="my-3 overflow-hidden rounded-lg border border-border bg-card" aria-label="Агенты в Inbox">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-expanded={!collapsed}
                    className="flex items-center gap-2 text-sm font-medium"
                >
                    <Bot className="h-4 w-4 text-primary" />
                    Агенты
                    {collapsed ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                </button>
                {list ? (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                        {usageLine(list)}
                    </span>
                ) : null}
                {list && !online ? (
                    <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                        раннер не на связи
                    </span>
                ) : null}
                <button
                    type="button"
                    onClick={() => void startAll()}
                    disabled={starting || inboxWithoutRun === 0}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                    {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {inboxWithoutRun > 0 ? `Разобрать Inbox агентами (${inboxWithoutRun})` : 'Весь Inbox уже у агентов'}
                </button>
            </header>

            {error ? <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div> : null}

            {runs.length > 0 ? (
                <div className="grid grid-cols-3 border-b border-border">
                    {LANES.map(({ lane, title }, i) => {
                        const inLane = runs.filter((r) => laneOfRun(r) === lane);
                        return (
                            <div
                                key={lane}
                                className={cn(
                                    'flex min-w-0 flex-col gap-2 px-3 py-2.5',
                                    i > 0 && 'border-l border-border',
                                    lane === 'you' && inLane.length > 0 && 'bg-amber-500/5',
                                )}
                            >
                                <div className="flex items-baseline justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <span>{title}</span>
                                    <b className="text-sm tabular-nums text-foreground">{inLane.length}</b>
                                </div>
                                <div className="flex min-h-[20px] flex-wrap items-center gap-2">
                                    {inLane.map((r) => (
                                        <button
                                            key={r.id}
                                            type="button"
                                            title={r.taskTitle}
                                            aria-label={`${r.taskTitle}: ${r.state}`}
                                            onClick={() => setPicked(r.id)}
                                            className={cn(
                                                'relative h-5 w-5 rounded-full',
                                                TONE[r.state].bg,
                                                r.id === focusId && 'ring-2 ring-foreground ring-offset-2 ring-offset-card',
                                            )}
                                        >
                                            {r.state === 'running' ? (
                                                <span
                                                    className={cn(
                                                        'absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden',
                                                        TONE[r.state].dot,
                                                    )}
                                                />
                                            ) : null}
                                            <span className={cn('absolute inset-1.5 rounded-full', TONE[r.state].dot)} />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : null}

            {collapsed ? null : (
            <div className="max-h-[65vh] overflow-y-auto">
            {list === null && !error ? (
                <div className="flex items-center justify-center p-4 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                </div>
            ) : null}

            {list && runs.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                    Агент разберёт каждую задачу из Inbox: соберёт контекст, сделает что может сам и остановится, если
                    понадобится ваше решение.
                </p>
            ) : null}

            {focus ? (
                <div>
                    <div className="flex flex-col gap-2 px-4 pb-3 pt-3.5">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            {waitingIndex >= 0 ? (
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Решение {waitingIndex + 1} из {waiting.length}
                                </span>
                            ) : null}
                            <StateChip state={focus.state} />
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {formatElapsed(elapsedMs(focus, serverNow))} · {formatUsd(focus.costUsd)} · шагов:{' '}
                                {focus.stepCount}
                            </span>
                            <span className="ml-auto flex items-center gap-1">
                                {focus.sessionId ? (
                                    <button
                                        type="button"
                                        onClick={() => void copyResume(focus)}
                                        title="Скопировать команду, которая откроет эту сессию в терминале"
                                        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                                    >
                                        <Terminal className="h-3 w-3" />
                                        Открыть в терминале
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={onDismiss}
                                    title={
                                        focus.state === 'running'
                                            ? 'Остановить агента и убрать прогон из списка. Задача в Inbox не меняется.'
                                            : 'Убрать прогон из списка. Задача в Inbox не меняется.'
                                    }
                                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                    <X className="h-3 w-3" />
                                    Убрать
                                </button>
                                {waiting.length > 1 && waitingIndex >= 0 ? (
                                    <>
                                        <button
                                            type="button"
                                            aria-label="Предыдущее решение"
                                            disabled={waitingIndex <= 0}
                                            onClick={() => step(-1)}
                                            className="rounded p-1 hover:bg-muted disabled:opacity-40"
                                        >
                                            <ChevronLeft className="h-4 w-4" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Следующее решение"
                                            disabled={waitingIndex >= waiting.length - 1}
                                            onClick={() => step(1)}
                                            className="rounded p-1 hover:bg-muted disabled:opacity-40"
                                        >
                                            <ChevronRight className="h-4 w-4" />
                                        </button>
                                    </>
                                ) : null}
                            </span>
                        </div>
                        <h3 className="text-lg font-semibold leading-snug">{focus.taskTitle}</h3>
                        {focus.state !== 'done' && lastSaid(steps) ? (
                            <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{lastSaid(steps)}</p>
                        ) : null}
                        {copied ? <div className="select-all break-all font-mono text-[11px] text-muted-foreground">{copied}</div> : null}
                    </div>

                    <AgentRunActions
                        run={focus}
                        busy={busy}
                        hold={list?.hold ?? null}
                        onReply={onReply}
                        onStop={onStop}
                        onAccept={onAccept}
                        onAccess={onAccess}
                        onSecret={onSecret}
                        onSignInUrl={onSignInUrl}
                    />

                    <div className="border-t border-border">
                        <button
                            type="button"
                            onClick={() => setShowLog((v) => !v)}
                            aria-expanded={logOpen}
                            className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                            {logOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            Ход работы · шагов: {steps.length}
                        </button>
                        {logOpen ? <AgentRunLog steps={steps} running={focus.state === 'running'} className="max-h-80" /> : null}
                    </div>
                </div>
            ) : null}

            {list && runs.length > 0 && !focus ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">Ничего не ждёт вашего решения.</p>
            ) : null}

            {runs.length > 1 ? (
                <div className="border-t border-border">
                    <button
                        type="button"
                        onClick={() => setShowAll((v) => !v)}
                        aria-expanded={showAll}
                        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                        {showAll ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        Все прогоны · {runs.length}
                    </button>
                    {showAll ? (
                        <ul className="divide-y divide-border border-t border-border">
                            {runs.map((r) => (
                                <li key={r.id}>
                                    <button
                                        type="button"
                                        onClick={() => setPicked(r.id)}
                                        className={cn(
                                            'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-left hover:bg-muted/60',
                                            r.id === focusId && 'bg-muted',
                                        )}
                                    >
                                        <span className="min-w-0 truncate text-sm font-medium">{r.taskTitle}</span>
                                        <StateChip state={r.state} />
                                        <span
                                            className={cn(
                                                'col-span-2 min-w-0 truncate text-xs text-muted-foreground',
                                                r.state === 'running' && 'animate-pulse motion-reduce:animate-none',
                                            )}
                                        >
                                            {r.state === 'running' && r.id !== focusId
                                                ? `Работает · шагов: ${r.stepCount}`
                                                : nowLine(r, steps, list?.hold ?? null)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
            <AgentKnowledge refresh={knowledgeTick} />
            <div className="border-t border-border">
                <button
                    type="button"
                    onClick={() => setShowAccesses((v) => !v)}
                    aria-expanded={showAccesses}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                    {showAccesses ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    <KeyRound className="h-3.5 w-3.5" />
                    Доступы агентов · {accesses.length}
                </button>
                {showAccesses ? (
                    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                        {accesses.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Пока ничего не подключено. Напишите, к чему дать доступ, и агент настроит его сам: от вас
                                понадобится только ключ или вход в аккаунт.
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border">
                                {accesses.map((a) => (
                                    <li key={a.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                                        <span className="text-sm font-medium">{a.name}</span>
                                        <span
                                            className={cn(
                                                'rounded px-1.5 py-0.5 text-[11px] font-medium',
                                                a.scope === 'write'
                                                    ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                                                    : 'bg-muted text-muted-foreground',
                                            )}
                                        >
                                            {scopeLabel(a.scope)}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {accessKindLabel(a.kind)} · с {new Date(a.createdAt).toLocaleDateString('ru-RU')}
                                        </span>
                                        {a.status === 'revoking' ? (
                                            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                                                отзывается
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => revoke(a.name)}
                                                onBlur={() => setRevokeArmed((n) => (n === a.name ? null : n))}
                                                className={cn(
                                                    'ml-auto rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50',
                                                    revokeArmed === a.name
                                                        ? 'border-red-500/50 text-red-700 dark:text-red-300'
                                                        : 'border-border',
                                                )}
                                            >
                                                {revokeArmed === a.name ? 'Точно отозвать?' : 'Отозвать'}
                                            </button>
                                        )}
                                        {a.notes ? (
                                            <p className="basis-full text-xs text-muted-foreground">{a.notes}</p>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                connect();
                            }}
                            className="flex flex-wrap gap-2"
                        >
                            <input
                                value={newService}
                                onChange={(e) => setNewService(e.target.value)}
                                placeholder="К чему подключить: сервис, API, сервер"
                                aria-label="К чему подключить доступ"
                                className="min-w-0 flex-1 basis-48 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                            />
                            <select
                                value={newScope}
                                onChange={(e) => setNewScope(e.target.value as AccessScope)}
                                aria-label="Уровень доступа"
                                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                            >
                                <option value="read">только чтение</option>
                                <option value="write">чтение и запись</option>
                            </select>
                            <button
                                type="submit"
                                disabled={busy || !newService.trim()}
                                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                            >
                                Подключить
                            </button>
                        </form>
                    </div>
                ) : null}
            </div>
            </div>
            )}
        </section>
    );
}
