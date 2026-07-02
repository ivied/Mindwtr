import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemeColors } from '@/hooks/use-theme-colors';

export type PullSyncIndicatorState = 'idle' | 'syncing' | 'success' | 'error';

type PullSyncIndicatorProps = {
  state: PullSyncIndicatorState;
};

export function PullSyncIndicator({ state }: PullSyncIndicatorProps) {
  const tc = useThemeColors();

  if (state === 'idle') return null;

  const color = state === 'error'
    ? tc.danger
    : state === 'success'
      ? tc.success
      : tc.tint;

  return (
    <View pointerEvents="none" style={styles.root}>
      <View style={[styles.bar, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    alignItems: 'center',
    paddingTop: 0,
  },
  bar: {
    width: 112,
    height: 4,
    borderRadius: 999,
  },
});
