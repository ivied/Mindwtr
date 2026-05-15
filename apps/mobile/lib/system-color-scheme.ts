import { Appearance, NativeModules } from 'react-native';

type WidgetColorScheme = 'light' | 'dark';

type NativeAppearanceModule = {
    getColorScheme?: () => 'light' | 'dark' | 'unspecified' | null | undefined;
};

const normalizeColorScheme = (value: unknown): WidgetColorScheme | undefined => {
    if (value === 'light' || value === 'dark') return value;
    return undefined;
};

export const getSystemColorSchemeForWidget = (): WidgetColorScheme | undefined => {
    try {
        // Appearance.getColorScheme() is JS-cached and can become stale in headless tasks.
        // Read the native module directly first so widget renders match current system mode.
        const nativeAppearance = (NativeModules.Appearance as NativeAppearanceModule | undefined) ?? undefined;
        const nativeScheme = normalizeColorScheme(nativeAppearance?.getColorScheme?.());
        if (nativeScheme) return nativeScheme;
    } catch {
        // Fall through to Appearance fallback below.
    }

    try {
        return normalizeColorScheme(Appearance.getColorScheme());
    } catch {
        return undefined;
    }
};
