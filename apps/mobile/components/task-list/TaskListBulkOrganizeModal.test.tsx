import React from 'react';
import { Pressable, Text, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Area, Project } from '@mindwtr/core';

import { TaskListBulkOrganizeModal } from './TaskListBulkOrganizeModal';

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ tint: '#3b82f6', onTint: '#ffffff' }),
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('lucide-react-native', () => {
  const Icon = (props: any) => React.createElement('Icon', props, props.children);
  return {
    __esModule: true,
    Check: Icon,
    ChevronRight: Icon,
    ClipboardCheck: Icon,
    X: Icon,
  };
});

const themeColors = {
  border: '#334155',
  cardBg: '#111827',
  danger: '#ef4444',
  filterBg: '#1f2937',
  inputBg: '#0f172a',
  onTint: '#ffffff',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const t = (key: string) => ({
  'areas.create': 'Create area',
  'bulk.applyToSelected': 'Apply to selected',
  'bulk.keepArea': 'Keep area',
  'bulk.keepProject': 'Keep project',
  'bulk.organize': 'Bulk organize',
  'bulk.organizeHintShort': 'Titles and descriptions stay unchanged.',
  'bulk.organizeStatus': 'Status',
  'bulk.selected': 'selected',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.noMatches': 'No matches',
  'common.search': 'Search',
  'process.delegateWhoLabel': 'Waiting for',
  'process.delegateWhoPlaceholder': 'Person or team',
  'process.followUpLabel': 'Follow-up',
  'projects.areaLabel': 'Area',
  'projects.create': 'Create project',
  'status.done': 'Done',
  'status.next': 'Next',
  'status.reference': 'Reference',
  'status.someday': 'Someday',
  'status.waiting': 'Waiting',
  'taskEdit.contextsLabel': 'Contexts',
  'taskEdit.dueDateLabel': 'Due',
  'taskEdit.noAreaOption': 'No area',
  'taskEdit.noProjectOption': 'No project',
  'taskEdit.projectLabel': 'Project',
  'taskEdit.reviewDateLabel': 'Review',
  'taskEdit.startDateLabel': 'Start',
  'taskEdit.tagsLabel': 'Tags',
}[key] ?? key);

const makeProject = (id: string, title: string, order: number): Project => ({
  id,
  title,
  status: 'active',
  color: '#3b82f6',
  order,
  tagIds: [],
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
});

const makeArea = (id: string, name: string, order: number): Area => ({
  id,
  name,
  order,
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
});

const renderModal = (
  overrides: Partial<React.ComponentProps<typeof TaskListBulkOrganizeModal>> = {},
) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <TaskListBulkOrganizeModal
        areas={[
          makeArea('area-home', 'Home', 0),
          makeArea('area-work', 'Work', 1),
        ]}
        isApplying={false}
        onApply={vi.fn()}
        onClose={vi.fn()}
        projects={[
          makeProject('project-launch', 'Launch', 0),
          makeProject('project-trip', 'Japan Trip October', 1),
        ]}
        selectedCount={2}
        t={t}
        themeColors={themeColors}
        visible
        {...overrides}
      />
    );
  });
  return tree;
};

const directButtonText = (node: any) => React.Children.toArray(node.props.children)
  .filter((child): child is React.ReactElement<{ children?: React.ReactNode }> => (
    React.isValidElement(child) && child.type === Text
  ))
  .map((child) => child.props.children)
  .join('');

const buttonWithText = (tree: ReturnType<typeof create>, text: string) => tree.root.find((node) => (
  (node.type === TouchableOpacity || node.type === Pressable)
  && directButtonText(node) === text
));

describe('TaskListBulkOrganizeModal', () => {
  it('uses collapsed selector rows for project and area so unbounded options are not clipped inline', () => {
    const tree = renderModal();

    expect(tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' })).toBeTruthy();
    expect(tree.root.findAll((node) => (
      node.type === TouchableOpacity
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'Japan Trip October')
    ))).toHaveLength(0);
  });

  it('keeps project unchanged by default and applies a selected project from the picker', () => {
    const onApply = vi.fn();
    const tree = renderModal({ onApply });

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-project-picker-row' }).props.onPress();
    });
    act(() => {
      buttonWithText(tree, 'Japan Trip October').props.onPress();
    });
    act(() => {
      buttonWithText(tree, 'Apply to selected').props.onPress();
    });

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-trip',
      status: 'next',
    }));
  });

  it('preserves the keep sentinel as the first picker option', () => {
    const tree = renderModal();

    act(() => {
      tree.root.findByProps({ testID: 'bulk-organize-area-picker-row' }).props.onPress();
    });

    const areaOptions = tree.root.findAll((node) => (
      (node.type === TouchableOpacity || node.type === Pressable)
      && node.props.accessibilityRole === 'button'
      && node.findAllByType(Text).length > 0
    ));
    const labels = areaOptions
      .map(directButtonText)
      .filter(Boolean);

    expect(labels).toContain('Keep area');
    expect(labels.indexOf('Keep area')).toBeLessThan(labels.indexOf('No area'));
  });

  it('does not emit duplicate-key warnings when project or area names repeat', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderModal({
      areas: [
        makeArea('area-work-1', 'Work', 0),
        makeArea('area-work-2', 'Work', 1),
      ],
      projects: [
        makeProject('project-work-1', 'Work', 0),
        makeProject('project-work-2', 'Work', 1),
      ],
    });

    const duplicateKeyWarnings = consoleError.mock.calls.filter(([message]) => (
      String(message).includes('Encountered two children with the same key')
    ));
    consoleError.mockRestore();

    expect(duplicateKeyWarnings).toHaveLength(0);
  });
});
