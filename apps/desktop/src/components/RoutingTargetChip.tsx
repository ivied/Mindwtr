import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, Cloud, Laptop, Plus } from 'lucide-react';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { reportError } from '../lib/report-error';
import {
    parseRoutingTarget,
    routingTargetLabel,
    targetsEqual,
    withRoutingTarget,
    type RoutingTarget,
} from '../lib/routing-target';
import { reposFromThreads, searchThreads } from '../lib/thread-registry';
import { listThreads, type RegistryThread } from '../lib/proposals-client';

/**
 * RoutingTargetChip — the one new control on an @ai-agent card.
 *
 * Shows WHERE the task will run (OpenClaw / a Mac thread / a fresh Mac thread)
 * and opens a picker to change it. The Enricher pre-fills the target; this chip
 * is both the display of its choice and the user's manual override — the same
 * picker the "Send to agent" quick action funnels into.
 */
export function RoutingTargetChip({ task }: { task: Task }) {
    const updateTask = useTaskStore((s) => s.updateTask);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [allThreads, setAllThreads] = useState<RegistryThread[]>([]);

    // Fetch the live registry once (served by ai-service from ~/.claude/projects).
    useEffect(() => {
        let cancelled = false;
        listThreads()
            .then((items) => {
                if (!cancelled) setAllThreads(items);
            })
            .catch(() => {
                /* ai-service not configured → picker still offers OpenClaw + new-thread */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const current = parseRoutingTarget(task.tags);
    const threads = useMemo(() => searchThreads(allThreads, query), [allThreads, query]);
    const repos = useMemo(() => {
        const all = reposFromThreads(allThreads);
        const q = query.trim().toLowerCase();
        return q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
    }, [allThreads, query]);

    const apply = useCallback(
        async (next: RoutingTarget) => {
            setOpen(false);
            setQuery('');
            try {
                await updateTask(task.id, {
                    assignedTo: '@ai-agent',
                    tags: withRoutingTarget(task.tags, next),
                });
            } catch (err) {
                reportError('Failed to set routing target', err);
            }
        },
        [task.id, task.tags, updateTask]
    );

    const Row = ({
        icon,
        title,
        subtitle,
        target,
    }: {
        icon: React.ReactNode;
        title: string;
        subtitle?: string;
        target: RoutingTarget;
    }) => {
        const active = targetsEqual(current, target);
        return (
            <button
                type="button"
                onMouseDown={(e) => {
                    e.preventDefault();
                    void apply(target);
                }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
                <span className="text-muted-foreground">{icon}</span>
                <span className="flex-1 truncate">
                    <span className="font-medium">{title}</span>
                    {subtitle ? <span className="ml-1.5 text-muted-foreground">{subtitle}</span> : null}
                </span>
                {active ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}
            </button>
        );
    };

    return (
        <div
            className="relative border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
                <span>Агент ·</span>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
                >
                    {current?.kind === 'openclaw' ? (
                        <Cloud className="h-3 w-3" />
                    ) : (
                        <Laptop className="h-3 w-3" />
                    )}
                    {routingTargetLabel(current, allThreads)}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
            </div>

            {open ? (
                <>
                    {/* click-outside backdrop */}
                    <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
                    <div className="absolute left-3 z-40 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                        <div className="border-b border-border/60 p-1.5">
                            <input
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Поиск треда…"
                                className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                        </div>
                        <div className="max-h-72 overflow-auto py-1">
                            <Row
                                icon={<Cloud className="h-3.5 w-3.5" />}
                                title="OpenClaw"
                                subtitle="облако, с нуля"
                                target={{ kind: 'openclaw' }}
                            />

                            <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Продолжить тред на Маке
                            </div>
                            {threads.map((th) => (
                                <Row
                                    key={th.sessionId}
                                    icon={<Laptop className="h-3.5 w-3.5" />}
                                    title={th.alias}
                                    subtitle={`#${th.sessionId.slice(0, 8)} · ${th.lastTouched.slice(5)}`}
                                    target={{ kind: 'mac-thread', sessionId: th.sessionId }}
                                />
                            ))}
                            {threads.length === 0 ? (
                                <div className="px-2 py-1 text-xs italic text-muted-foreground">
                                    нет совпадений
                                </div>
                            ) : null}

                            <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Новый тред
                            </div>
                            {repos.map((r) => (
                                <Row
                                    key={r.slug}
                                    icon={<Plus className="h-3.5 w-3.5" />}
                                    title={`Новый тред в ${r.label}`}
                                    target={{ kind: 'mac-new', repo: r.slug }}
                                />
                            ))}
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
