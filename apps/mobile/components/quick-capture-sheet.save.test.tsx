import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuickCaptureSheet } from './quick-capture-sheet';

const addTask = vi.fn();
const addProject = vi.fn();
const updateSettings = vi.fn();
const showToast = vi.fn();

vi.mock('@mindwtr/core', () => ({
  DEFAULT_PROJECT_COLOR: '#3B82F6',
  getUsedTaskTokens: () => [],
  hasTimeComponent: (value?: string | null) => Boolean(value && /[T\s]\d{2}:\d{2}/.test(value)),
  isSelectableProjectForTaskAssignment: (project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  ),
  parseQuickAdd: (input: string) => ({
    title: input,
    props: {},
    invalidDateCommands: [],
  }),
  safeFormatDate: (value: Date | string, formatStr: string) => {
    const date = value instanceof Date ? value : new Date(value);
    if (formatStr === 'p') {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    if (formatStr !== 'yyyy-MM-dd') return '';
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  },
  safeParseDate: () => null,
  useTaskStore: () => ({
    addTask,
    addProject,
    updateSettings,
    areas: [],
    projects: [],
    settings: {},
    tasks: [],
  }),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    useWindowDimensions: () => ({
      fontScale: 1,
      height: 800,
      scale: 1,
      width: 400,
    }),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'common.notice': 'Notice',
      'quickAdd.invalidDateCommand': 'Invalid date',
      'taskEdit.contextsLabel': 'Contexts',
      'taskEdit.dueDateLabel': 'Due Date',
      'taskEdit.noAreaOption': 'No Area',
      'taskEdit.priorityLabel': 'Priority',
      'taskEdit.projectLabel': 'Project',
    }[key] ?? key),
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ selectedAreaIdForNewTasks: null }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    border: '#334155',
    cardBg: '#111827',
    filterBg: '#1f2937',
    inputBg: '#0f172a',
    onTint: '#ffffff',
    secondaryText: '#94a3b8',
    text: '#f8fafc',
    tint: '#3b82f6',
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./use-quick-capture-audio', () => ({
  useQuickCaptureAudio: () => ({
    recording: false,
    recordingBusy: false,
    recordingReady: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('./quick-capture-sheet/QuickCaptureSheetBody', () => ({
  QuickCaptureSheetBody: (props: Record<string, unknown>) => React.createElement('QuickCaptureSheetBody', props),
}));

vi.mock('./quick-capture-sheet/QuickCaptureSheetPickers', () => ({
  QuickCaptureSheetPickers: (props: Record<string, unknown>) => React.createElement('QuickCaptureSheetPickers', props),
}));

describe('QuickCaptureSheet save handling', () => {
  beforeEach(() => {
    addTask.mockReset();
    addProject.mockReset();
    updateSettings.mockReset();
    showToast.mockReset();
  });

  it('ignores duplicate save presses while the first save is in flight', async () => {
    let resolveAddTask: ((value: unknown) => void) | null = null;
    addTask.mockImplementation(() => new Promise((resolve) => {
      resolveAddTask = resolve;
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Double tap task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.handleSave();
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Double tap task', expect.objectContaining({ status: 'inbox' }));

    await act(async () => {
      resolveAddTask?.({ success: true, id: 'task-1' });
      await Promise.resolve();
    });
  });

  it('saves picker due dates as date-only values', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Plan the day"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');

    await act(async () => {
      pickers.props.onDueDateChange({ type: 'set' }, new Date(2026, 4, 10, 14, 37, 0, 0));
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Plan the day', expect.objectContaining({
      dueDate: '2026-05-10',
      status: 'inbox',
    }));
  });

  it('saves picker due times only after the user explicitly selects one', async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Call the office"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');

    await act(async () => {
      pickers.props.onDueDateChange({ type: 'set' }, new Date(2026, 4, 10, 14, 37, 0, 0));
      await Promise.resolve();
    });

    const refreshedPickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!refreshedPickers) throw new Error('QuickCaptureSheetPickers not found');
    await act(async () => {
      refreshedPickers.props.onDueTimeChange({ type: 'set' }, new Date(2026, 4, 10, 16, 15, 0, 0));
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('Call the office', expect.objectContaining({
      dueDate: new Date(2026, 4, 10, 16, 15, 0, 0).toISOString(),
      status: 'inbox',
    }));
  });
});
