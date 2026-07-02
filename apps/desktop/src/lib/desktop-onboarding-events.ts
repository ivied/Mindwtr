import type { SyncBackend } from '@mindwtr/core';

export const MINDWTR_DESKTOP_ONBOARDING_EVENT = 'mindwtr:desktop-onboarding';
const DESKTOP_ONBOARDING_HANDOFF_HINT_KEY_PREFIX = 'mindwtr:desktop:onboarding-handoff-hint:v1:';

export type DesktopOnboardingHandoffPage = 'sync' | 'data';

type DesktopFirstRunOnboardingState = {
    hasHydratedSettings: boolean;
    isLoading: boolean;
    dismissed: boolean;
    visibleDataCount: number;
    syncBackend: SyncBackend;
};

export function shouldOpenDesktopFirstRunOnboarding({
    hasHydratedSettings,
    isLoading,
    dismissed,
    visibleDataCount,
    syncBackend,
}: DesktopFirstRunOnboardingState): boolean {
    return hasHydratedSettings
        && !isLoading
        && !dismissed
        && visibleDataCount === 0
        && syncBackend === 'off';
}

export function dispatchDesktopOnboardingEvent(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(MINDWTR_DESKTOP_ONBOARDING_EVENT));
}

export function subscribeDesktopOnboardingEvent(handler: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const listener: EventListener = () => handler();
    window.addEventListener(MINDWTR_DESKTOP_ONBOARDING_EVENT, listener);
    return () => window.removeEventListener(MINDWTR_DESKTOP_ONBOARDING_EVENT, listener);
}

function getDesktopOnboardingHandoffHintKey(page: DesktopOnboardingHandoffPage): string {
    return `${DESKTOP_ONBOARDING_HANDOFF_HINT_KEY_PREFIX}${page}`;
}

export function isDesktopOnboardingHandoffHintDismissed(page: DesktopOnboardingHandoffPage): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(getDesktopOnboardingHandoffHintKey(page)) === 'dismissed';
    } catch {
        return false;
    }
}

export function dismissDesktopOnboardingHandoffHint(page: DesktopOnboardingHandoffPage): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(getDesktopOnboardingHandoffHintKey(page), 'dismissed');
    } catch {
        // Onboarding hints are convenience UI; storage failures should not block the settings page.
    }
}
