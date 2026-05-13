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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Check, X, MessageSquare, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useTaskStore, type Task, type Project } from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
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
    const [rejectMode, setRejectMode] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [error, setError] = useState<string | null>(null);

    // For modify proposals: extract the diff field names so the user can
    // partially approve (uncheck a row to omit that field from apply).
    const modifyFieldNames = useMemo(() => {
        const p = summary.currentPayload as { kind?: string; diff?: { field?: unknown }[] } | null;
        if (!p || p.kind !== 'modify' || !Array.isArray(p.diff)) return null;
        return p.diff
            .map((d) => d?.field)
            .filter((f): f is string => typeof f === 'string' && f.length > 0);
    }, [summary.currentPayload]);

    // AI-routing badge — present when the proposal includes a diff that hands
    // this task off to the agent lane (assignedTo='@ai-agent'). We surface
    // it as a distinct visual element above the standard diff so the user
    // can see why the agent is being suggested before they decide.
    const routing = useMemo(() => extractRoutingInfo(summary), [summary]);

    const [selectedFields, setSelectedFields] = useState<Set<string>>(
        () => new Set(modifyFieldNames ?? [])
    );

    const totalFieldCount = modifyFieldNames?.length ?? 0;
    const selectedCount = selectedFields.size;
    const isPartial = totalFieldCount > 0 && selectedCount > 0 && selectedCount < totalFieldCount;
    const nothingSelected = totalFieldCount > 0 && selectedCount === 0;

    const toggleField = useCallback((field: string) => {
        setSelectedFields((prev) => {
            const next = new Set(prev);
            if (next.has(field)) next.delete(field);
            else next.add(field);
            return next;
        });
    }, []);

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
            if (nothingSelected) {
                setError('Select at least one field to approve');
                return;
            }
            setBusy(true);
            setError(null);
            try {
                const result = await approveProposal(
                    summary.id,
                    isPartial ? { includeFields: Array.from(selectedFields) } : {}
                );
                if (!result.ok) {
                    setError(`${result.reason}: ${result.details ?? ''}`);
                    return;
                }
                // Mirror the applied diff into the local task store so the
                // card updates immediately. Without this, ai-service has the
                // new state but the desktop store still shows the old values
                // until the next cloud-sync cycle.
                applyDiffToLocalStore(
                    summary,
                    isPartial ? selectedFields : null
                );
                // Split proposals create a real Project + N sub-action tasks
                // (and optionally delete the source). Mirror that locally and
                // show the user a toast — splits are a bigger change than a
                // field edit; without explicit feedback they look like the
                // proposal silently vanished.
                if (result.projectId) {
                    applySplitToLocalStore(summary, result);
                    notifySplitApplied(result);
                }
                onResolved();
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setBusy(false);
            }
        },
        [summary.id, isPartial, nothingSelected, selectedFields, onResolved]
    );

    const onRejectClick = useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setRejectMode(true);
        setExpanded(true);
        setError(null);
    }, []);

    const performReject = useCallback(
        async (
            reason: string | undefined,
            kind: 'rejected' | 'already-done' | 'not-applicable' = 'rejected'
        ) => {
            setBusy(true);
            setError(null);
            try {
                await rejectProposal(summary.id, reason, kind);
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
        () => performReject(rejectReason.trim() || undefined, 'rejected'),
        [performReject, rejectReason]
    );
    const onSkipReason = useCallback(() => performReject(undefined, 'rejected'), [performReject]);
    const onAlreadyDone = useCallback(
        async (event: React.MouseEvent) => {
            event.stopPropagation();
            // "I already did this" — AI was right, just overlapped with my
            // manual work. Goes to status='rejected' but audit meta marks it
            // as already-done so we can tell true positives from false ones.
            await performReject(undefined, 'already-done');
        },
        [performReject]
    );
    const onCancelReject = useCallback(() => {
        setRejectMode(false);
        setRejectReason('');
    }, []);

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
                    <span
                        className="ml-2 text-xs text-muted-foreground"
                        title={new Date(summary.createdAt).toLocaleString()}
                    >
                        · {formatRelativeTime(summary.createdAt)}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onApprove}
                    disabled={busy || nothingSelected}
                    title={
                        nothingSelected
                            ? 'Select at least one field'
                            : isPartial
                              ? `Approve ${selectedCount} of ${totalFieldCount} fields`
                              : 'Approve'
                    }
                    className="inline-flex items-center gap-0.5 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                    <Check className="h-3 w-3" />
                    {isPartial ? `Approve ${selectedCount}/${totalFieldCount}` : 'Approve'}
                </button>
                <button
                    type="button"
                    onClick={onAlreadyDone}
                    disabled={busy}
                    title="AI was right but you already did this. Marks the proposal resolved without applying the diff; audit trail keeps the 'already-done' signal so we know it was a true positive."
                    className="inline-flex items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/5 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-500/10 disabled:opacity-50 dark:text-sky-300"
                >
                    <Check className="h-3 w-3" /> Already done
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
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((v) => !v);
                    }}
                    className="rounded p-0.5 hover:bg-muted"
                    title={expanded ? 'Hide details' : 'Show details'}
                >
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
            </div>

            {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}

            {routing ? (
                <div className="mt-2 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
                    <span className="text-base leading-none">🤖</span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-200">
                            Route to AI agent
                            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                                {routing.taskType}
                            </span>
                        </div>
                        {routing.reasoning ? (
                            <div className="mt-0.5 break-words text-xs text-amber-700/80 dark:text-amber-200/80">
                                {routing.reasoning}
                            </div>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={onApprove}
                        disabled={busy || nothingSelected}
                        title="Accept all suggested changes including assignment to the AI agent"
                        className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-600 px-2 py-0.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                        <Check className="h-3 w-3" /> Accept → Route
                    </button>
                </div>
            ) : null}

            {expanded ? (
                <div className="mt-2 space-y-2 border-t pt-2">
                    <DiffPreview
                        payload={summary.currentPayload}
                        selectedFields={selectedFields}
                        onToggleField={toggleField}
                    />
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
                                placeholder="Optional (e.g. 'wrong target', 'mockup not real')"
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

interface DiffPreviewProps {
    payload: unknown;
    /** When provided, render a checkbox per modify-diff entry to allow partial approval. */
    selectedFields?: Set<string>;
    onToggleField?: (field: string) => void;
}

function DiffPreview({ payload, selectedFields, onToggleField }: DiffPreviewProps) {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as { kind?: string } & Record<string, unknown>;

    if (p.kind === 'modify') {
        const diff = (p.diff as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
        const checkable = Boolean(selectedFields && onToggleField);
        return (
            <div className="space-y-1">
                {diff.map((d, i) => {
                    const checked = selectedFields ? selectedFields.has(d.field) : true;
                    return (
                        <label
                            key={i}
                            className={`flex gap-2 rounded bg-background p-1.5 text-xs ${
                                checkable ? 'cursor-pointer hover:bg-background/70' : ''
                            } ${checkable && !checked ? 'opacity-50' : ''}`}
                        >
                            {checkable ? (
                                <input
                                    type="checkbox"
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-600"
                                    checked={checked}
                                    onChange={() => onToggleField!(d.field)}
                                />
                            ) : null}
                            <div className="min-w-0 flex-1">
                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {d.field}
                                </div>
                                <div className="break-words text-rose-600 line-through dark:text-rose-300">
                                    − {formatDiffValue(d.from)}
                                </div>
                                <div className="break-words text-emerald-600 dark:text-emerald-300">
                                    + {formatDiffValue(d.to)}
                                </div>
                            </div>
                        </label>
                    );
                })}
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

/**
 * After approve, propagate the diff into the local task store so the UI
 * reflects the new task fields immediately (otherwise the user has to wait
 * for the next cloud-sync cycle or reload the page).
 *
 * Only `modify` payloads are handled — `create/delete/split/merge/move` either
 * don't have a single targetTask, or change task identity in ways the cloud
 * sync is better equipped to resolve.
 */
function applyDiffToLocalStore(
    summary: ProposalSummary,
    selectedFields: Set<string> | null
): void {
    const payload = summary.currentPayload as { kind?: string; diff?: Array<{ field: string; to: unknown }>; taskId?: string } | null;
    if (!payload || payload.kind !== 'modify') return;
    const taskId = payload.taskId ?? summary.targetTaskIds[0];
    if (!taskId) return;

    const patch: Partial<Task> = {};
    for (const entry of payload.diff ?? []) {
        if (selectedFields && !selectedFields.has(entry.field)) continue;
        switch (entry.field) {
            case 'title':
                if (typeof entry.to === 'string') patch.title = entry.to;
                break;
            case 'description':
                if (typeof entry.to === 'string') patch.description = entry.to;
                break;
            case 'status':
                if (typeof entry.to === 'string')
                    patch.status = entry.to as Task['status'];
                break;
            case 'tags':
                if (Array.isArray(entry.to))
                    patch.tags = entry.to.filter((t): t is string => typeof t === 'string');
                break;
            case 'project':
                if (entry.to === null || typeof entry.to === 'string')
                    patch.projectId = (entry.to as string | null) ?? undefined;
                break;
            case 'assignedTo':
                if (entry.to === null || typeof entry.to === 'string')
                    patch.assignedTo = (entry.to as string | null) ?? undefined;
                break;
            // `metadata` field is internal to ai-service; not exposed on Task.
        }
    }
    if (Object.keys(patch).length === 0) return;
    try {
        void useTaskStore.getState().updateTask(taskId, patch);
    } catch (err) {
        console.warn('[proposals] local task patch failed:', err);
    }
}

/**
 * Render an ISO timestamp as a compact relative-time string ("2m ago",
 * "3h ago"). For >24h falls back to a short locale date. The exact instant
 * is preserved on the surrounding span's title attribute for hover.
 */
/**
 * After approve of a split proposal, mirror the cloud-side result into the
 * local store: inject the new Project, inject the sub-action tasks (linked
 * via projectId), and remove the source task when deleteSource=true. Without
 * this the user sees the source disappear and... nothing else, until the
 * next cloud sync.
 */
function applySplitToLocalStore(
    summary: ProposalSummary,
    result: { projectId?: string; projectTitle?: string; appliedTaskIds?: string[] }
): void {
    if (!result.projectId || !result.projectTitle) return;
    const payload = summary.currentPayload as
        | {
              kind?: string;
              sourceTaskId?: string;
              deleteSource?: boolean;
              resultTasks?: Array<{
                  title?: string;
                  status?: string;
                  tags?: string[];
                  description?: string;
                  metadata?: Record<string, unknown>;
              }>;
          }
        | null;
    if (!payload || payload.kind !== 'split' || !Array.isArray(payload.resultTasks)) return;

    const now = new Date().toISOString();
    const project: Project = {
        id: result.projectId,
        title: result.projectTitle,
        status: 'active',
        color: '#7c3aed',
        order: 0,
        tagIds: [],
        createdAt: now,
        updatedAt: now,
    };

    // resultTasks[0] is the umbrella → became the Project; rest are sub-actions.
    const subActionBlueprints = payload.resultTasks.slice(1);
    const subActionIds = result.appliedTaskIds ?? [];
    const newTasks: Task[] = subActionBlueprints.map((bp, i) => ({
        id: subActionIds[i] ?? `temp-${result.projectId}-${i}`,
        title: bp.title ?? '',
        status: (bp.status as Task['status']) ?? 'next',
        tags: Array.isArray(bp.tags) ? bp.tags.filter((x): x is string => typeof x === 'string') : [],
        contexts: [],
        description: typeof bp.description === 'string' ? bp.description : '',
        projectId: result.projectId,
        metadata: bp.metadata && typeof bp.metadata === 'object' ? bp.metadata : undefined,
        createdAt: now,
        updatedAt: now,
    }));

    useTaskStore.setState((state) => {
        const projectAlreadyThere = state._allProjects.some((p) => p.id === project.id);
        const projects = projectAlreadyThere ? state._allProjects : [...state._allProjects, project];

        const existingTaskIds = new Set(state._allTasks.map((t) => t.id));
        const dedupedNewTasks = newTasks.filter((t) => !existingTaskIds.has(t.id));
        const sourceId = payload.sourceTaskId;
        const tasksAfterSource = payload.deleteSource && sourceId
            ? state._allTasks.filter((t) => t.id !== sourceId)
            : state._allTasks;

        return {
            _allProjects: projects,
            _allTasks: [...tasksAfterSource, ...dedupedNewTasks],
            lastDataChangeAt: Date.now(),
        };
    });
}

/**
 * User-visible feedback after a split apply: "Created project X with N next
 * actions" with an "Open" action that switches the UI to the new project's
 * view. Without this, the inbox row vanishes and the project the user just
 * created stays buried in the sidebar.
 */
function notifySplitApplied(result: {
    projectId?: string;
    projectTitle?: string;
    appliedTaskIds?: string[];
}): void {
    if (!result.projectId || !result.projectTitle) return;
    const taskCount = result.appliedTaskIds?.length ?? 0;
    const message =
        taskCount > 0
            ? `Created project "${result.projectTitle}" with ${taskCount} next action${taskCount === 1 ? '' : 's'}`
            : `Created project "${result.projectTitle}"`;
    const projectId = result.projectId;
    useUiStore.getState().showToast(
        message,
        'success',
        6000,
        {
            label: 'Open',
            onClick: () => {
                useUiStore.getState().setProjectView({ selectedProjectId: projectId });
            },
        }
    );
}

/**
 * Detect the AI-routing intent in a proposal payload and surface what the
 * UI needs to render the dedicated routing badge:
 *   - taskType (e.g. "research", "draft") read from the `ai-type:<type>` tag
 *     the Enricher adds when is_ai_routable=true.
 *   - reasoning text read from traceback.reasoningSteps ("AI routing: …").
 *
 * Returns null when the proposal doesn't propose handing the task off to the
 * agent. Lives outside the React render path so its memoization key is just
 * the proposal summary.
 */
function extractRoutingInfo(
    summary: ProposalSummary
): { taskType: string; reasoning: string } | null {
    const p = summary.currentPayload as
        | {
              kind?: string;
              diff?: Array<{ field?: string; to?: unknown }>;
              traceback?: { reasoningSteps?: unknown };
          }
        | null;
    if (!p || p.kind !== 'modify' || !Array.isArray(p.diff)) return null;
    const assignedEntry = p.diff.find(
        (d) => d?.field === 'assignedTo' && (d?.to === '@ai-agent' || d?.to === 'ai-agent')
    );
    if (!assignedEntry) return null;

    let taskType = 'task';
    const tagsEntry = p.diff.find((d) => d?.field === 'tags');
    if (tagsEntry && Array.isArray((tagsEntry as { to?: unknown }).to)) {
        const tagsTo = (tagsEntry as { to: unknown[] }).to.filter(
            (t): t is string => typeof t === 'string'
        );
        const aiTypeTag = tagsTo.find((t) => t.startsWith('ai-type:'));
        if (aiTypeTag) taskType = aiTypeTag.slice('ai-type:'.length) || taskType;
    }

    let reasoning = '';
    const steps = Array.isArray(p.traceback?.reasoningSteps)
        ? (p.traceback!.reasoningSteps as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
    const routingLine = steps.find((s) => s.startsWith('AI routing:'));
    if (routingLine) {
        const dashIdx = routingLine.indexOf(' — ');
        reasoning =
            dashIdx >= 0
                ? routingLine.slice(dashIdx + 3).trim()
                : routingLine.replace(/^AI routing:\s*/, '').trim();
    }

    return { taskType, reasoning };
}

/**
 * Compact absolute date + time chip: "May 12, 14:35". Year is included
 * only when the suggestion is from a prior year. Per user preference:
 * relative "2m ago" was removed — absolute time is easier to anchor on
 * at a glance ("ах, эта Suggestion из вчерашнего разговора").
 */
function formatRelativeTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDiffValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        if (value.length === 0) return '(empty)';
        return value.map((v) => String(v)).join(', ');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    const s = String(value);
    return s === '' ? '(empty)' : s;
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
