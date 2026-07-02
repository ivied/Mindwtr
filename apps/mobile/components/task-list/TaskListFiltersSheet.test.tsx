import React from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TaskEnergyLevel } from '@mindwtr/core';

vi.mock('lucide-react-native', () => ({
  X: () => null,
}));

import { TaskListFiltersSheet } from './TaskListFiltersSheet';

const themeColors = {
  bg: '#0f172a',
  border: '#334155',
  cardBg: '#111827',
  filterBg: '#1f2937',
  onTint: '#ffffff',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const createProps = (
  overrides: Partial<React.ComponentProps<typeof TaskListFiltersSheet>> = {}
): React.ComponentProps<typeof TaskListFiltersSheet> => ({
  energyLevelOptions: ['low', 'medium', 'high'] as TaskEnergyLevel[],
  hasFilters: false,
  contextMatchMode: 'all',
  contextMatchModeLabels: {
    title: 'Context match',
    any: 'Any',
    all: 'All',
  },
  locationQuery: '',
  onChangeContextMatchMode: vi.fn(),
  onChangeLocationQuery: vi.fn(),
  onChangeSearchQuery: vi.fn(),
  onClearFilters: vi.fn(),
  onClose: vi.fn(),
  priorityOptions: [],
  searchQuery: '',
  selectedEnergyLevels: [],
  selectedPriorities: [],
  selectedTimeEstimates: [],
  selectedTokens: [],
  showContextMatchMode: false,
  showLocationFilter: false,
  showEnergyLevelFilters: false,
  showPriorityFilters: false,
  showTimeEstimateFilters: false,
  t: (key: string) => ({
    'common.close': 'Close',
    'common.search': 'Search',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.timeEstimate': 'Time estimate',
    'search.placeholder': 'Search tasks',
    'taskEdit.energyLevel': 'Energy level',
    'energyLevel.low': 'Low energy',
    'energyLevel.medium': 'Medium energy',
    'energyLevel.high': 'High energy',
    'priority.low': 'Low priority',
    'priority.urgent': 'Urgent priority',
  }[key] ?? key),
  themeColors,
  toggleEnergyLevel: vi.fn(),
  togglePriority: vi.fn(),
  toggleTimeEstimate: vi.fn(),
  toggleToken: vi.fn(),
  tokenOptions: [],
  visible: true,
  ...overrides,
});

const elementProps = (child: unknown): { children?: React.ReactNode; testID?: string } | null => (
  React.isValidElement(child)
    ? child.props as { children?: React.ReactNode; testID?: string }
    : null
);

const hasText = (tree: ReturnType<typeof create>, text: string): boolean => (
  tree.root.findAllByType(Text).some((node) => node.props.children === text)
);

describe('TaskListFiltersSheet', () => {
  it('keeps search above injected filter content', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskListFiltersSheet
          {...createProps({
            extraContent: (
              <View testID="project-filter-content">
                <Text>Project controls</Text>
              </View>
            ),
          })}
        />
      );
    });

    const scroll = tree.root.findByType(ScrollView);
    const children = React.Children.toArray(scroll.props.children);
    const searchLabelIndex = children.findIndex((child) => (
      React.isValidElement(child)
      && child.type === Text
      && elementProps(child)?.children === 'Search'
    ));
    const searchInputIndex = children.findIndex((child) => (
      React.isValidElement(child) && child.type === TextInput
    ));
    const extraContentIndex = children.findIndex((child) => (
      React.isValidElement(child) && elementProps(child)?.testID === 'project-filter-content'
    ));

    expect(searchLabelIndex).toBeGreaterThanOrEqual(0);
    expect(searchInputIndex).toBeGreaterThan(searchLabelIndex);
    expect(extraContentIndex).toBeGreaterThan(searchInputIndex);
  });

  it('shows the context match mode control only when requested', () => {
    const onChangeContextMatchMode = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskListFiltersSheet
          {...createProps({
            contextMatchMode: 'any',
            onChangeContextMatchMode,
            selectedTokens: ['@desk', '@phone'],
            showContextMatchMode: true,
            tokenOptions: ['@desk', '@phone'],
          })}
        />
      );
    });

    const anyButton = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'Any')
    ));
    const allButton = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'All')
    ));

    expect(anyButton.props.accessibilityState).toEqual({ selected: true });

    act(() => {
      allButton.props.onPress();
    });

    expect(onChangeContextMatchMode).toHaveBeenCalledWith('all');
  });

  it('hides metadata filter sections when no visible tasks use those fields', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TaskListFiltersSheet {...createProps()} />);
    });

    expect(hasText(tree, 'Priority')).toBe(false);
    expect(hasText(tree, 'Energy level')).toBe(false);
    expect(hasText(tree, 'Time estimate')).toBe(false);
  });

  it('shows metadata filter sections when visible tasks use those fields', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskListFiltersSheet
          {...createProps({
            energyLevelOptions: ['low'],
            priorityOptions: ['urgent'],
            showEnergyLevelFilters: true,
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
            timeEstimateOptions: ['30min'],
          })}
        />
      );
    });

    expect(hasText(tree, 'Priority')).toBe(true);
    expect(hasText(tree, 'Urgent priority')).toBe(true);
    expect(hasText(tree, 'Energy level')).toBe(true);
    expect(hasText(tree, 'Low energy')).toBe(true);
    expect(hasText(tree, 'Time estimate')).toBe(true);
    expect(hasText(tree, '30m')).toBe(true);
  });
});
