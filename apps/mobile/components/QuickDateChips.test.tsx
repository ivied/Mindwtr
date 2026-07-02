import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { getQuickDate } from '@mindwtr/core';

import { QuickDateChips } from './QuickDateChips';

const flattenStyle = (value: any): Record<string, unknown> => (
  Array.isArray(value)
    ? Object.assign({}, ...value.map(flattenStyle))
    : value
);

const tc = {
  cardBg: '#111',
  border: '#333',
  filterBg: '#222',
  inputBg: '#111',
  secondaryText: '#aaa',
  text: '#fff',
  tint: '#3b82f6',
  onTint: '#fff',
};

const t = (key: string) => ({
  'quickDate.today': 'Today',
  'quickDate.tomorrow': 'Tomorrow',
  'quickDate.in3Days': '+3 days',
  'quickDate.nextWeek': 'Next week',
  'quickDate.nextMonth': 'Next month',
  'quickDate.noDate': 'No date',
}[key] ?? key);

describe('QuickDateChips', () => {
  it('wraps quick date pills instead of clipping them horizontally', () => {
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <QuickDateChips
          t={t}
          tc={tc as any}
          selectedDate={null}
          onSelect={vi.fn()}
        />
      );
    });

    const row = tree.root.findByProps({ testID: 'quick-date-chips-row' });
    expect(flattenStyle(row.props.style)).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'wrap',
    });

    const labels = tree.root.findAllByType(Text).map((node) => node.props.children);
    expect(labels).toContain('Next month');
  });

  it('gives each quick date pill a minimum responsive width before wrapping', () => {
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <QuickDateChips
          t={t}
          tc={tc as any}
          selectedDate={null}
          onSelect={vi.fn()}
          presets={['today', 'tomorrow', 'next_week']}
        />
      );
    });

    const firstChip = tree.root.findAllByProps({ accessibilityRole: 'button' })[0];
    expect(flattenStyle(firstChip.props.style)).toMatchObject({
      flexBasis: 92,
      flexGrow: 1,
      flexShrink: 1,
    });
  });

  it('renders only the presets it is given', () => {
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <QuickDateChips
          t={t}
          tc={tc as any}
          selectedDate={null}
          onSelect={vi.fn()}
          presets={['today', 'tomorrow', 'next_week']}
        />
      );
    });

    const labels = tree.root.findAllByType(Text).map((node) => node.props.children);
    expect(labels).toEqual(expect.arrayContaining(['Today', 'Tomorrow', 'Next week']));
    expect(labels).not.toContain('Next month');
    expect(labels).not.toContain('No date');
    expect(labels).not.toContain('+3 days');
  });

  it('renders a trailing node inside the same wrapping row', () => {
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <QuickDateChips
          t={t}
          tc={tc as any}
          selectedDate={null}
          onSelect={vi.fn()}
          presets={['today']}
          trailing={<Text>CUSTOM_SLOT</Text>}
        />
      );
    });

    const row = tree.root.findByProps({ testID: 'quick-date-chips-row' });
    const labels = row.findAllByType(Text).map((node) => node.props.children);
    expect(labels).toContain('CUSTOM_SLOT');
  });

  it('clears the date when the already-active chip is tapped again', () => {
    const onSelect = vi.fn();
    const today = getQuickDate('today', new Date());
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <QuickDateChips
          t={t}
          tc={tc as any}
          selectedDate={today}
          onSelect={onSelect}
          presets={['today', 'tomorrow']}
        />
      );
    });

    const chips = tree.root.findAllByProps({ accessibilityRole: 'button' });
    const todayChip = chips.find((node) => node.props.accessibilityLabel === 'Today');
    expect(todayChip).toBeDefined();
    act(() => {
      todayChip!.props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith(null, 'today');
  });
});
