import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ListEmptyState } from './list-empty-state';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  View: ({ accessible, accessibilityLabel, accessibilityRole, accessibilityLiveRegion, ...props }: any) =>
    React.createElement('div', props, props.children),
  Text: ({ accessibilityRole, accessibilityLiveRegion, ...props }: any) =>
    React.createElement('span', props, props.children),
  TouchableOpacity: ({ accessibilityRole, accessibilityLabel, onPress, ...props }: any) =>
    React.createElement('button', { ...props, 'aria-label': accessibilityLabel, onClick: onPress }, props.children),
}));

describe('ListEmptyState', () => {
  it('renders empty message text', () => {
    const html = renderToStaticMarkup(
      <ListEmptyState
        message="No tasks yet"
        backgroundColor="#111111"
        borderColor="#222222"
        textColor="#ffffff"
      />
    );

    expect(html).toContain('No tasks yet');
  });

  it('renders an optional empty-state action', () => {
    const html = renderToStaticMarkup(
      <ListEmptyState
        message="No tasks yet"
        backgroundColor="#111111"
        borderColor="#222222"
        textColor="#ffffff"
        actionLabel="Add task"
        onAction={vi.fn()}
      />
    );

    expect(html).toContain('Add task');
  });
});
