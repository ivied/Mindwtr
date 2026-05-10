/**
 * Icon-only sidebar button that triggers safeReload (asset cache wipe + SW
 * unregister + sync flush + reload). Shows a spinner while in flight; toast
 * updates surface progress so the user sees what's happening before the
 * page actually reloads.
 */

import { useCallback, useState } from 'react';
import { RotateCw, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { safeReload } from '../lib/safe-reload';

type ToastVariant = 'info' | 'success' | 'error';

interface Props {
    isCollapsed: boolean;
    showToast?: (message: string, variant?: ToastVariant, durationMs?: number) => void;
}

export function SafeReloadButton({ isCollapsed, showToast }: Props) {
    const [busy, setBusy] = useState(false);

    const onClick = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            await safeReload({
                onProgress: (step) => {
                    if (showToast) showToast(step, 'info', 2_000);
                },
            });
        } catch (err) {
            if (showToast) showToast(`Reload failed: ${(err as Error).message}`, 'error', 5_000);
            setBusy(false);
        }
        // Note: on success the page reloads, so we don't reset busy.
    }, [busy, showToast]);

    const Icon = busy ? Loader2 : RotateCw;

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={busy}
            className={cn(
                'rounded-md border border-border bg-muted/40 text-muted-foreground hover:bg-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                'h-9 inline-flex items-center justify-center disabled:opacity-60',
                isCollapsed ? 'w-9' : 'w-9 shrink-0'
            )}
            title="Reload UI — picks up the latest build without losing local data"
            aria-label="Reload UI"
        >
            <Icon className={cn('h-4 w-4', busy && 'animate-spin')} />
        </button>
    );
}
