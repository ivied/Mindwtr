import { Database, Download, RefreshCw, X } from 'lucide-react';
import { ModalPortal } from './ModalPortal';

type DesktopOnboardingFlowProps = {
    isOpen: boolean;
    busy?: boolean;
    error?: string | null;
    onOpenSync: () => void;
    onOpenImport: () => void;
    onStartFresh: () => void;
    onSkip: () => void;
};

export function DesktopOnboardingFlow({
    isOpen,
    busy = false,
    error = null,
    onOpenSync,
    onOpenImport,
    onStartFresh,
    onSkip,
}: DesktopOnboardingFlowProps) {
    if (!isOpen) return null;

    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-6 py-8"
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-onboarding-title"
        >
            <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
                <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
                    <div className="min-w-0">
                        <h2 id="desktop-onboarding-title" className="text-xl font-semibold tracking-tight">
                            Welcome to Mindwtr
                        </h2>
                        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                            Start with your existing data, or create a small Getting Started project to learn the loop.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onSkip}
                        disabled={busy}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Skip onboarding"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="grid gap-3 p-6">
                    <button
                        type="button"
                        onClick={onOpenSync}
                        disabled={busy}
                        className="group flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <RefreshCw className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-foreground">Set up sync</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                                Connect Dropbox, WebDAV, CloudKit, or a local sync folder before adding starter data.
                            </span>
                        </span>
                    </button>

                    <button
                        type="button"
                        onClick={onOpenImport}
                        disabled={busy}
                        className="group flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Download className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-foreground">Import tasks</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                                Bring in a Todoist, OmniFocus, DGT, or Mindwtr backup file first.
                            </span>
                        </span>
                    </button>

                    <button
                        type="button"
                        onClick={onStartFresh}
                        disabled={busy}
                        className="group flex items-center gap-4 rounded-lg border border-primary/40 bg-primary px-4 py-4 text-left text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                            <Database className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">
                                {busy ? 'Starting...' : 'Start fresh'}
                            </span>
                            <span className="mt-0.5 block text-xs text-primary-foreground/80">
                                Add a guided Getting Started project and two sample inbox items.
                            </span>
                        </span>
                    </button>
                    {error ? (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {error}
                        </div>
                    ) : null}
                </div>

                <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/20 px-6 py-4">
                    <p className="text-xs text-muted-foreground">
                        You can change sync and import settings later.
                    </p>
                    <button
                        type="button"
                        onClick={onSkip}
                        disabled={busy}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Skip for now
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
