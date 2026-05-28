/**
 * RecordingBanner — global, top-of-app indicator for an active recording
 * session. Polls /v1/recordings/active every 5s. While a session is live,
 * shows a pulsing banner with elapsed time + Stop button. Hidden otherwise.
 *
 * Decoupled from task views: mounts once at the app root, so the user always
 * sees recording state regardless of where they navigate.
 */

import { useCallback, useEffect, useState } from 'react';
import { Mic, Square, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { cn } from '../lib/utils';
import {
    isRecordingAvailable,
    getActiveRecording,
    stopRecording,
    findRecording,
    type RecordingSession,
} from '../lib/recording-client';

const POLL_INTERVAL_MS = 5000;

interface PostStopState {
    session: RecordingSession;
    pollAttempts: number;
}

export function RecordingBanner({ onNavigatePlaybook }: { onNavigatePlaybook?: () => void } = {}) {
    const available = isRecordingAvailable();
    const [session, setSession] = useState<RecordingSession | null>(null);
    const [stopping, setStopping] = useState(false);
    const [postStop, setPostStop] = useState<PostStopState | null>(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!available) return;
        let cancelled = false;
        const tick = async () => {
            try {
                const s = await getActiveRecording();
                if (!cancelled) setSession(s);
            } catch {
                // Silent — banner just stays in its current state.
            }
        };
        void tick();
        const id = setInterval(tick, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [available]);

    // Tick `now` every second so the elapsed counter updates in real time
    // without re-fetching from the server.
    useEffect(() => {
        if (!session) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [session]);

    const onStop = useCallback(async () => {
        if (!session) return;
        setStopping(true);
        try {
            const stopped = await stopRecording(session.id);
            setSession(null);
            setPostStop({ session: stopped, pollAttempts: 0 });
        } catch {
            // Leave banner — user can retry.
        } finally {
            setStopping(false);
        }
    }, [session]);

    // Poll the just-stopped session every 3s until distillation reaches a
    // terminal status (done/failed/skipped) or we time out at ~3 minutes.
    useEffect(() => {
        if (!postStop) return;
        const id = setInterval(async () => {
            try {
                const fresh = await findRecording(postStop.session.id);
                if (!fresh) return;
                const terminal =
                    fresh.distillationStatus === 'done' ||
                    fresh.distillationStatus === 'failed' ||
                    fresh.distillationStatus === 'skipped';
                setPostStop((prev) =>
                    prev ? { session: fresh, pollAttempts: prev.pollAttempts + 1 } : null
                );
                if (terminal || postStop.pollAttempts > 60) {
                    clearInterval(id);
                }
            } catch {
                // Silent — next tick will retry.
            }
        }, 3000);
        return () => clearInterval(id);
    }, [postStop]);

    // Auto-dismiss post-stop chip 20s after a terminal state.
    useEffect(() => {
        if (!postStop) return;
        const status = postStop.session.distillationStatus;
        if (status !== 'done' && status !== 'failed' && status !== 'skipped') return;
        const t = setTimeout(() => setPostStop(null), 20_000);
        return () => clearTimeout(t);
    }, [postStop]);

    // Active session takes priority over the post-stop chip.
    if (!session && postStop) {
        return <PostStopChip state={postStop} onClose={() => setPostStop(null)} onOpen={onNavigatePlaybook} />;
    }
    if (!session) return null;

    const elapsedMs = now - Date.parse(session.startedAt);
    const elapsed = formatElapsed(elapsedMs);
    const taskLabel = session.taskTitle || session.taskId;

    return (
        <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm">
            <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                </span>
                <Mic className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
                <span className="truncate">
                    <span className="font-medium">Recording</span>{' '}
                    <span className="text-muted-foreground">·</span>{' '}
                    <span className="truncate">{taskLabel}</span>{' '}
                    <span className="text-muted-foreground">· {elapsed}</span>
                </span>
            </div>
            <button
                type="button"
                onClick={() => void onStop()}
                disabled={stopping}
                className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded border border-rose-500/50 bg-background px-2 py-1 text-xs font-medium hover:bg-rose-500/10 disabled:opacity-50'
                )}
            >
                {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                Stop
            </button>
        </div>
    );
}

function PostStopChip({
    state,
    onClose,
    onOpen,
}: {
    state: PostStopState;
    onClose: () => void;
    onOpen?: () => void;
}) {
    const status = state.session.distillationStatus;
    const label = state.session.taskTitle || state.session.taskId;
    const isRunning = status === 'pending' || status === 'running';
    const isDone = status === 'done';
    const isFailed = status === 'failed' || status === 'skipped';
    return (
        <div
            className={cn(
                'sticky top-0 z-40 flex items-center justify-between gap-3 border-b px-4 py-2 text-sm',
                isRunning && 'border-amber-500/40 bg-amber-500/10',
                isDone && 'border-emerald-500/40 bg-emerald-500/10',
                isFailed && 'border-slate-500/40 bg-slate-500/10'
            )}
        >
            <div className="flex items-center gap-2 min-w-0">
                {isRunning ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
                ) : isDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-slate-600 dark:text-slate-400" />
                )}
                <span className="truncate">
                    {isRunning ? (
                        <>
                            <span className="font-medium">Distilling recording…</span>{' '}
                            <span className="text-muted-foreground">· {label}</span>
                        </>
                    ) : isDone ? (
                        <>
                            <span className="font-medium">Playbook ready</span>{' '}
                            <span className="text-muted-foreground">· {label}</span>
                        </>
                    ) : (
                        <>
                            <span className="font-medium">Distillation {status}</span>{' '}
                            <span className="text-muted-foreground">· {label}</span>
                            {state.session.distillationError ? (
                                <span className="text-muted-foreground"> · {state.session.distillationError}</span>
                            ) : null}
                        </>
                    )}
                </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {isDone && onOpen ? (
                    <button
                        type="button"
                        onClick={onOpen}
                        className="rounded border border-emerald-500/50 bg-background px-2 py-1 text-xs font-medium hover:bg-emerald-500/10"
                    >
                        Open Playbook
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={onClose}
                    title="Dismiss"
                    className="rounded p-1 hover:bg-muted"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

function formatElapsed(ms: number): string {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
