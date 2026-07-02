import React from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, ScrollView, Text, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CaptureScreen, { sanitizeCaptureReturnToParam } from '@/app/capture-modal';

const { openTaskScreen, parseQuickAdd, routerMocks, routeParams, storeState } = vi.hoisted(() => {
  const parseQuickAdd = vi.fn<(value: string) => any>((value: string) => ({ title: value, props: {}, invalidDateCommands: [] }));
  return {
    openTaskScreen: vi.fn(),
    parseQuickAdd,
    routerMocks: {
      back: vi.fn(),
      canGoBack: vi.fn(),
      replace: vi.fn(),
    },
    routeParams: {
      current: { text: encodeURIComponent('Shared text') } as Record<string, string>,
    },
    storeState: {
      addProject: vi.fn(),
      addTask: vi.fn(),
      addTasks: vi.fn(),
      projects: [] as any[],
      tasks: [] as any[],
      settings: { ai: { enabled: false }, features: {} },
      areas: [] as any[],
    },
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => routerMocks,
}));

vi.mock('@mindwtr/core', () => ({
  createAIProvider: vi.fn(),
  DEFAULT_PROJECT_COLOR: '#94a3b8',
  getQuickAddProjectInitialProps: (props: any, fallbackAreaId?: string | null) => {
    const areaId = props?.areaId || fallbackAreaId || undefined;
    return areaId ? { areaId } : undefined;
  },
  getUsedTaskTokens: vi.fn(() => []),
  isSelectableProjectForTaskAssignment: vi.fn((project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  )),
  parseQuickAdd,
  normalizeClockTimeInput: (value?: string | null) => String(value ?? '').trim(),
  resolveDefaultNewTaskAreaId: (settings: any, areas: any[]) => {
    const areaId = settings?.gtd?.defaultAreaId;
    return typeof areaId === 'string' && areas.some((area) => area.id === areaId && !area.deletedAt)
      ? areaId
      : undefined;
  },
  shallow: (left: unknown, right: unknown) => Object.is(left, right),
  splitQuickAddBulkLines: (input: string) => input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  },
  useTaskStore: (selector?: (state: typeof storeState) => unknown) => (
    typeof selector === 'function' ? selector(storeState) : storeState
  ),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'nav.addTask': 'Add Task',
        'quickAdd.example': 'Quick add',
        'common.cancel': 'Cancel',
        'common.done': 'Done',
        'common.save': 'Save',
        'common.notice': 'Notice',
        'quickAdd.saveAndEdit': 'Save & edit',
        'quickAdd.invalidDateCommand': 'Invalid date command',
        'copilot.suggested': 'Suggested',
        'copilot.applyHint': 'Tap to apply',
        'copilot.applied': 'Applied',
        'quickAdd.help': 'Help text',
        'taskEdit.descriptionLabel': 'Description',
        'taskEdit.descriptionPlaceholder': 'Add notes...',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    inputBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/ai-config', () => ({
  buildCopilotConfig: vi.fn(),
  isAIKeyRequired: vi.fn(() => false),
  loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen,
}));

const findTouchableByText = (tree: ReturnType<typeof create>, label: string) => {
  const button = tree.root.findAll((node) => (
    node.type === TouchableOpacity
    && node.findAllByType(Text).some((child) => child.props.children === label)
  ))[0];
  if (!button) throw new Error(`TouchableOpacity not found for ${label}`);
  return button;
};

describe('CaptureScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseQuickAdd.mockImplementation((value: string) => ({ title: value, props: {}, invalidDateCommands: [] }));
    routerMocks.canGoBack.mockReturnValue(false);
    routeParams.current = { text: encodeURIComponent('Shared text') };
    storeState.addProject.mockResolvedValue(null);
    storeState.addTask.mockResolvedValue({ success: true, id: 'task-created' });
    storeState.projects = [];
    storeState.areas = [];
  });

  it('returns to inbox when cancelling without a back stack', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('returns to a requested internal route when cancelling', () => {
    routeParams.current = {
      text: encodeURIComponent('Shared text'),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith('/projects-screen?projectId=project-1');
  });

  it('goes back when cancelling from a stacked navigation flow', () => {
    routerMocks.canGoBack.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it('adds keyboard-aware layout and exposes a dismiss action while the keyboard is visible', () => {
    const listeners = new Map<string, ((event?: unknown) => void) | undefined>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return {
        remove: () => {
          listeners.delete(eventName);
        },
      };
    }) as any);
    const dismissSpy = vi.spyOn(Keyboard, 'dismiss');

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    expect(tree.root.findByType(KeyboardAvoidingView)).toBeTruthy();
    expect(tree.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
    expect(tree.root.findByType(ScrollView).props.keyboardDismissMode).toBe('on-drag');

    act(() => {
      listeners.get('keyboardDidShow')?.();
    });

    const doneButton = tree.root.find(
      (node) => node.type === TouchableOpacity && node.props.accessibilityLabel === 'Done'
    );

    act(() => {
      doneButton.props.onPress();
    });

    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('saves App Action capture details from initial props after confirmation', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Call dentist'),
      initialProps: encodeURIComponent(JSON.stringify({
        description: 'Tomorrow morning',
        tags: ['#phone'],
      })),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Call dentist', {
      status: 'inbox',
      description: 'Tomorrow morning',
      tags: ['#phone'],
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('confirms multiline capture before creating one task per line', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Email Bob\n\nCall Alice /next'),
    };
    parseQuickAdd.mockImplementation((value: string) => ({
      title: value.replace(/\s+\/next$/u, ''),
      props: value.endsWith('/next') ? { status: 'next' } : {},
      invalidDateCommands: [],
    }));
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Create 2 tasks?',
      expect.stringContaining('Email Bob'),
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void | Promise<void> }>;
    const confirm = buttons.find((button) => button.text === 'Create tasks');
    if (!confirm?.onPress) throw new Error('Confirm button not found');

    await act(async () => {
      await confirm.onPress?.();
    });

    expect(storeState.addTask).not.toHaveBeenCalled();
    expect(storeState.addTasks).toHaveBeenCalledTimes(1);
    expect(storeState.addTasks).toHaveBeenCalledWith([
      { title: 'Email Bob', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Call Alice', initialProps: expect.objectContaining({ status: 'next' }) },
    ]);
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('preserves safe status and project initial props from capture links', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
  });

  it('returns to the requested project route after saving a project task', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
      returnTo: encodeURIComponent('/projects-screen?projectId=project-1'),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/projects-screen?projectId=project-1');
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/inbox');
  });

  it('sanitizes capture return routes to app-internal paths', () => {
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('/projects-screen?projectId=project-1')))
      .toBe('/projects-screen?projectId=project-1');
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('//example.com/path'))).toBeNull();
    expect(sanitizeCaptureReturnToParam(encodeURIComponent('https://example.com/path'))).toBeNull();
    expect(sanitizeCaptureReturnToParam('')).toBeNull();
  });

  it('ignores unsupported URL-controlled initial props', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Visible task'),
      initialProps: encodeURIComponent(JSON.stringify({
        description: 'Keep this',
        tags: ['phone'],
        status: 'archived',
        deletedAt: '2026-05-09T12:00:00.000Z',
        attachments: [{ id: 'attachment-1' }],
      })),
    };

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Visible task', {
      status: 'inbox',
      description: 'Keep this',
      tags: ['#phone'],
    });
  });

  it('resolves project names supplied by shortcut capture links', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Call dentist'),
      project: encodeURIComponent('Health'),
    };
    storeState.addProject.mockResolvedValue({ id: 'project-health', title: 'Health' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addProject).toHaveBeenCalledWith('Health', '#94a3b8', undefined);
    expect(storeState.addTask).toHaveBeenCalledWith('Call dentist', {
      status: 'inbox',
      projectId: 'project-health',
    });
  });

  it('creates parsed quick-add projects inside the parsed area', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Plan campaign +Launch !Work'),
    };
    parseQuickAdd.mockReturnValue({
      title: 'Plan campaign',
      props: { areaId: 'area-work' },
      projectTitle: 'Launch',
      invalidDateCommands: [],
    });
    storeState.addProject.mockResolvedValue({ id: 'project-launch', title: 'Launch' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveButton = findTouchableByText(tree, 'Save');

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addProject).toHaveBeenCalledWith('Launch', '#94a3b8', { areaId: 'area-work' });
    expect(storeState.addTask).toHaveBeenCalledWith('Plan campaign', {
      status: 'inbox',
      projectId: 'project-launch',
      areaId: undefined,
    });
  });

  it('opens the created task when save and edit is requested', async () => {
    routeParams.current = {
      initialValue: encodeURIComponent('Project task'),
      initialProps: encodeURIComponent(JSON.stringify({
        projectId: 'project-1',
        status: 'next',
      })),
    };
    storeState.projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];
    storeState.addTask.mockResolvedValueOnce({ success: true, id: 'task-new' });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const saveAndEditButton = findTouchableByText(tree, 'Save & edit');

    await act(async () => {
      await saveAndEditButton.props.onPress();
    });

    expect(storeState.addTask).toHaveBeenCalledWith('Project task', {
      status: 'next',
      projectId: 'project-1',
    });
    expect(openTaskScreen).toHaveBeenCalledWith('task-new', 'project-1', 'task');
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/inbox');
  });
});
