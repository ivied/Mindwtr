/**
 * Inline AI-proposals panel for a task card.
 *
 * Shows pending proposals targeting this task, with a compact diff preview,
 * Approve / Reject buttons, and an expandable thread for back-and-forth with
 * the agent. Replaces the older "badge → navigate" flow when the proposal
 * actually targets an existing task; new-task proposals remain on the
 * central Proposals view.
 *
 * Silent when AI Service is not configured or no pending proposals exist.
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Check, X, MessageSquare, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
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

interface Props {
    taskId: string;
}

export function TaskProposalsInline({ taskId }: Props) {
    if (!isProposalsAvailable()) return null;

    const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const items = await listPendingProposals({ targetTaskId: taskId });
                if (!cancelled) setProposals(items);
            } catch {
                // Silent — best-effort.
            }
        };
        load();
        const t = window.setInterval(load, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(t);
        };
    }, [taskId, refreshKey]);

    if (!proposals || proposals.length === 0) return null;

    const refresh = () => setRefreshKey((k) => k + 1);

    return (
        <div className="my-1 space-y-1">
            {proposals.map((p) => (
                <ProposalCard key={p.id} summary={p} onResolved={refresh} />
            ))}
        </div>
    );
}

interface CardProps {
    summary: ProposalSummary;
    onResolved: () => void;
}

function ProposalCard({ summary, onResolved }: CardProps) {
    const [expanded, setExpanded] = useState(false);
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

    const onApprove = useCallback(
        async (event: React.MouseEvent) => {
            event.stopPropagation();
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
        },
        [summary.id, onResolved]
    );

    const onReject = useCallback(
        async (event: React.MouseEvent) => {
            event.stopPropagation();
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
        },
        [summary.id, onResolved]
    );

    const onSendComment = useCallback(
        async (event: React.MouseEvent) => {
            event.stopPropagation();
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
        },
        [summary.id, comment]
    );

    return (
        <div
            className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-sm"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
                <div className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{labelFor(summary)}</span>
                    {summary.currentVersion > 1 ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                            v{summary.currentVersion}
                        </span>
                    ) : null}
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
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((v) => !v);
                    }}
                    className="rounded p-0.5 hover:bg-muted"
                    title={expanded ? 'Collapse' : 'Expand'}
                >
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
            </div>

            {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}

            {expanded ? (
                <div className="mt-2 space-y-2 border-t pt-2">
                    {!detail ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                        </div>
                    ) : (
                        <>
                            <DiffPreview payload={detail.currentPayload} />
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
                                    placeholder="Refine: e.g. 'change recipient to Bob'"
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

function DiffPreview({ payload }: { payload: unknown }) {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as { kind?: string } & Record<string, unknown>;

    if (p.kind === 'modify') {
        const diff = (p.diff as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
        return (
            <div className="space-y-1">
                {diff.map((d, i) => (
                    <div key={i} className="rounded bg-background p-1.5 text-xs">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {d.field}
                        </div>
                        <div className="text-rose-600 line-through dark:text-rose-300">
                            − {String(d.from ?? '')}
                        </div>
                        <div className="text-emerald-600 dark:text-emerald-300">
                            + {String(d.to ?? '')}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (p.kind === 'delete') {
        const reason = (p.reason as string) ?? '';
        return (
            <div className="text-xs text-rose-700 dark:text-rose-300">
                Delete this task{reason ? ` — ${reason}` : ''}
            </div>
        );
    }

    if (p.kind === 'move') {
        return (
            <div className="text-xs">
                Move to project:{' '}
                <code className="rounded bg-muted px-1">{String(p.toProject ?? '(none)')}</code>
            </div>
        );
    }

    if (p.kind === 'split') {
        const result = (p.resultTasks as Array<{ title: string }>) ?? [];
        return (
            <div className="text-xs">
                <div>Split into {result.length} parts:</div>
                <ul className="ml-4 list-disc">
                    {result.map((r, i) => (
                        <li key={i}>{r.title}</li>
                    ))}
                </ul>
            </div>
        );
    }

    if (p.kind === 'merge') {
        const sources = (p.sourceTaskIds as string[]) ?? [];
        return (
            <div className="text-xs">Merge with {sources.length - 1} other task(s) into one</div>
        );
    }

    // create or unknown kind — show the JSON.
    return (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-background p-1.5 text-[10px]">
            {JSON.stringify(payload, null, 2)}
        </pre>
    );
}

function labelFor(p: ProposalSummary): string {
    const payload = p.currentPayload as { kind?: string } & Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return 'AI suggestion';
    switch (payload.kind) {
        case 'modify': {
            const diff = (payload.diff as { field: string }[]) ?? [];
            const fields = diff.map((d) => d.field).join(', ');
            return `AI suggests: edit ${fields || 'fields'}`;
        }
        case 'delete':
            return 'AI suggests: delete this task';
        case 'move':
            return `AI suggests: move to ${String(payload.toProject ?? 'a project')}`;
        case 'split':
            return 'AI suggests: split into parts';
        case 'merge':
            return 'AI suggests: merge with another task';
        default:
            return 'AI suggestion';
    }
}
