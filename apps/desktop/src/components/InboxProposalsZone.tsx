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

function ProposalCard({ summary, startExpanded, onResolved }: CardProps) {
    const [expanded, setExpanded] = useState(startExpanded);
    const [detail, setDetail] = useState<ProposalDetail | null>(null);
    const [busy, setBusy] = useState(false);
    const [comment, setComment] = useState('');
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

    const onApprove = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await approveProposal(summary.id);
            if (!result.ok) {
                setError(`${result.reason}: ${result.details ?? ''}`);
                return;
            }
            onResolved();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }, [summary.id, onResolved]);

    const onReject = useCallback(async () => {
        const reason = window.prompt('Reason (optional):') ?? undefined;
        setBusy(true);
        setError(null);
        try {
            await rejectProposal(summary.id, reason && reason.trim() ? reason.trim() : undefined);
            onResolved();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }, [summary.id, onResolved]);

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
                    <div className="font-medium">{title}</div>
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
                    onClick={onReject}
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
