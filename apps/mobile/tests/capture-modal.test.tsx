import React from 'react';
import { Keyboard, KeyboardAvoidingView, ScrollView, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CaptureScreen from '@/app/capture-modal';

const { routerMocks, routeParams, storeState } = vi.hoisted(() => ({
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
    projects: [] as any[],
    tasks: [] as any[],
    settings: { ai: { enabled: false }, features: {} },
    areas: [] as any[],
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => routerMocks,
}));

vi.mock('@mindwtr/core', () => ({
  createAIProvider: vi.fn(),
  DEFAULT_PROJECT_COLOR: '#94a3b8',
  getUsedTaskTokens: vi.fn(() => []),
  isSelectableProjectForTaskAssignment: vi.fn((project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  )),
  parseQuickAdd: vi.fn((value: string) => ({ title: value, props: {}, invalidDateCommands: [] })),
  useTaskStore: () => storeState,
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

describe('CaptureScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerMocks.canGoBack.mockReturnValue(false);
    routeParams.current = { text: encodeURIComponent('Shared text') };
    storeState.addProject.mockResolvedValue(null);
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

    const saveButton = tree.root.findAllByType(TouchableOpacity)[2];

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

    const saveButton = tree.root.findAllByType(TouchableOpacity)[2];

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

    const saveButton = tree.root.findAllByType(TouchableOpacity)[2];

    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(storeState.addProject).toHaveBeenCalledWith('Health', '#94a3b8');
    expect(storeState.addTask).toHaveBeenCalledWith('Call dentist', {
      status: 'inbox',
      projectId: 'project-health',
    });
  });
});
