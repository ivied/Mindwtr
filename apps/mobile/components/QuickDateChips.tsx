import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import {
  getQuickDate,
  isQuickDatePresetSelected,
  QUICK_DATE_PRESETS,
  tFallback,
  type QuickDatePreset,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

const QUICK_DATE_LABELS: Record<QuickDatePreset, { key: string; fallback: string }> = {
  today: { key: 'quickDate.today', fallback: 'Today' },
  tomorrow: { key: 'quickDate.tomorrow', fallback: 'Tomorrow' },
  in_3_days: { key: 'quickDate.in3Days', fallback: '+3 days' },
  next_week: { key: 'quickDate.nextWeek', fallback: 'Next week' },
  next_month: { key: 'quickDate.nextMonth', fallback: 'Next month' },
  no_date: { key: 'quickDate.noDate', fallback: 'No date' },
};

type QuickDateChipsProps = {
  t: (key: string) => string;
  tc: ThemeColors;
  selectedDate?: Date | null;
  onSelect: (date: Date | null, preset: QuickDatePreset) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
};

export function QuickDateChips({
  t,
  tc,
  selectedDate,
  onSelect,
  style,
  contentContainerStyle,
}: QuickDateChipsProps) {
  const now = new Date();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={[styles.scroller, style]}
      contentContainerStyle={[styles.content, contentContainerStyle]}
    >
      {QUICK_DATE_PRESETS.map((preset) => {
        const labelConfig = QUICK_DATE_LABELS[preset];
        const label = tFallback(t, labelConfig.key, labelConfig.fallback);
        const active = isQuickDatePresetSelected(preset, selectedDate, now);

        return (
          <Pressable
            key={preset}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
            onPress={() => onSelect(getQuickDate(preset, now), preset)}
            style={[
              styles.chip,
              {
                backgroundColor: active ? tc.tint : tc.filterBg,
                borderColor: active ? tc.tint : tc.border,
              },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                { color: active ? tc.onTint : tc.secondaryText },
              ]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.2}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: {
    marginTop: 8,
  },
  content: {
    gap: 8,
    paddingRight: 4,
  },
  chip: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
