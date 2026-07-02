import { Colors } from '../constants/theme';
import { THEME_PRESETS } from '../constants/theme-presets';
import { M3Colors, type M3ColorRoles } from '../constants/material3/m3-color';
import { M3Typography } from '../constants/material3/m3-typography';
import { M3Shape } from '../constants/material3/m3-shape';
import { buildElevationStyle, type ElevationStyle, type M3ElevationLevel } from '../constants/material3/m3-elevation';
import { buildStateLayer, type M3StateName } from '../constants/material3/m3-state';
import { useTheme, type ThemeContextType } from '../contexts/theme-context';

type ResolvableTheme = Pick<ThemeContextType, 'isDark' | 'themeStyle' | 'themePreset' | 'themeMode'>;

// Generic color shape — source of truth lives here; use-theme-colors.ts re-exports it,
// so the module dependency is one-directional (use-theme-colors → use-theme-tokens) with no cycle.
export interface ThemeColors {
  bg: string; cardBg: string; taskItemBg: string; text: string; secondaryText: string;
  icon: string; border: string; tint: string; onTint: string; tabIconDefault: string;
  tabIconSelected: string; inputBg: string; danger: string; success: string; warning: string;
  filterBg: string;
}

export const FALLBACK_THEME_COLORS: ThemeColors = {
  bg: Colors.light.background, cardBg: '#FFFFFF', taskItemBg: '#F1F5F9',
  text: Colors.light.text, secondaryText: '#4B5563', icon: Colors.light.icon,
  border: '#E2E8F0', tint: Colors.light.tint, onTint: '#FFFFFF',
  tabIconDefault: Colors.light.tabIconDefault, tabIconSelected: Colors.light.tabIconSelected,
  inputBg: '#EEF2F7', danger: '#EF4444', success: '#10B981', warning: '#F59E0B', filterBg: '#EEF2F7',
};

export interface ThemeTokens {
  colors: ThemeColors;
  roles: M3ColorRoles | null;
  type: typeof M3Typography;
  shape: typeof M3Shape;
  elevation: (level: M3ElevationLevel) => ElevationStyle;
  state: { rippleColor: string | undefined; stateLayerColor: (s: M3StateName) => string };
  isMaterial: boolean;
}

function m3RolesFor(theme: ResolvableTheme): M3ColorRoles {
  if (theme.themeMode === 'material3-light') return M3Colors.light;
  if (theme.themeMode === 'material3-dark') return M3Colors.dark;
  return theme.isDark ? M3Colors.dark : M3Colors.light;
}

// Generic ThemeColors mapping (preserves today's non-Material output; Materializes when M3).
function resolveGenericColors(theme: ResolvableTheme): ThemeColors {
  if (theme.themePreset !== 'default') {
    return THEME_PRESETS[theme.themePreset];
  }
  if (theme.themeStyle === 'material3') {
    const p = m3RolesFor(theme);
    return {
      bg: p.background, cardBg: p.surfaceContainer, taskItemBg: p.surfaceContainerHigh,
      text: p.text, secondaryText: p.secondaryText, icon: p.secondaryText,
      border: p.outline, tint: p.primary, onTint: p.onPrimary,
      tabIconDefault: p.secondaryText, tabIconSelected: p.primary,
      inputBg: p.surfaceVariant, danger: p.error, success: p.success, warning: p.warning,
      filterBg: p.surfaceVariant,
    };
  }
  const isDark = theme.isDark;
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
    danger: '#EF4444', success: '#10B981', warning: '#F59E0B',
    filterBg: isDark ? '#374151' : '#EEF2F7',
  };
}

const FALLBACK: ThemeTokens = {
  colors: FALLBACK_THEME_COLORS,
  roles: null, type: M3Typography, shape: M3Shape,
  elevation: () => ({}), state: { rippleColor: undefined, stateLayerColor: () => 'transparent' },
  isMaterial: false,
};

export function resolveThemeTokens(theme?: ResolvableTheme | null): ThemeTokens {
  if (!theme) return FALLBACK;
  const isMaterial = theme.themeStyle === 'material3';
  const roles = isMaterial ? m3RolesFor(theme) : null;
  return {
    colors: resolveGenericColors(theme),
    roles,
    type: M3Typography,
    shape: M3Shape,
    elevation: (level) => buildElevationStyle(level, { isMaterial, roles }),
    state: buildStateLayer({ isMaterial, roles }),
    isMaterial,
  };
}

export function useThemeTokens(): ThemeTokens {
  return resolveThemeTokens(useTheme());
}
