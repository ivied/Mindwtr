/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

const tintColorLight = '#3B82F6';
const tintColorDark = '#3B82F6';

export const Colors = {
  light: {
    text: '#0F172A',
    background: '#F6F7FB',
    tint: tintColorLight,
    icon: '#4B5563',
    tabIconDefault: '#4B5563',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

export const Material3 = {
  light: {
    primary: '#1B6EF3',
    onPrimary: '#FFFFFF',
    primaryContainer: '#D7E2FF',
    onPrimaryContainer: '#001B3E',
    secondary: '#58616E',
    onSecondary: '#FFFFFF',
    background: '#F9FAFF',
    surface: '#F9FAFF',
    surfaceContainer: '#EEF1F7',
    surfaceContainerHigh: '#E5E9F0',
    surfaceVariant: '#DFE3EB',
    outline: '#73777F',
    text: '#1A1C1E',
    secondaryText: '#43474F',
    error: '#BA1A1A',
    success: '#0F7B3D',
    warning: '#8C5A00',
  },
  dark: {
    primary: '#AAC7FF',
    onPrimary: '#003063',
    primaryContainer: '#00458B',
    onPrimaryContainer: '#D7E2FF',
    secondary: '#C1C7D4',
    onSecondary: '#2B313C',
    background: '#111318',
    surface: '#111318',
    surfaceContainer: '#1B1E24',
    surfaceContainerHigh: '#22252B',
    surfaceVariant: '#43474E',
    outline: '#8D9199',
    text: '#E3E2E6',
    secondaryText: '#C3C6CF',
    error: '#FFB4AB',
    success: '#7CDC94',
    warning: '#F2C16E',
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
