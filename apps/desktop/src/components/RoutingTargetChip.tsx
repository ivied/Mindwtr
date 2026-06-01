import { useEffect, useState } from 'react';
import { Bot, ChevronDown, Cloud, Laptop } from 'lucide-react';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { reportError } from '../lib/report-error';
import {
    parseRoutingTarget,
    routingTargetLabel,
    withRoutingTarget,
    type RoutingTarget,
} from '../lib/routing-target';
import { listThreads, type RegistryThread } from '../lib/proposals-client';
import { RoutingTargetOptions } from './RoutingTargetOptions';

/**
 * RoutingTargetChip — the one new control on an @ai-agent card.
 *
 * Shows WHERE the task will run (OpenClaw / a Mac thread / a fresh Mac thread)
 * and opens the shared picker to change it. The Enricher pre-fills the target;
 * this chip is both the display of its choice and the user's manual override —
 * the same picker the "Send to agent" quick action uses.
 */
export function RoutingTargetChip({ task }: { task: Task }) {
    const updateTask = useTaskStore((s) => s.updateTask);
    const [open, setOpen] = useState(false);
    const [allThreads, setAllThreads] = useState<RegistryThread[]>([]);

    // Fetched only to resolve the collapsed chip's label (alias for a mac thread).
    useEffect(() => {
        let cancelled = false;
        listThreads()
            .then((items) => {
                if (!cancelled) setAllThreads(items);
            })
            .catch(() => {
                /* ai-service not configured → label falls back to short id */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const current = parseRoutingTarget(task.tags);

    const apply = (next: RoutingTarget) => {
        setOpen(false);
        void updateTask(task.id, {
            assignedTo: '@ai-agent',
            tags: withRoutingTarget(task.tags, next),
        }).catch((err) => reportError('Failed to set routing target', err));
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
                        <RoutingTargetOptions current={current} onPick={apply} />
                    </div>
                </>
            ) : null}
        </div>
    );
}
