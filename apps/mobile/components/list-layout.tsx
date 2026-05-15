import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

export const LIST_EDGE_PADDING = 16;
export const LIST_BOTTOM_PADDING = 24;

export const defaultListContentStyle: StyleProp<ViewStyle> = {
  paddingHorizontal: LIST_EDGE_PADDING,
  paddingTop: 8,
  paddingBottom: LIST_BOTTOM_PADDING,
};

export function ListSectionHeader({ title, tc, style }: { title: string; tc: ThemeColors; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.container, style]}>
      <Text style={[styles.text, { color: tc.secondaryText }]} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 14,
    paddingBottom: 8,
  },
  text: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
