import React from 'react';
import { StyleSheet, Text, TextInput, type TextInputProps, type TextProps } from 'react-native';

import { COMPACT_TEXT_MAX_SCALE } from '@/constants/text-scale';

export type CompactTextProps = TextProps;
export type CompactTextInputProps = TextInputProps;

export function CompactText({
  maxFontSizeMultiplier = COMPACT_TEXT_MAX_SCALE,
  style,
  ...rest
}: CompactTextProps) {
  return (
    <Text
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[styles.compactText, style]}
      {...rest}
    />
  );
}

export const CompactTextInput = React.forwardRef<TextInput, CompactTextInputProps>(function CompactTextInput(
  {
    maxFontSizeMultiplier = COMPACT_TEXT_MAX_SCALE,
    style,
    ...rest
  },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[styles.compactText, style]}
      {...rest}
    />
  );
});

const styles = StyleSheet.create({
  compactText: {
    flexShrink: 1,
  },
});
