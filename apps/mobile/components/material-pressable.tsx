import React from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useThemeTokens } from '../hooks/use-theme-tokens';

/**
 * A drop-in `Pressable` that adds Material 3 press feedback (Android ripple +
 * a pressed state-layer overlay) ONLY when the active theme is Material 3.
 * Under every other theme it renders a plain `Pressable` with the caller's
 * original props untouched — no ripple, no overlay — so non-Material themes
 * keep today's press behavior exactly.
 */
export function MaterialPressable({ style, children, ...rest }: PressableProps) {
  const { isMaterial, state } = useThemeTokens();

  if (!isMaterial) {
    return (
      <Pressable style={style} {...rest}>
        {children}
      </Pressable>
    );
  }

  return (
    <Pressable
      android_ripple={{ color: state.rippleColor }}
      style={(s) => {
        const base = typeof style === 'function' ? style(s) : style;
        const overlay: StyleProp<ViewStyle> = s.pressed
          ? { backgroundColor: state.stateLayerColor('pressed') }
          : null;
        return [base, overlay];
      }}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
