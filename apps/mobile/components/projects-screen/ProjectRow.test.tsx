import React from 'react';
import renderer from 'react-test-renderer';
import { Alert } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectRow } from './ProjectRow';

const hapticsMocks = vi.hoisted(() => ({
  selectionAsync: vi.fn().mockResolvedValue(undefined),
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Warning: 'warning',
  },
  selectionAsync: hapticsMocks.selectionAsync,
  notificationAsync: hapticsMocks.notificationAsync,
}));

vi.mock('lucide-react-native', () => ({
  AlertTriangle: (props: any) => React.createElement('AlertTriangle', props),
  Star: (props: any) => React.createElement('Star', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

const project = {
  id: 'project-1',
  title: 'Redesign Client Website',
  status: 'active',
  isFocused: false,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
} as any;

const tc = {
  cardBg: '#111827',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const statusPalette = {
  active: { text: '#ffffff', bg: '#111111', border: '#222222' },
  waiting: { text: '#ffffff', bg: '#111111', border: '#222222' },
  someday: { text: '#ffffff', bg: '#111111', border: '#222222' },
  archived: { text: '#ffffff', bg: '#111111', border: '#222222' },
};

describe('ProjectRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a 12px hitSlop and triggers selection haptics when focusing a project', () => {
    const onToggleProjectFocus = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tasks={[]}
          areaById={new Map()}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={onToggleProjectFocus}
        />,
      );
    });

    const focusButton = tree.root.find((node) => node.props.testID === 'project-row-focus-project-1');

    expect(focusButton.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });

    renderer.act(() => {
      focusButton.props.onPress();
    });

    expect(hapticsMocks.selectionAsync).toHaveBeenCalledTimes(1);
    expect(onToggleProjectFocus).toHaveBeenCalledWith('project-1');
  });

  it('uses warning haptics for confirmed project deletion', () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDeleteProject = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tasks={[]}
          areaById={new Map()}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) =>
            ({
              'projects.title': 'Projects',
              'projects.deleteConfirm': 'Delete this project?',
              'common.cancel': 'Cancel',
              'common.delete': 'Delete',
            }[key] ?? key)
          }
          onDeleteProject={onDeleteProject}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const deleteButton = tree.root.find((node) => node.props.testID === 'project-row-delete-project-1');

    expect(deleteButton.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });

    renderer.act(() => {
      deleteButton.props.onPress();
    });

    expect(hapticsMocks.selectionAsync).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Projects',
      'Delete this project?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive', onPress: expect.any(Function) }),
      ]),
    );

    const buttons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const deleteAction = buttons.find((button) => button.text === 'Delete');

    renderer.act(() => {
      deleteAction?.onPress?.();
    });

    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('warning');
    expect(onDeleteProject).toHaveBeenCalledWith('project-1');
  });
});
