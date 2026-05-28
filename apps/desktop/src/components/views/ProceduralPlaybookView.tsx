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
import { Sparkles, Eye, EyeOff, Loader2, RefreshCw, Plus, Pencil, Archive, ArchiveRestore, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    isProceduralAvailable,
    getProceduralStats,
    listProceduralChunks,
    classifyProceduralChunk,
    createProceduralChunk,
    updateProceduralChunk,
    USER_SETTABLE_APPLIES,
    type ProceduralChunk,
    type ProceduralStats,
    type AppliesTo,
} from '../../lib/procedural-client';

type Filter = 'all' | 'universal' | 'openclaw-only' | 'archived';

export function ProceduralPlaybookView() {
    const available = isProceduralAvailable();
    const [stats, setStats] = useState<ProceduralStats | null>(null);
    const [chunks, setChunks] = useState<ProceduralChunk[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editing, setEditing] = useState<ProceduralChunk | null>(null);
    const [creating, setCreating] = useState(false);

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

    const onArchive = useCallback(
        async (chunk: ProceduralChunk) => {
            const isArchived = chunk.appliesTo === 'archived';
            // Archive is DB-only (classify → 'archived' | 'universal'). The
            // file stays on disk so a sync/miner rewrite doesn't clobber the
            // user's intent. Reclassify works on every source — openclaw and
            // mined chunks can be archived too without touching their files.
            const next: AppliesTo = isArchived ? 'universal' : 'archived';
            setBusyId(chunk.id);
            setChunks((prev) =>
                prev.map((c) =>
                    c.id === chunk.id ? { ...c, appliesTo: next, classifiedBy: 'user' } : c
                )
            );
            try {
                await classifyProceduralChunk(chunk.id, next);
                void getProceduralStats().then(setStats).catch(() => {});
            } catch (err) {
                setError((err as Error).message);
                void load();
            } finally {
                setBusyId(null);
            }
        },
        [load]
    );

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
        // Default "all" hides archived to keep the playbook view focused on
        // live rules; the dedicated 'archived' tab surfaces them on demand.
        const rows =
            filter === 'all'
                ? chunks.filter((c) => c.appliesTo !== 'archived')
                : chunks.filter((c) => c.appliesTo === filter);
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
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => setCreating(true)}
                            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
                        >
                            <Plus className="h-3.5 w-3.5" /> New rule
                        </button>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
                        >
                            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
                        </button>
                    </div>
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
                    {(['all', 'universal', 'openclaw-only', 'archived'] as Filter[]).map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => setFilter(f)}
                            className={cn(
                                'rounded-full px-3 py-1 text-xs',
                                filter === f ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted'
                            )}
                        >
                            {f === 'all'
                                ? 'All'
                                : f === 'universal'
                                  ? 'Visible to AI'
                                  : f === 'openclaw-only'
                                    ? 'Hidden'
                                    : 'Archived'}
                        </button>
                    ))}
                </div>
            </div>

            {creating ? (
                <RuleDialog
                    mode="create"
                    onClose={() => setCreating(false)}
                    onSaved={() => {
                        setCreating(false);
                        void load();
                    }}
                />
            ) : null}
            {editing ? (
                <RuleDialog
                    mode="edit"
                    chunk={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void load();
                    }}
                />
            ) : null}

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
                                            onEdit={c.source === 'user' ? () => setEditing(c) : undefined}
                                            onArchive={() => void onArchive(c)}
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
    onEdit,
    onArchive,
}: {
    chunk: ProceduralChunk;
    busy: boolean;
    onReclassify: (chunk: ProceduralChunk, applies: AppliesTo) => void;
    onEdit?: () => void;
    onArchive?: () => void;
}) {
    const isArchived = chunk.appliesTo === 'archived';
    const isUniversal = chunk.appliesTo === 'universal';
    const score = chunk.reliabilityScore;
    return (
        <div
            className={cn(
                'rounded-md border p-2.5 text-sm',
                isArchived
                    ? 'border-border bg-muted/10 opacity-60'
                    : isUniversal
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-border bg-muted/30'
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
                    {onEdit ? (
                        <button
                            type="button"
                            title="Edit rule"
                            onClick={onEdit}
                            disabled={busy}
                            className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                        >
                            <Pencil className="h-3 w-3" />
                        </button>
                    ) : null}
                    {onArchive ? (
                        <button
                            type="button"
                            title={isArchived ? 'Unarchive (back to universal)' : 'Archive rule'}
                            onClick={onArchive}
                            disabled={busy}
                            className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                        >
                            {isArchived ? (
                                <ArchiveRestore className="h-3 w-3" />
                            ) : (
                                <Archive className="h-3 w-3" />
                            )}
                        </button>
                    ) : null}
                </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>{chunk.source}</span>
                <span>· {chunk.appliesTo}</span>
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

function RuleDialog({
    mode,
    chunk,
    onClose,
    onSaved,
}: {
    mode: 'create' | 'edit';
    chunk?: ProceduralChunk;
    onClose: () => void;
    onSaved: () => void;
}) {
    const initialBody = useMemo(() => {
        if (!chunk) return '';
        // Strip the leading "## title" line that lives in r.text — the title
        // is edited separately. Fall back to excerpt when text isn't sent.
        const raw = chunk.text ?? chunk.excerpt;
        return raw.replace(/^##\s+[^\n]+\n+/, '').trim();
    }, [chunk]);
    const [title, setTitle] = useState(chunk?.sectionTitle ?? '');
    const [body, setBody] = useState(initialBody);
    const [appliesTo, setAppliesTo] = useState<AppliesTo>(
        chunk?.appliesTo && USER_SETTABLE_APPLIES.includes(chunk.appliesTo)
            ? chunk.appliesTo
            : 'universal'
    );
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const submit = useCallback(async () => {
        if (!title.trim() || !body.trim()) {
            setErr('Title and body are required');
            return;
        }
        setSaving(true);
        setErr(null);
        try {
            if (mode === 'create') {
                await createProceduralChunk({ title: title.trim(), body: body.trim(), appliesTo });
            } else if (chunk) {
                await updateProceduralChunk(chunk.id, {
                    title: title.trim(),
                    body: body.trim(),
                    appliesTo,
                });
            }
            onSaved();
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setSaving(false);
        }
    }, [mode, chunk, title, body, appliesTo, onSaved]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-xl rounded-lg border bg-background shadow-lg">
                <div className="flex items-center justify-between border-b px-4 py-3">
                    <h2 className="text-sm font-semibold">
                        {mode === 'create' ? 'New playbook rule' : 'Edit playbook rule'}
                    </h2>
                    <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="space-y-3 p-4">
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Title
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. Communicating with clients"
                            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Rule body (markdown)
                        </label>
                        <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder="- I reply to clients on Upwork within ~4h\n- I track finances in Notion, not spreadsheets"
                            rows={8}
                            className="w-full resize-y rounded border bg-background px-2 py-1.5 font-mono text-xs"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Visibility
                        </label>
                        <div className="flex gap-1">
                            {USER_SETTABLE_APPLIES.map((a) => (
                                <button
                                    key={a}
                                    type="button"
                                    onClick={() => setAppliesTo(a)}
                                    className={cn(
                                        'rounded border px-2 py-1 text-xs',
                                        appliesTo === a
                                            ? 'bg-primary text-primary-foreground'
                                            : 'hover:bg-muted'
                                    )}
                                >
                                    {a}
                                </button>
                            ))}
                        </div>
                    </div>
                    {err ? <div className="text-xs text-rose-600">{err}</div> : null}
                </div>
                <div className="flex justify-end gap-2 border-t px-4 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={saving}
                        className="rounded border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={saving}
                        className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {mode === 'create' ? 'Create' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
