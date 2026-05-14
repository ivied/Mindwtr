import React from 'react';
import { Alert, Modal, Text, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemedAlertProvider } from './themed-alert';

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#020617',
    cardBg: '#0f172a',
    taskItemBg: '#111827',
    text: '#f8fafc',
    secondaryText: '#cbd5e1',
    icon: '#cbd5e1',
    border: '#334155',
    tint: '#2563eb',
    onTint: '#ffffff',
    tabIconDefault: '#64748b',
    tabIconSelected: '#2563eb',
    inputBg: '#111827',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
    filterBg: '#1e293b',
  }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => ({ 'common.ok': 'OK' }[key] ?? key) }),
}));

describe('ThemedAlertProvider', () => {
  let tree: ReturnType<typeof create> | null = null;

  afterEach(() => {
    if (tree) {
      act(() => {
        tree?.unmount();
      });
      tree = null;
    }
  });

  it('renders Alert.alert through the themed modal and runs the chosen action', () => {
    const onDelete = vi.fn();
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Tes', 'Move this task to Trash?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]);
    });

    expect(rendered.root.findByType(Modal).props.visible).toBe(true);
    expect(rendered.root.findAllByProps({ children: 'Tes' }).length).toBeGreaterThan(0);
    expect(rendered.root.findAllByProps({ children: 'Move this task to Trash?' }).length).toBeGreaterThan(0);

    const buttons = rendered.root.findAllByType(TouchableOpacity);
    expect(buttons).toHaveLength(2);

    act(() => {
      buttons[1].props.onPress();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('treats Android back as the only visible action for non-cancelable default alerts', () => {
    let rendered!: ReturnType<typeof create>;

    act(() => {
      rendered = create(
        <ThemedAlertProvider>
          <Text>Screen</Text>
        </ThemedAlertProvider>
      );
      tree = rendered;
    });

    act(() => {
      Alert.alert('Notice', 'Sync finished.', undefined, { cancelable: false });
    });

    const modal = rendered.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);

    act(() => {
      modal.props.onRequestClose();
    });

    expect(rendered.root.findAllByType(Modal)).toHaveLength(0);
  });
});
