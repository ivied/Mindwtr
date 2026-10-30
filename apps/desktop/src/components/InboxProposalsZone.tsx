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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Sparkles,
    Check,
    CheckCheck,
    X,
    MessageSquare,
    ChevronDown,
    ChevronUp,
    Loader2,
    RefreshCw,
    Zap,
    Search,
    Pencil,
    VolumeX,
    Trash2,
} from 'lucide-react';
import { useTaskStore, type Task } from '@mindwtr/core';
import {
    isProposalsAvailable,
    listPendingProposals,
    getProposal,
    approveProposal,
    rejectProposal,
    commentOnProposal,
    startDoneAudit,
    getDoneAuditStatus,
    checkProposalDone,
    listMuteRules,
    deleteMuteRule,
    type DoneAuditStatus,
    type DoneCheckVerdict,
    type MuteRule,
    type ProposalSummary,
    type ProposalDetail,
} from '../lib/proposals-client';
import { SyncService } from '../lib/sync-service';

const POLL_INTERVAL_MS = 30_000;

export function InboxProposalsZone() {
    const available = isProposalsAvailable();

    const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [expandedId, setExpandedId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        const id = new URLSearchParams(window.location.search).get('id');
        return id && id.trim() ? id.trim() : null;
    });

    useEffect(() => {
        if (!available) return;
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
    }, [refreshKey, available]);

    const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    // On-demand "which of these look already done" sweep. The server judges
    // every pending card against captures recorded after it appeared and
    // posts the 🟡 nudge on done-verdicts; the list picks the badges up on
    // refresh. Replaces a cron: the user runs it right before processing.
    const [audit, setAudit] = useState<DoneAuditStatus | null>(null);
    const [auditBusy, setAuditBusy] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const onCheckDone = useCallback(async () => {
        setAuditBusy(true);
        try {
            await startDoneAudit();
            for (;;) {
                await new Promise((r) => setTimeout(r, 2000));
                const s = await getDoneAuditStatus();
                if (!mountedRef.current) return;
                setAudit(s);
                if (!s.running) break;
            }
            refresh();
        } catch (err) {
            if (mountedRef.current) setError((err as Error).message);
        } finally {
            if (mountedRef.current) setAuditBusy(false);
        }
    }, [refresh]);

    // --- Keyboard triage ---
    // j/k (or arrows) move focus between cards; single keys fire the focused
    // card's actions via the API each card registers on mount. Ignored while
    // typing in any input/textarea so the reject-reason and comment fields
    // keep normal typing.
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const cardApis = useRef(new Map<string, ProposalCardApi>());
    const sortedIdsRef = useRef<string[]>([]);
    const registerCardApi = useCallback((id: string, api: ProposalCardApi | null) => {
        if (api) cardApis.current.set(id, api);
        else cardApis.current.delete(id);
    }, []);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const target = e.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable)
            ) {
                return;
            }
            const ids = sortedIdsRef.current;
            if (ids.length === 0) return;
            const key = e.key.toLowerCase();
            if (key === 'j' || key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const dir = key === 'j' || e.key === 'ArrowDown' ? 1 : -1;
                setFocusedId((prev) => {
                    const idx = prev ? ids.indexOf(prev) : -1;
                    const next = idx < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.min(Math.max(idx + dir, 0), ids.length - 1);
                    return ids[next] ?? null;
                });
                return;
            }
            if (!focusedId) return;
            const api = cardApis.current.get(focusedId);
            if (!api) return;
            const actions: Record<string, (() => void) | undefined> = {
                a: api.approve,
                q: api.didIt,
                d: api.alreadyDone,
                c: api.check,
                e: api.edit,
                x: api.reject,
                m: api.mute,
                ' ': api.toggleExpand,
            };
            const action = actions[key === ' ' ? ' ' : key];
            if (action) {
                e.preventDefault();
                action();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [focusedId]);

    // --- Mute rules footer ("не предлагай такое" management) ---
    const [muteRules, setMuteRules] = useState<MuteRule[] | null>(null);
    const [muteRulesOpen, setMuteRulesOpen] = useState(false);
    useEffect(() => {
        if (!muteRulesOpen) return;
        let cancelled = false;
        listMuteRules()
            .then((items) => {
                if (!cancelled) setMuteRules(items);
            })
            .catch(() => {
                if (!cancelled) setMuteRules([]);
            });
        return () => {
            cancelled = true;
        };
    }, [muteRulesOpen, refreshKey]);

    if (!available) return null;

    // Quiet when nothing to show — zero visual footprint.
    if (proposals !== null && proposals.length === 0 && !error) return null;

    return (
        <div className="mx-3 my-4 rounded-lg border border-violet-500/30 bg-violet-500/5">
            <header className="flex items-center justify-between border-b border-violet-500/20 px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
                    <Sparkles className="h-4 w-4" />
                    AI suggestions {proposals ? `(${proposals.length})` : ''}
                </div>
                <div className="flex items-center gap-1.5">
                    {audit ? (
                        <span className="text-[10px] text-muted-foreground">
                            {audit.running
                                ? `checking ${audit.processed}/${audit.total}…`
                                : `${audit.done} look done · ${audit.flagged} newly flagged`}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        onClick={onCheckDone}
                        disabled={auditBusy}
                        className="inline-flex items-center gap-1 rounded border border-yellow-500/40 bg-yellow-500/5 px-1.5 py-0.5 text-[11px] text-yellow-700 hover:bg-yellow-500/10 disabled:opacity-50 dark:text-yellow-300"
                        title="Check every pending suggestion against captures recorded after it appeared; ones that look already done get a 🟡 badge"
                    >
                        {auditBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <CheckCheck className="h-3 w-3" />
                        )}
                        Check done
                    </button>
                    <button
                        type="button"
                        onClick={refresh}
                        className="rounded p-1 text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
                        title="Refresh"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                </div>
            </header>

            {error ? (
                <div className="p-3 text-xs text-destructive">{error}</div>
            ) : !proposals ? (
                <div className="flex items-center justify-center p-4 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                </div>
            ) : (
                <div className="divide-y divide-violet-500/15">
                    {/* Flagged-as-done cards float to the top — they take one click to clear. Sort is stable, so the rest keep server order (newest first). */}
                    {(() => {
                        const sorted = [...proposals].sort(
                            (a, b) => Number(b.doneFlagged ?? false) - Number(a.doneFlagged ?? false)
                        );
                        sortedIdsRef.current = sorted.map((p) => p.id);
                        return sorted.map((p) => (
                            <ProposalCard
                                key={p.id}
                                summary={p}
                                startExpanded={expandedId === p.id}
                                focused={focusedId === p.id}
                                onFocus={() => setFocusedId(p.id)}
                                registerApi={registerCardApi}
                                onResolved={() => {
                                    if (expandedId === p.id) setExpandedId(null);
                                    refresh();
                                }}
                            />
                        ));
                    })()}
                </div>
            )}

            <footer className="border-t border-violet-500/20 px-3 py-1.5">
                <button
                    type="button"
                    onClick={() => setMuteRulesOpen((v) => !v)}
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    title='Rules created via "не предлагай такое" — matching future suggestions are silently skipped'
                >
                    <VolumeX className="h-3 w-3" />
                    Muted rules{muteRules ? ` (${muteRules.length})` : ''}
                    {muteRulesOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {muteRulesOpen ? (
                    muteRules === null ? (
                        <div className="py-1 text-[10px] text-muted-foreground">Loading…</div>
                    ) : muteRules.length === 0 ? (
                        <div className="py-1 text-[10px] text-muted-foreground">
                            No rules — reject a card via ✗ ▾ → "Не предлагай такое" to add one.
                        </div>
                    ) : (
                        <ul className="mt-1 space-y-0.5">
                            {muteRules.map((r) => (
                                <li key={r.id} className="flex items-center gap-2 text-[10px]">
                                    <span className="truncate">
                                        {r.sampleTitle}
                                        {r.sourceChannel ? (
                                            <span className="text-muted-foreground"> · {r.sourceChannel}</span>
                                        ) : null}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void deleteMuteRule(r.id).then(() =>
                                                setMuteRules((prev) => prev?.filter((x) => x.id !== r.id) ?? prev)
                                            );
                                        }}
                                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                                        title="Delete rule"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}
            </footer>
        </div>
    );
}

/** Imperative actions a card exposes for the zone-level keyboard triage. */
interface ProposalCardApi {
    approve: () => void;
    didIt: () => void;
    alreadyDone: () => void;
    check: () => void;
    edit: () => void;
    reject: () => void;
    mute: () => void;
    toggleExpand: () => void;
}

interface CardProps {
    summary: ProposalSummary;
    startExpanded: boolean;
    /** Keyboard-triage focus (j/k) — highlighted ring, action keys target this card. */
    focused: boolean;
    onFocus: () => void;
    registerApi: (id: string, api: ProposalCardApi | null) => void;
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

function ProposalCard({ summary, startExpanded, focused, onFocus, registerApi, onResolved }: CardProps) {
    const [expanded, setExpanded] = useState(startExpanded);
    const [detail, setDetail] = useState<ProposalDetail | null>(null);
    const [busy, setBusy] = useState(false);
    const [comment, setComment] = useState('');
    const [rejectMode, setRejectMode] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    // ✏️ edit-then-approve
    const [editMode, setEditMode] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    // 🔍 per-card done-check
    const [checking, setChecking] = useState(false);
    const [checkVerdict, setCheckVerdict] = useState<DoneCheckVerdict | null>(null);
    const [checkHintMode, setCheckHintMode] = useState(false);
    const [checkHint, setCheckHint] = useState('');
    // ✗ split-button dropdown + instant-reject undo window
    const [xMenuOpen, setXMenuOpen] = useState(false);
    const [pendingReject, setPendingReject] = useState(false);
    const rejectTimerRef = useRef<number | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        return () => {
            if (rejectTimerRef.current !== null) window.clearTimeout(rejectTimerRef.current);
        };
    }, []);

    useEffect(() => {
        if (focused && rootRef.current) {
            rootRef.current.scrollIntoView({ block: 'nearest' });
        }
    }, [focused]);

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
    // `||`, not `??`: an empty-string title is the case that actually happens
    // (LLM returned nothing) and it must still render the fallback, not a
    // blank header row.
    const title = payload?.task?.title?.trim() || '(no title)';
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

    const onApproveWith = useCallback(
        async (overrides?: { status?: 'done'; title?: string }) => {
            setBusy(true);
            setError(null);
            try {
                const result = await approveProposal(summary.id, overrides ? { overrides } : {});
                if (!result.ok) {
                    setError(`${result.reason}: ${result.details ?? ''}`);
                    return;
                }
                // Apply created the Mindwtr task in cloud. Two things need to
                // happen in the local store for the user to actually see it in
                // their inbox:
                //   1) Inject the task directly with the cloud-returned id so the
                //      web (non-Tauri) store, which has no continuous cloud-sync,
                //      doesn't lag behind.
                //   2) Best-effort SyncService.performSync() so that in Tauri /
                //      properly-synced contexts the rest of the cloud state
                //      (other concurrent edits) also lands.
                const appliedTaskIds = result.appliedTaskIds ?? [];
                injectCreatedTaskLocally(summary, appliedTaskIds, overrides);
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
                setEditMode(false);
            }
        },
        [summary.id, onResolved, summary]
    );

    const onApprove = useCallback(() => void onApproveWith(), [onApproveWith]);
    // ⚡ "Сделал" — did it just now thanks to the card: create the task
    // already completed so it lands in the done log, not the inbox.
    const onDidIt = useCallback(() => void onApproveWith({ status: 'done' }), [onApproveWith]);

    const onRejectWithReasonClick = useCallback(() => {
        // Open the inline reject form inside the card; actual reject happens
        // when the user confirms via the form below. Native window.prompt
        // looked alien against Mindwtr's styled UI.
        setXMenuOpen(false);
        setRejectMode(true);
        setExpanded(true);
        setError(null);
    }, []);

    const performReject = useCallback(
        async (
            reason: string | undefined,
            kind: 'rejected' | 'already-done' | 'not-applicable' = 'rejected',
            options: { mute?: boolean } = {}
        ) => {
            setBusy(true);
            setError(null);
            try {
                await rejectProposal(summary.id, reason, kind, options);
                onResolved();
            } catch (err) {
                setError((err as Error).message);
                setPendingReject(false);
            } finally {
                setBusy(false);
                setRejectMode(false);
                setRejectReason('');
            }
        },
        [summary.id, onResolved]
    );

    // ✗ body click — instant reject with a 5s undo window: the card collapses
    // to an "Отменить" row and the actual API call fires when the timer runs
    // out. Undo just cancels the timer; nothing was sent yet.
    const onInstantReject = useCallback(() => {
        setXMenuOpen(false);
        setPendingReject(true);
        rejectTimerRef.current = window.setTimeout(() => {
            rejectTimerRef.current = null;
            void performReject(undefined, 'rejected');
        }, 5000);
    }, [performReject]);

    const onUndoReject = useCallback(() => {
        if (rejectTimerRef.current !== null) {
            window.clearTimeout(rejectTimerRef.current);
            rejectTimerRef.current = null;
        }
        setPendingReject(false);
    }, []);

    // 🔇 "Не предлагай такое" — reject + mute rule so similar proposals are skipped.
    const onMute = useCallback(() => {
        setXMenuOpen(false);
        void performReject(undefined, 'rejected', { mute: true });
    }, [performReject]);

    const onConfirmReject = useCallback(
        () => performReject(rejectReason.trim() || undefined, 'rejected'),
        [performReject, rejectReason]
    );
    const onSkipReason = useCallback(() => performReject(undefined, 'rejected'), [performReject]);
    const onAlreadyDone = useCallback(
        async () => performReject(undefined, 'already-done'),
        [performReject]
    );
    const onCancelReject = useCallback(() => {
        setRejectMode(false);
        setRejectReason('');
    }, []);

    // 🔍 per-card "did I already do this?" check (optionally with a user hint).
    const onCheck = useCallback(
        async (hint?: string) => {
            setChecking(true);
            setCheckVerdict(null);
            setCheckHintMode(false);
            setError(null);
            try {
                const verdict = await checkProposalDone(summary.id, hint);
                setCheckVerdict(verdict);
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setChecking(false);
            }
        },
        [summary.id]
    );

    const onEditClick = useCallback(() => {
        setEditTitle((summary.currentPayload as { task?: { title?: string } })?.task?.title ?? '');
        setEditMode(true);
    }, [summary.currentPayload]);

    // Register keyboard-triage API for the zone-level j/k handler.
    useEffect(() => {
        registerApi(summary.id, {
            approve: onApprove,
            didIt: onDidIt,
            alreadyDone: () => void onAlreadyDone(),
            check: () => void onCheck(),
            edit: onEditClick,
            reject: onInstantReject,
            mute: onMute,
            toggleExpand: () => setExpanded((v) => !v),
        });
        return () => registerApi(summary.id, null);
    }, [summary.id, registerApi, onApprove, onDidIt, onAlreadyDone, onCheck, onEditClick, onInstantReject, onMute]);

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

    if (pendingReject) {
        return (
            <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                <span className="truncate">
                    Rejected: <span className="line-through">{title}</span>
                </span>
                <button
                    type="button"
                    onClick={onUndoReject}
                    className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-muted"
                >
                    Отменить
                </button>
            </div>
        );
    }

    return (
        <div
            ref={rootRef}
            onClick={onFocus}
            className={`px-3 py-2 text-sm ${focused ? 'bg-violet-500/10 ring-1 ring-inset ring-violet-500/50' : ''}`}
        >
            <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-medium">
                        {editMode ? (
                            <span className="flex min-w-0 flex-1 items-center gap-1">
                                <input
                                    autoFocus
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    disabled={busy}
                                    className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && editTitle.trim()) {
                                            e.preventDefault();
                                            void onApproveWith({ title: editTitle.trim() });
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            setEditMode(false);
                                        }
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => void onApproveWith({ title: editTitle.trim() })}
                                    disabled={busy || !editTitle.trim()}
                                    title="Approve with the edited title (Enter)"
                                    className="shrink-0 rounded bg-emerald-600 p-1 text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                    <Check className="h-3 w-3" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setEditMode(false)}
                                    disabled={busy}
                                    title="Cancel (Esc)"
                                    className="shrink-0 rounded border border-border p-1 hover:bg-muted"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ) : (
                            <span className="truncate">{title}</span>
                        )}
                        {summary.doneFlagged ? (
                            <span
                                className="shrink-0 rounded-full bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:text-yellow-300"
                                title="AI saw evidence this is already done — expand the card for the quote, then 'Done' closes it"
                            >
                                🟡 looks done
                            </span>
                        ) : null}
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
                        <span
                            className="ml-1 normal-case tracking-normal"
                            title={new Date(summary.createdAt).toLocaleString()}
                        >
                            · {formatRelativeTime(summary.createdAt)}
                        </span>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onApprove}
                    disabled={busy}
                    title="Create the task in your inbox (a)"
                    className="inline-flex items-center gap-0.5 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                    <Check className="h-3 w-3" /> Approve
                </button>
                <button
                    type="button"
                    onClick={onDidIt}
                    disabled={busy}
                    title="Сделал прямо сейчас: approve + record the task as completed (q)"
                    className="inline-flex items-center gap-0.5 rounded bg-teal-600 px-2 py-0.5 text-xs text-white hover:bg-teal-700 disabled:opacity-50"
                >
                    <Zap className="h-3 w-3" /> Сделал
                </button>
                <button
                    type="button"
                    onClick={onAlreadyDone}
                    disabled={busy}
                    title="Уже было сделано раньше / неактуально — resolves without creating a task; audit keeps the 'already-done' signal (d)"
                    className="inline-flex items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/5 px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-500/10 disabled:opacity-50 dark:text-sky-300"
                >
                    <CheckCheck className="h-3 w-3" /> Done
                </button>
                <span className="inline-flex">
                    <button
                        type="button"
                        onClick={() => void onCheck()}
                        disabled={busy || checking}
                        title="Проверь сам: judge captures recorded after this card — did I already do it? (c)"
                        className="inline-flex items-center gap-0.5 rounded-l border border-yellow-500/40 bg-yellow-500/5 px-2 py-0.5 text-xs text-yellow-700 hover:bg-yellow-500/10 disabled:opacity-50 dark:text-yellow-300"
                    >
                        {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                        Проверь
                    </button>
                    <button
                        type="button"
                        onClick={() => setCheckHintMode((v) => !v)}
                        disabled={busy || checking}
                        title="Проверить с подсказкой — скажи, где/как смотреть"
                        className="inline-flex items-center rounded-r border border-l-0 border-yellow-500/40 bg-yellow-500/5 px-0.5 py-0.5 text-yellow-700 hover:bg-yellow-500/10 disabled:opacity-50 dark:text-yellow-300"
                    >
                        <ChevronDown className="h-3 w-3" />
                    </button>
                </span>
                <button
                    type="button"
                    onClick={onEditClick}
                    disabled={busy || editMode}
                    title="Поправить заголовок и сразу approve (e)"
                    className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                    <Pencil className="h-3 w-3" />
                </button>
                <span className="relative inline-flex">
                    <button
                        type="button"
                        onClick={onInstantReject}
                        disabled={busy}
                        title="Reject сразу, без диалога — 5 секунд на «Отменить» (x)"
                        className="inline-flex items-center rounded-l border border-border px-1.5 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                        <X className="h-3 w-3" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setXMenuOpen((v) => !v)}
                        disabled={busy}
                        title="Ещё варианты reject"
                        className="inline-flex items-center rounded-r border border-l-0 border-border px-0.5 py-0.5 hover:bg-muted disabled:opacity-50"
                    >
                        <ChevronDown className="h-3 w-3" />
                    </button>
                    {xMenuOpen ? (
                        <span className="absolute right-0 top-full z-10 mt-1 w-48 rounded border border-border bg-background py-1 shadow-md">
                            <button
                                type="button"
                                onClick={onRejectWithReasonClick}
                                className="block w-full px-2 py-1 text-left text-xs hover:bg-muted"
                            >
                                Reject с причиной…
                            </button>
                            <button
                                type="button"
                                onClick={onMute}
                                title="Reject + правило: похожие предложения из этого канала больше не создаются (m)"
                                className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-muted"
                            >
                                <VolumeX className="h-3 w-3" /> Не предлагай такое
                            </button>
                        </span>
                    ) : null}
                </span>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="rounded p-0.5 hover:bg-muted"
                    title={expanded ? 'Collapse (space)' : 'Expand (space)'}
                >
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
            </div>

            {error ? <div className="ml-5 mt-1 text-xs text-destructive">{error}</div> : null}

            {checkHintMode ? (
                <div className="ml-5 mt-1.5 flex items-center gap-1">
                    <input
                        autoFocus
                        value={checkHint}
                        onChange={(e) => setCheckHint(e.target.value)}
                        disabled={checking}
                        placeholder="Подскажи, где смотреть — «оплатил через сайт час назад»"
                        className="flex-1 rounded border bg-background px-2 py-1 text-xs"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && checkHint.trim()) {
                                e.preventDefault();
                                void onCheck(checkHint.trim());
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setCheckHintMode(false);
                            }
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => void onCheck(checkHint.trim() || undefined)}
                        disabled={checking}
                        className="shrink-0 rounded border border-yellow-500/40 bg-yellow-500/5 px-2 py-1 text-xs text-yellow-700 hover:bg-yellow-500/10 disabled:opacity-50 dark:text-yellow-300"
                    >
                        Проверить
                    </button>
                </div>
            ) : null}

            {checkVerdict ? (
                <div
                    className={`ml-5 mt-1.5 rounded border p-2 text-xs ${
                        checkVerdict.verdict === 'done'
                            ? 'border-emerald-500/40 bg-emerald-500/5'
                            : 'border-border bg-muted/30'
                    }`}
                >
                    {checkVerdict.verdict === 'done' ? (
                        <>
                            <div className="font-medium text-emerald-700 dark:text-emerald-300">
                                🟢 Похоже сделано ({(checkVerdict.confidence * 100).toFixed(0)}%)
                                {checkVerdict.evidence ? (
                                    <span className="font-normal"> — «{checkVerdict.evidence}»</span>
                                ) : null}
                            </div>
                            {checkVerdict.reasoning ? (
                                <div className="mt-0.5 text-muted-foreground">{checkVerdict.reasoning}</div>
                            ) : null}
                            <div className="mt-1 flex gap-1">
                                <button
                                    type="button"
                                    onClick={onAlreadyDone}
                                    disabled={busy}
                                    className="rounded bg-sky-600 px-2 py-0.5 text-white hover:bg-sky-700 disabled:opacity-50"
                                >
                                    <CheckCheck className="mr-0.5 inline h-3 w-3" /> Done
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setCheckVerdict(null)}
                                    disabled={busy}
                                    className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
                                >
                                    Нет, оставить
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="text-muted-foreground">
                            {checkVerdict.verdict === 'no-evidence'
                                ? '⚪ Свидетельств не нашёл — в captures после карточки по этой теме пусто.'
                                : checkVerdict.verdict === 'not_done'
                                  ? `⭕ Похоже ещё НЕ сделано${checkVerdict.reasoning ? ` — ${checkVerdict.reasoning}` : ''}`
                                  : `❔ Неясно${checkVerdict.reasoning ? ` — ${checkVerdict.reasoning}` : ''}`}
                            <button
                                type="button"
                                onClick={() => setCheckVerdict(null)}
                                className="ml-2 rounded border border-border px-1.5 py-0 hover:bg-muted"
                            >
                                ok
                            </button>
                        </div>
                    )}
                </div>
            ) : null}

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

/**
 * Inject the just-applied create proposal as a task into useTaskStore so
 * the inbox re-renders with the new card immediately. In the Tauri
 * desktop this is redundant (auto-sync would catch the cloud-side
 * createTask within seconds) but in the web build there is no continuous
 * cloud-sync — without this the user does not see the card until they
 * reload the page.
 *
 * Uses the cloud-returned task id so we don't duplicate on the next
 * bootstrap from cloud.
 */
function injectCreatedTaskLocally(
    summary: ProposalSummary,
    appliedTaskIds: string[],
    overrides?: { status?: 'done'; title?: string }
): void {
    if (appliedTaskIds.length === 0) return;
    const payload = summary.currentPayload as
        | {
              kind?: string;
              task?: {
                  title?: string;
                  status?: string;
                  tags?: string[];
                  description?: string;
                  metadata?: Record<string, unknown>;
              };
          }
        | null;
    if (!payload || payload.kind !== 'create' || !payload.task) return;
    const id = appliedTaskIds[0]!;
    const t = payload.task;
    const now = new Date().toISOString();
    const status = (overrides?.status ?? t.status ?? 'inbox') as Task['status'];
    const task: Task = {
        id,
        title: overrides?.title ?? t.title ?? '',
        status,
        tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
        contexts: [],
        description: typeof t.description === 'string' ? t.description : '',
        metadata: t.metadata && typeof t.metadata === 'object' ? t.metadata : undefined,
        createdAt: now,
        updatedAt: now,
        // Mirrors cloud behavior: status done/archived gets completedAt stamped.
        ...(status === 'done' ? { completedAt: now } : {}),
    };
    useTaskStore.setState((state) => {
        // Guard against double-injection (e.g. if sync raced ahead and the
        // task is already in _allTasks).
        if (state._allTasks.some((existing) => existing.id === id)) return state;
        return {
            _allTasks: [...state._allTasks, task],
            lastDataChangeAt: Date.now(),
        };
    });
}

/**
 * ISO timestamp → compact absolute date+time chip ("May 12, 14:35").
 * Year is included only when the suggestion is from a prior year.
 * Mirrors the helper in TaskProposalsInline; small enough that duplicating
 * keeps the component self-contained without an extra shared util file.
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
