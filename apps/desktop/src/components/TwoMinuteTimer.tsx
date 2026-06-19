import { useCallback, useEffect, useRef, useState } from 'react';
import { BellOff, Pause, Play, RotateCcw } from 'lucide-react';
import { tFallback } from '@mindwtr/core';

import { cn } from '../lib/utils';

const TIMER_SECONDS = 120;
const ALARM_BEEP_INTERVAL_MS = 800;

type TwoMinuteTimerProps = {
    t: (key: string) => string;
    resetKey: string;
};

function emitBeep(ctx: AudioContext): void {
    const start = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(880, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.3);
}

function formatRemaining(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function TwoMinuteTimer({ t, resetKey }: TwoMinuteTimerProps) {
    const [remaining, setRemaining] = useState(TIMER_SECONDS);
    const [isRunning, setIsRunning] = useState(false);
    const [isAlarming, setIsAlarming] = useState(false);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const alarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);

    const clearTimer = useCallback(() => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    }, []);

    const stopAlarm = useCallback(() => {
        if (alarmIntervalRef.current !== null) {
            clearInterval(alarmIntervalRef.current);
            alarmIntervalRef.current = null;
        }
        if (audioCtxRef.current !== null) {
            void audioCtxRef.current.close();
            audioCtxRef.current = null;
        }
        setIsAlarming(false);
    }, []);

    const startAlarm = useCallback(() => {
        const AudioContextCtor = window.AudioContext
            ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) return;
        const ctx = new AudioContextCtor();
        audioCtxRef.current = ctx;
        setIsAlarming(true);
        emitBeep(ctx);
        alarmIntervalRef.current = setInterval(() => emitBeep(ctx), ALARM_BEEP_INTERVAL_MS);
    }, []);

    useEffect(() => {
        clearTimer();
        stopAlarm();
        setIsRunning(false);
        setRemaining(TIMER_SECONDS);
    }, [resetKey, clearTimer, stopAlarm]);

    useEffect(() => () => {
        clearTimer();
        stopAlarm();
    }, [clearTimer, stopAlarm]);

    const start = useCallback(() => {
        if (isRunning) return;
        setIsRunning(true);
        intervalRef.current = setInterval(() => {
            setRemaining((prev) => {
                if (prev <= 1) {
                    clearTimer();
                    setIsRunning(false);
                    startAlarm();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [isRunning, clearTimer, startAlarm]);

    const pause = useCallback(() => {
        clearTimer();
        setIsRunning(false);
    }, [clearTimer]);

    const reset = useCallback(() => {
        clearTimer();
        stopAlarm();
        setIsRunning(false);
        setRemaining(TIMER_SECONDS);
    }, [clearTimer, stopAlarm]);

    const isFinished = remaining === 0;
    const startLabel = tFallback(t, 'process.timerStart', 'Start 2-min timer');
    const pauseLabel = tFallback(t, 'process.timerPause', 'Pause timer');
    const resetLabel = tFallback(t, 'process.timerReset', 'Reset timer');
    const stopAlarmLabel = tFallback(t, 'process.timerStopAlarm', 'Stop alarm');

    return (
        <div className="inline-flex items-center gap-1.5">
            <span
                className={cn(
                    'tabular-nums text-xs font-semibold min-w-[2.75rem] text-center rounded-md px-1.5 py-0.5',
                    isFinished
                        ? 'text-destructive bg-destructive/10 animate-pulse'
                        : isRunning
                            ? 'text-primary bg-primary/10'
                            : 'text-muted-foreground bg-muted/40'
                )}
            >
                {formatRemaining(remaining)}
            </span>
            {isAlarming ? (
                <button
                    type="button"
                    onClick={stopAlarm}
                    aria-label={stopAlarmLabel}
                    title={stopAlarmLabel}
                    className="text-destructive hover:text-destructive/80 transition-colors"
                >
                    <BellOff className="w-3.5 h-3.5" />
                </button>
            ) : (
                <>
                    {isRunning ? (
                        <button
                            type="button"
                            onClick={pause}
                            aria-label={pauseLabel}
                            title={pauseLabel}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <Pause className="w-3.5 h-3.5" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={start}
                            disabled={isFinished}
                            aria-label={startLabel}
                            title={startLabel}
                            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                        >
                            <Play className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={reset}
                        aria-label={resetLabel}
                        title={resetLabel}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                </>
            )}
        </div>
    );
}
