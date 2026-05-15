import { Colors, Material3 } from '../constants/theme';
import { THEME_PRESETS } from '../constants/theme-presets';
import { useTheme, type ThemeContextType } from '../contexts/theme-context';

export interface ThemeColors {
    bg: string;
    cardBg: string;
    taskItemBg: string;
    text: string;
    secondaryText: string;
    icon: string;
    border: string;
    tint: string;
    onTint: string;
    tabIconDefault: string;
    tabIconSelected: string;
    inputBg: string;
    danger: string;
    success: string;
    warning: string;
    filterBg: string;
}

export const FALLBACK_THEME_COLORS: ThemeColors = {
    bg: Colors.light.background,
    cardBg: '#FFFFFF',
    taskItemBg: '#F1F5F9',
    text: Colors.light.text,
    secondaryText: '#4B5563',
    icon: Colors.light.icon,
    border: '#E2E8F0',
    tint: Colors.light.tint,
    onTint: '#FFFFFF',
    tabIconDefault: Colors.light.tabIconDefault,
    tabIconSelected: Colors.light.tabIconSelected,
    inputBg: '#EEF2F7',
    danger: '#EF4444',
    success: '#10B981',
    warning: '#F59E0B',
    filterBg: '#EEF2F7',
};

export function resolveThemeColors(theme?: Pick<ThemeContextType, 'isDark' | 'themeStyle' | 'themePreset' | 'themeMode'> | null): ThemeColors {
    if (!theme) {
        return FALLBACK_THEME_COLORS;
    }

    const { isDark, themeStyle, themePreset, themeMode } = theme;

    if (themePreset !== 'default') {
        return THEME_PRESETS[themePreset];
    }

    const useMaterial3 = themeStyle === 'material3';

    if (useMaterial3) {
        const palette = themeMode === 'material3-light'
            ? Material3.light
            : themeMode === 'material3-dark'
                ? Material3.dark
                : isDark
                    ? Material3.dark
                    : Material3.light;
        return {
            bg: palette.background,
            cardBg: palette.surfaceContainer,
            taskItemBg: palette.surfaceContainerHigh,
            text: palette.text,
            secondaryText: palette.secondaryText,
            icon: palette.secondaryText,
            border: palette.outline,
            tint: palette.primary,
            onTint: palette.onPrimary,
            tabIconDefault: palette.secondaryText,
            tabIconSelected: palette.primary,
            inputBg: palette.surfaceVariant,
            danger: palette.error,
            success: palette.success,
            warning: palette.warning,
            filterBg: palette.surfaceVariant,
        };
    }

    return {
        bg: isDark ? Colors.dark.background : Colors.light.background,
        cardBg: isDark ? '#1F2937' : '#FFFFFF',
        taskItemBg: isDark ? '#1F2937' : '#F1F5F9',
        text: isDark ? Colors.dark.text : Colors.light.text,
        secondaryText: isDark ? '#9CA3AF' : '#4B5563',
        icon: isDark ? Colors.dark.icon : Colors.light.icon,
        border: isDark ? '#374151' : '#E2E8F0',
        tint: isDark ? Colors.dark.tint : Colors.light.tint,
        onTint: '#FFFFFF',
        tabIconDefault: isDark ? Colors.dark.tabIconDefault : Colors.light.tabIconDefault,
        tabIconSelected: isDark ? Colors.dark.tabIconSelected : Colors.light.tabIconSelected,
        inputBg: isDark ? '#374151' : '#EEF2F7',
        danger: '#EF4444',
        success: '#10B981',
        warning: '#F59E0B',
        filterBg: isDark ? '#374151' : '#EEF2F7',
    };
}

export function useThemeColors() {
    return resolveThemeColors(useTheme());
}
