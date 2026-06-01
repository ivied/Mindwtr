import { useEffect, useMemo, useState } from 'react';
import { Check, Cloud, Laptop, Plus } from 'lucide-react';
import { listThreads, type RegistryThread } from '../lib/proposals-client';
import { reposFromThreads, searchThreads } from '../lib/thread-registry';
import { targetsEqual, type RoutingTarget } from '../lib/routing-target';

/**
 * The pick-a-target list — OpenClaw, a live Mac thread, or a fresh thread per
 * repo. Shared by the card chip (RoutingTargetChip) and the "Send to agent"
 * quick-action panel so both offer the exact same choice. Threads come from
 * ai-service /v1/threads (scan of ~/.claude/projects).
 */
export function RoutingTargetOptions({
    current,
    onPick,
}: {
    current: RoutingTarget | null;
    onPick: (target: RoutingTarget) => void;
}) {
    const [allThreads, setAllThreads] = useState<RegistryThread[]>([]);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        listThreads()
            .then((items) => {
                if (!cancelled) setAllThreads(items);
            })
            .catch(() => {
                /* ai-service not configured → still offer OpenClaw + new-thread */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const threads = useMemo(() => searchThreads(allThreads, query).slice(0, 8), [allThreads, query]);
    const repos = useMemo(() => {
        const all = reposFromThreads(allThreads);
        const q = query.trim().toLowerCase();
        return q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
    }, [allThreads, query]);

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
    }) => (
        <button
            type="button"
            onMouseDown={(e) => {
                e.preventDefault();
                onPick(target);
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
        >
            <span className="text-muted-foreground">{icon}</span>
            <span className="flex-1 truncate">
                <span className="font-medium">{title}</span>
                {subtitle ? <span className="ml-1.5 text-muted-foreground">{subtitle}</span> : null}
            </span>
            {targetsEqual(current, target) ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}
        </button>
    );

    return (
        <div className="w-full">
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
                    <div className="px-2 py-1 text-xs italic text-muted-foreground">нет совпадений</div>
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
    );
}
