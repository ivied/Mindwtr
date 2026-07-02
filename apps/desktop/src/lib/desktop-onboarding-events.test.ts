import { beforeEach, describe, expect, it } from 'vitest';
import {
    dismissDesktopOnboardingHandoffHint,
    isDesktopOnboardingHandoffHintDismissed,
    shouldOpenDesktopFirstRunOnboarding,
} from './desktop-onboarding-events';

describe('desktop onboarding events', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('opens automatically on a fresh install with empty local data and sync off', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 0,
            syncBackend: 'off',
        })).toBe(true);
    });

    it('does not reopen after the user dismisses it', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: true,
            visibleDataCount: 0,
            syncBackend: 'off',
        })).toBe(false);
    });

    it('does not interrupt existing data or configured sync', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 1,
            syncBackend: 'off',
        })).toBe(false);

        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 0,
            syncBackend: 'webdav',
        })).toBe(false);
    });

    it('stores onboarding handoff hint dismissals per page in local storage', () => {
        expect(isDesktopOnboardingHandoffHintDismissed('sync')).toBe(false);
        expect(isDesktopOnboardingHandoffHintDismissed('data')).toBe(false);

        dismissDesktopOnboardingHandoffHint('sync');

        expect(isDesktopOnboardingHandoffHintDismissed('sync')).toBe(true);
        expect(isDesktopOnboardingHandoffHintDismissed('data')).toBe(false);
    });
});
