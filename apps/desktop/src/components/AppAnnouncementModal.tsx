import { useEffect, useId, useRef } from 'react';
import { ExternalLink, Megaphone, MessageSquare, X } from 'lucide-react';

import type { AppAnnouncement, AppAnnouncementAction } from '@mindwtr/core';
import { ModalPortal } from './ModalPortal';
import { Button } from './ui/Button';

type AppAnnouncementModalProps = {
    announcement: AppAnnouncement | null;
    isOpen: boolean;
    onAction: (action: AppAnnouncementAction) => void;
    onDismiss: () => void;
    onShown?: () => void;
};

function getActionIcon(action: AppAnnouncementAction) {
    if (action.type === 'feedback') return <MessageSquare className="h-4 w-4" aria-hidden="true" />;
    return <ExternalLink className="h-4 w-4" aria-hidden="true" />;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
    if (!container) return [];
    return Array.from(
        container.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
    ).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}

export function AppAnnouncementModal({
    announcement,
    isOpen,
    onAction,
    onDismiss,
    onShown,
}: AppAnnouncementModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const primaryButtonRef = useRef<HTMLButtonElement>(null);
    const dismissButtonRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const bodyId = useId();

    useEffect(() => {
        if (!isOpen || !announcement) return;
        onShown?.();
        const timer = window.setTimeout(() => {
            (primaryButtonRef.current ?? dismissButtonRef.current)?.focus();
        }, 50);
        return () => window.clearTimeout(timer);
    }, [announcement, isOpen, onShown]);

    if (!isOpen || !announcement) return null;

    const action = announcement.action;
    const dismissLabel = announcement.dismissLabel ?? 'Not now';

    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-[18vh]"
            onClick={onDismiss}
        >
            <div
                ref={modalRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={bodyId}
                className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        onDismiss();
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = getFocusableElements(modalRef.current);
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }}
            >
                <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <Megaphone className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h3 id={titleId} className="text-base font-semibold leading-6">
                                {announcement.title}
                            </h3>
                            <p id={bodyId} className="mt-1 text-sm leading-6 text-muted-foreground">
                                {announcement.body}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Dismiss announcement"
                        onClick={onDismiss}
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="flex flex-wrap justify-end gap-2 px-4 py-3">
                    <Button ref={dismissButtonRef} variant="secondary" onClick={onDismiss}>
                        {dismissLabel}
                    </Button>
                    {action ? (
                        <Button
                            ref={primaryButtonRef}
                            leadingIcon={getActionIcon(action)}
                            onClick={() => onAction(action)}
                        >
                            {action.label}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
