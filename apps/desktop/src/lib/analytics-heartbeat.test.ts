import { describe, expect, it } from 'vitest';

import { resolveDesktopAnalyticsVersion } from './analytics-heartbeat';

describe('resolveDesktopAnalyticsVersion', () => {
    it('uses the RC tag suffix when it matches the app base version', () => {
        expect(resolveDesktopAnalyticsVersion('1.0.5', 'v1.0.5-rc.1')).toBe('1.0.5-rc.1');
    });

    it('keeps the app version when the configured release tag does not match', () => {
        expect(resolveDesktopAnalyticsVersion('1.0.5', 'v1.0.6-rc.1')).toBe('1.0.5');
    });

    it('keeps the app version without a configured release tag', () => {
        expect(resolveDesktopAnalyticsVersion('1.0.5', '')).toBe('1.0.5');
    });
});
