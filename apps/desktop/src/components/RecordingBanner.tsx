/**
 * RecordingBanner — global, top-of-app indicator for an active recording
 * session. Polls /v1/recordings/active every 5s. While a session is live,
 * shows a pulsing banner with elapsed time + Stop button. Hidden otherwise.
 *
 * Decoupled from task views: mounts once at the app root, so the user always
 * sees recording state regardless of where they navigate.
 */

import { useCallback, useEffect, useState } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import {
    isRecordingAvailable,
    getActiveRecording,
    stopRecording,
    type RecordingSession,
} from '../lib/recording-client';

const POLL_INTERVAL_MS = 5000;

export function RecordingBanner() {
    const available = isRecordingAvailable();
    const [session, setSession] = useState<RecordingSession | null>(null);
    const [stopping, setStopping] = useState(false);
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
            await stopRecording(session.id);
            setSession(null);
        } catch {
            // Leave banner — user can retry.
        } finally {
            setStopping(false);
        }
    }, [session]);

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

function formatElapsed(ms: number): string {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
