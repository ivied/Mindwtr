/**
 * Inbox AI Proposals zone — appears at the BOTTOM of the inbox view.
 *
 * Lists pending `type=create` proposals (proposals to add a new task to the
 * inbox). Each one is a self-contained card with diff/excerpt + approve/
 * reject/comment controls, styled distinctly (violet border) so it doesn't
 * blend with real tasks. The user reviews them when they want to, separate
 * from their primary inbox flow.
 *
 * Modify / delete / move / merge / split proposals don't live here — they
 * surface inline on their target task card (TaskProposalsInline component).
 *
 * Silent when AI Service is not configured or there are no pending create
 * proposals. URL `?id=<proposal_id>` auto-expands the matching card.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Sparkles, Check, X, MessageSquare, ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react';
import {
    isProposalsAvailable,
    listPendingProposals,
    getProposal,
    approveProposal,
    rejectProposal,
    commentOnProposal,
    type ProposalSummary,
    type ProposalDetail,
} from '../lib/proposals-client';
import { SyncService } from '../lib/sync-service';

const POLL_INTERVAL_MS = 30_000;

export function InboxProposalsZone() {
    if (!isProposalsAvailable()) return null;

    const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [expandedId, setExpandedId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        const id = new URLSearchParams(window.location.search).get('id');
        return id && id.trim() ? id.trim() : null;
    });

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                // Only `type=create` here — modify/etc render on their target task.
                const items = await listPendingProposals({ type: 'create', limit: 50 });
                if (!cancelled) {
                    setProposals(items);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) setError((err as Error).message);
            }
        };
        load();
        const t = window.setInterval(load, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(t);
        };
    }, [refreshKey]);

    const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    // Quiet when nothing to show — zero visual footprint.
    if (proposals !== null && proposals.length === 0 && !error) return null;

    return (
        <div className="mx-3 my-4 rounded-lg border border-violet-500/30 bg-violet-500/5">
            <header className="flex items-center justify-between border-b border-violet-500/20 px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
                    <Sparkles className="h-4 w-4" />
                    AI suggestions {proposals ? `(${proposals.length})` : ''}
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    className="rounded p-1 text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
                    title="Refresh"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                </button>
            </header>

            {error ? (
                <div className="p-3 text-xs text-destructive">{error}</div>
            ) : !proposals ? (
                <div className="flex items-center justify-center p-4 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                </div>
            ) : (
                <div className="divide-y divide-violet-500/15">
                    {proposals.map((p) => (
                        <ProposalCard
                            key={p.id}
                            summary={p}
                            startExpanded={expandedId === p.id}
                            onResolved={() => {
                                if (expandedId === p.id) setExpandedId(null);
                                refresh();
                            }}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface CardProps {
    summary: ProposalSummary;
    startExpanded: boolean;
    onResolved: () => void;
}

/** Highlight the evidence quote inside the excerpt by wrapping it in `>>>` / `<<<`. */
function renderExcerpt(excerpt: string, quote: string): ReactNode {
    if (!quote) return excerpt;
    // Try direct, then case-insensitive, then whitespace-relaxed.
    let idx = excerpt.indexOf(quote);
    if (idx < 0) idx = excerpt.toLowerCase().indexOf(quote.toLowerCase());
    if (idx < 0) {
        const norm = excerpt.replace(/\s+/g, ' ').toLowerCase();
        const ni = norm.indexOf(quote.replace(/\s+/g, ' ').toLowerCase().trim());
        if (ni < 0) return excerpt;
        // Roughly map back — fall back to plain text when normalized index drifts.
        idx = ni;
    }
    const len = quote.length;
    if (idx < 0 || idx > excerpt.length) return excerpt;
    return (
        <>
            {excerpt.slice(0, idx)}
            <mark className="rounded bg-violet-500/30 px-0.5 text-violet-900 dark:text-violet-100">
                {excerpt.slice(idx, idx + len)}
            </mark>
            {excerpt.slice(idx + len)}
        </>
    );
}

function SuggestedCategoryBadge({
    category,
}: {
    category: 'waiting' | 'someday' | 'reference' | 'two_minute' | 'next';
}) {
    const styles: Record<string, string> = {
        waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        someday: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
        reference: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
        two_minute: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        next: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    };
    const label: Record<string, string> = {
        waiting: '→ waiting',
        someday: '→ someday',
        reference: '→ reference',
        two_minute: '→ 2-min',
        next: '→ next',
    };
    return (
        <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${styles[category] ?? ''}`}
            title={`AI suggests this should land in ${category} after processing`}
        >
            {label[category]}
        </span>
    );
}

function PersonBadge({ slug, name }: { slug: string; name: string }) {
    // Canonical slug → tighter pill (the person is in the wiki registry).
    // Literal name fallback → muted style so the user can spot "AI saw a new
    // person, capture-wiki rollup will canonicalize next pass".
    const isCanonical = slug.length > 0;
    const label = isCanonical ? `@${slug}` : name;
    return (
        <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                isCanonical
                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    : 'bg-amber-500/5 text-amber-700/80 italic dark:text-amber-300/80'
            }`}
            title={
                isCanonical
                    ? `Waiting on ${name} (canonical wiki entry: ${slug})`
                    : `Waiting on ${name} — not in wiki yet; will be canonicalized after the next rollup`
            }
        >
            {label}
        </span>
    );
}

function ProposalCard({ summary, startExpanded, onResolved }: CardProps) {
    const [expanded, setExpanded] = useState(startExpanded);
    const [detail, setDetail] = useState<ProposalDetail | null>(null);
    const [busy, setBusy] = useState(false);
    const [comment, setComment] = useState('');
    const [rejectMode, setRejectMode] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!expanded) return;
        let cancelled = false;
        getProposal(summary.id)
            .then((d) => {
                if (!cancelled) setDetail(d);
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message);
            });
        return () => {
            cancelled = true;
        };
    }, [expanded, summary.id]);

    const payload = summary.currentPayload as {
        kind?: string;
        task?: { title?: string; description?: string; metadata?: Record<string, unknown> };
        traceback?: {
            captureExcerpt?: string;
            sourceChannel?: string;
            evidenceQuote?: string;
            cuesDetected?: string[];
            reasoningSteps?: string[];
        };
    } & Record<string, unknown>;
    const title = payload?.task?.title ?? '(no title)';
    const sourceChannel = payload?.traceback?.sourceChannel ?? '';
    const evidenceQuote = payload?.traceback?.evidenceQuote ?? '';
    const cues = payload?.traceback?.cuesDetected ?? [];
    const steps = payload?.traceback?.reasoningSteps ?? [];
    const confidence = payload?.task?.metadata?.ai_confidence;
    const oneLineReason = payload?.task?.metadata?.ai_reasoning;
    const suggestedCategory = payload?.task?.metadata?.ai_suggested_category as
        | 'next'
        | 'waiting'
        | 'someday'
        | 'reference'
        | 'two_minute'
        | undefined;
    const whoTo = (payload?.task?.metadata?.ai_who_to as string | undefined) ?? '';
    const whoToSlug = (payload?.task?.metadata?.ai_who_to_slug as string | undefined) ?? '';

    const onApprove = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await approveProposal(summary.id);
            if (!result.ok) {
                setError(`${result.reason}: ${result.details ?? ''}`);
                return;
            }
            // Apply created the Mindwtr task in cloud — kick a local sync so the
            // inbox list above this zone picks it up without waiting for the
            // periodic sync interval. Best-effort: if cloud sync fails the
            // task will still arrive on the next cycle.
            try {
                await SyncService.performSync();
            } catch (syncErr) {
                console.warn('[proposals] post-approve sync failed:', (syncErr as Error).message);
            }
            onResolved();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }, [summary.id, onResolved]);

    const onRejectClick = useCallback(() => {
        // Open the inline reject form inside the card; actual reject happens
        // when the user confirms via the form below. Native window.prompt
        // looked alien against Mindwtr's styled UI.
        setRejectMode(true);
        setExpanded(true);
        setError(null);
    }, []);

    const performReject = useCallback(
        async (reason: string | undefined) => {
            setBusy(true);
            setError(null);
            try {
                await rejectProposal(summary.id, reason);
                onResolved();
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setBusy(false);
                setRejectMode(false);
                setRejectReason('');
            }
        },
        [summary.id, onResolved]
    );

    const onConfirmReject = useCallback(
        () => performReject(rejectReason.trim() || undefined),
        [performReject, rejectReason]
    );
    const onSkipReason = useCallback(() => performReject(undefined), [performReject]);
    const onCancelReject = useCallback(() => {
        setRejectMode(false);
        setRejectReason('');
    }, []);

    const onSendComment = useCallback(async () => {
        const text = comment.trim();
        if (!text) return;
        setBusy(true);
        setError(null);
        try {
            const result = await commentOnProposal(summary.id, text);
            if (result.proposal) setDetail(result.proposal);
            setComment('');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }, [summary.id, comment]);

    return (
        <div className="px-3 py-2 text-sm">
            <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{title}</span>
                        {suggestedCategory && suggestedCategory !== 'next' ? (
                            <SuggestedCategoryBadge category={suggestedCategory} />
                        ) : null}
                        {suggestedCategory === 'waiting' && (whoToSlug || whoTo) ? (
                            <PersonBadge slug={whoToSlug} name={whoTo} />
                        ) : null}
                    </div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {summary.sourceAgent} {sourceChannel ? `· ${sourceChannel}` : ''}
                        {summary.currentVersion > 1 ? ` · v${summary.currentVersion}` : ''}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onApprove}
                    disabled={busy}
                    className="inline-flex items-center gap-0.5 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                    <Check className="h-3 w-3" /> Approve
                </button>
                <button
                    type="button"
                    onClick={onRejectClick}
                    disabled={busy}
                    className="inline-flex items-center gap-0.5 rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                    <X className="h-3 w-3" /> Reject
                </button>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="rounded p-0.5 hover:bg-muted"
                    title={expanded ? 'Collapse' : 'Expand'}
                >
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
            </div>

            {error ? <div className="ml-5 mt-1 text-xs text-destructive">{error}</div> : null}

            {expanded ? (
                <div className="ml-5 mt-2 space-y-2 border-t border-violet-500/20 pt-2">
                    {rejectMode ? (
                        <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2">
                            <div className="mb-1 text-xs font-medium text-rose-700 dark:text-rose-300">
                                Why doesn't this fit?
                            </div>
                            <textarea
                                autoFocus
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                rows={2}
                                placeholder="Optional — helps the agent learn (e.g. 'wrong recipient', 'mockup not real')"
                                className="w-full resize-none rounded border bg-background px-2 py-1 text-xs"
                                disabled={busy}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        if (!busy) onConfirmReject();
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        onCancelReject();
                                    }
                                }}
                            />
                            <div className="mt-1 flex justify-end gap-1">
                                <button
                                    type="button"
                                    onClick={onCancelReject}
                                    disabled={busy}
                                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={onSkipReason}
                                    disabled={busy}
                                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                                >
                                    Reject without reason
                                </button>
                                <button
                                    type="button"
                                    onClick={onConfirmReject}
                                    disabled={busy || !rejectReason.trim()}
                                    className="rounded bg-rose-600 px-2 py-0.5 text-xs text-white hover:bg-rose-700 disabled:opacity-50"
                                >
                                    Reject with reason
                                </button>
                            </div>
                        </div>
                    ) : null}
                    {!detail ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                        </div>
                    ) : (
                        <>
                            {oneLineReason ? (
                                <div className="text-xs italic text-muted-foreground">
                                    {String(oneLineReason)}
                                </div>
                            ) : null}
                            {payload?.task?.description ? (
                                <div className="text-xs">{payload.task.description}</div>
                            ) : null}
                            {steps.length > 0 ? (
                                <details className="text-xs" open>
                                    <summary className="cursor-pointer font-medium text-violet-700 dark:text-violet-300">
                                        Why AI thought this is actionable
                                        {typeof confidence === 'number' ? (
                                            <span className="ml-1 text-muted-foreground">
                                                · conf {(confidence * 100).toFixed(0)}%
                                            </span>
                                        ) : null}
                                    </summary>
                                    <ol className="ml-4 mt-1 list-decimal space-y-0.5">
                                        {steps.map((s, i) => (
                                            <li key={i}>{s}</li>
                                        ))}
                                    </ol>
                                    {cues.length > 0 ? (
                                        <div className="mt-1.5 flex flex-wrap gap-1">
                                            {cues.map((c, i) => (
                                                <span
                                                    key={i}
                                                    className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700 dark:text-violet-300"
                                                >
                                                    {c}
                                                </span>
                                            ))}
                                        </div>
                                    ) : null}
                                </details>
                            ) : null}
                            {payload?.traceback?.captureExcerpt ? (
                                <details className="text-xs">
                                    <summary className="cursor-pointer text-muted-foreground">
                                        Source excerpt
                                        {evidenceQuote ? ' (centered on cue)' : ''}
                                    </summary>
                                    <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background p-1.5 text-[10px]">
                                        {renderExcerpt(payload.traceback.captureExcerpt, evidenceQuote)}
                                    </pre>
                                </details>
                            ) : null}
                            {detail.messages.length > 0 ? (
                                <div className="space-y-1">
                                    {detail.messages.map((m) => (
                                        <div
                                            key={m.id}
                                            className={`rounded px-2 py-1 text-xs ${
                                                m.role === 'user' ? 'bg-blue-500/10' : 'bg-muted'
                                            }`}
                                        >
                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                {m.role}
                                            </span>{' '}
                                            <span className="whitespace-pre-wrap">{m.text}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            <div className="flex items-end gap-1">
                                <textarea
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value)}
                                    rows={2}
                                    placeholder="Refine via comment (e.g. 'change recipient to Bob')"
                                    className="flex-1 resize-none rounded border bg-background px-2 py-1 text-xs"
                                    disabled={busy}
                                />
                                <button
                                    type="button"
                                    onClick={onSendComment}
                                    disabled={busy || !comment.trim()}
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                >
                                    <MessageSquare className="h-3 w-3" /> Send
                                </button>
                            </div>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}
