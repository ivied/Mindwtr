/**
 * AI Playbook view (FR90, Phase 1b.3).
 *
 * Visual surface over the procedural-memory review API: every playbook
 * chunk the assistant indexed from the shared memory (OpenClaw MEMORY.md),
 * its visibility class (universal = the Proposer sees it, openclaw-only =
 * hidden), who classified it, and the reliability score it earned from
 * the user's approve/reject actions (FR89).
 *
 * Lets the user flip a chunk universal ⇄ openclaw-only inline — the
 * "fix the logic when you see impact on real tasks" surface. Manual
 * verdicts are terminal server-side (classified_by='user').
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Sparkles, Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    isProceduralAvailable,
    getProceduralStats,
    listProceduralChunks,
    classifyProceduralChunk,
    type ProceduralChunk,
    type ProceduralStats,
    type AppliesTo,
} from '../../lib/procedural-client';

type Filter = 'all' | 'universal' | 'openclaw-only';

export function ProceduralPlaybookView() {
    const available = isProceduralAvailable();
    const [stats, setStats] = useState<ProceduralStats | null>(null);
    const [chunks, setChunks] = useState<ProceduralChunk[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [s, c] = await Promise.all([
                getProceduralStats(),
                listProceduralChunks({ limit: 500 }),
            ]);
            setStats(s);
            setChunks(c.items);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (available) void load();
        else setLoading(false);
    }, [available, load]);

    const onReclassify = useCallback(
        async (chunk: ProceduralChunk, appliesTo: AppliesTo) => {
            if (chunk.appliesTo === appliesTo) return;
            setBusyId(chunk.id);
            // optimistic
            setChunks((prev) =>
                prev.map((c) => (c.id === chunk.id ? { ...c, appliesTo, classifiedBy: 'user' } : c))
            );
            try {
                await classifyProceduralChunk(chunk.id, appliesTo);
                void getProceduralStats().then(setStats).catch(() => {});
            } catch (err) {
                setError((err as Error).message);
                void load(); // resync on failure
            } finally {
                setBusyId(null);
            }
        },
        [load]
    );

    const filtered = useMemo(() => {
        const rows = filter === 'all' ? chunks : chunks.filter((c) => c.appliesTo === filter);
        // group by section title, preserving order
        const groups: { title: string; items: ProceduralChunk[] }[] = [];
        for (const c of rows) {
            const title = c.sectionTitle || '(preamble)';
            const last = groups[groups.length - 1];
            if (last && last.title === title) last.items.push(c);
            else groups.push({ title, items: [c] });
        }
        return groups;
    }, [chunks, filter]);

    if (!available) {
        return (
            <div className="p-6 text-sm text-muted-foreground">
                <div className="flex items-center gap-2 font-medium">
                    <Sparkles className="h-4 w-4" /> AI Playbook
                </div>
                <p className="mt-2">AI Service is not configured (VITE_AI_SERVICE_URL/TOKEN). Playbook unavailable.</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="border-b px-6 py-4">
                <div className="flex items-center justify-between">
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        <Sparkles className="h-5 w-5 text-violet-500" /> AI Playbook
                    </h1>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
                    </button>
                </div>
                {stats ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{stats.total} rules</span>
                        <span className="text-emerald-600 dark:text-emerald-400">
                            {stats.byApplies.universal ?? 0} visible to AI
                        </span>
                        <span>{stats.byApplies['openclaw-only'] ?? 0} hidden (OpenClaw-only)</span>
                        <span>
                            reliability: {stats.reliability.scored} scored
                            {stats.reliability.avg != null
                                ? `, avg ${stats.reliability.avg.toFixed(2)}`
                                : ''}
                            {stats.reliability.belowHalf > 0
                                ? `, ${stats.reliability.belowHalf} below 0.5`
                                : ''}
                        </span>
                    </div>
                ) : null}
                <div className="mt-3 flex gap-1">
                    {(['all', 'universal', 'openclaw-only'] as Filter[]).map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => setFilter(f)}
                            className={cn(
                                'rounded-full px-3 py-1 text-xs',
                                filter === f ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'
                            )}
                        >
                            {f === 'all' ? 'All' : f === 'universal' ? 'Visible to AI' : 'Hidden'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
                {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}
                {loading && chunks.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading playbook…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No rules in this filter.</div>
                ) : (
                    <div className="space-y-5">
                        {filtered.map((group) => (
                            <section key={group.title}>
                                <h2 className="mb-1.5 text-sm font-semibold text-foreground/80">
                                    {group.title.replace(/^#+\s*/, '')}
                                </h2>
                                <div className="space-y-2">
                                    {group.items.map((c) => (
                                        <ChunkRow
                                            key={c.id}
                                            chunk={c}
                                            busy={busyId === c.id}
                                            onReclassify={onReclassify}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ChunkRow({
    chunk,
    busy,
    onReclassify,
}: {
    chunk: ProceduralChunk;
    busy: boolean;
    onReclassify: (chunk: ProceduralChunk, applies: AppliesTo) => void;
}) {
    const isUniversal = chunk.appliesTo === 'universal';
    const score = chunk.reliabilityScore;
    return (
        <div
            className={cn(
                'rounded-md border p-2.5 text-sm',
                isUniversal ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-muted/30'
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
                    {chunk.excerpt}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                    <button
                        type="button"
                        title="Visible to AI (universal)"
                        onClick={() => onReclassify(chunk, 'universal')}
                        disabled={busy}
                        className={cn(
                            'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs disabled:opacity-50',
                            isUniversal
                                ? 'bg-emerald-600 text-white'
                                : 'border hover:bg-muted'
                        )}
                    >
                        <Eye className="h-3 w-3" />
                    </button>
                    <button
                        type="button"
                        title="Hidden from AI (OpenClaw-only)"
                        onClick={() => onReclassify(chunk, 'openclaw-only')}
                        disabled={busy}
                        className={cn(
                            'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs disabled:opacity-50',
                            !isUniversal
                                ? 'bg-slate-600 text-white'
                                : 'border hover:bg-muted'
                        )}
                    >
                        <EyeOff className="h-3 w-3" />
                    </button>
                </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>{chunk.appliesTo}</span>
                {chunk.classifiedBy ? <span>· by {chunk.classifiedBy}</span> : null}
                {score != null ? (
                    <span
                        className={cn(
                            'normal-case',
                            score >= 0.6
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : score < 0.5
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : ''
                        )}
                    >
                        · reliability {score.toFixed(2)}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
