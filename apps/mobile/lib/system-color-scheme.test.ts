import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockAppearanceGetColorScheme,
    mockNativeAppearanceGetColorScheme,
} = vi.hoisted(() => ({
    mockAppearanceGetColorScheme: vi.fn(),
    mockNativeAppearanceGetColorScheme: vi.fn(),
}));

vi.mock('react-native', () => ({
    Appearance: {
        getColorScheme: mockAppearanceGetColorScheme,
    },
    NativeModules: {
        Appearance: {
            getColorScheme: mockNativeAppearanceGetColorScheme,
        },
    },
}));

import { getSystemColorSchemeForWidget } from './system-color-scheme';

describe('system-color-scheme', () => {
    beforeEach(() => {
        mockAppearanceGetColorScheme.mockReset();
        mockNativeAppearanceGetColorScheme.mockReset();
    });

    it('prefers native appearance scheme to avoid JS cache staleness', () => {
        mockNativeAppearanceGetColorScheme.mockReturnValue('dark');
        mockAppearanceGetColorScheme.mockReturnValue('light');

        expect(getSystemColorSchemeForWidget()).toBe('dark');
    });

    it('falls back to Appearance when native module returns unspecified', () => {
        mockNativeAppearanceGetColorScheme.mockReturnValue('unspecified');
        mockAppearanceGetColorScheme.mockReturnValue('light');

        expect(getSystemColorSchemeForWidget()).toBe('light');
    });

    it('returns undefined when neither source has light/dark scheme', () => {
        mockNativeAppearanceGetColorScheme.mockReturnValue(null);
        mockAppearanceGetColorScheme.mockReturnValue(null);

        expect(getSystemColorSchemeForWidget()).toBeUndefined();
    });
});
