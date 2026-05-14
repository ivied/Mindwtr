import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePersistedViewState } from './usePersistedViewState';

describe('usePersistedViewState', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('restores sanitized view state from local storage', () => {
        window.localStorage.setItem('mindwtr:test:view', JSON.stringify({ showArchived: true }));

        const { result } = renderHook(() => usePersistedViewState(
            'mindwtr:test:view',
            { showArchived: false },
            (value, fallback) => {
                const parsed = value && typeof value === 'object' && !Array.isArray(value)
                    ? value as { showArchived?: unknown }
                    : {};
                return {
                    showArchived: typeof parsed.showArchived === 'boolean'
                        ? parsed.showArchived
                        : fallback.showArchived,
                };
            }
        ));

        expect(result.current[0]).toEqual({ showArchived: true });
    });

    it('persists updates when view state changes', () => {
        const { result } = renderHook(() => usePersistedViewState(
            'mindwtr:test:view',
            { showArchived: false }
        ));

        act(() => {
            result.current[1]((current) => ({ ...current, showArchived: true }));
        });

        expect(JSON.parse(window.localStorage.getItem('mindwtr:test:view') || '{}')).toEqual({
            showArchived: true,
        });
    });
});
