import React from 'react';
import { Alert, Keyboard, Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuickCaptureSheet } from './quick-capture-sheet';

const selectedAreaIdForNewTasksMock = vi.hoisted(() => ({ current: undefined as string | null | undefined }));

const {
  addTask,
  addTasks,
  addProject,
  updateSettings,
  showToast,
  openTaskScreen,
  getUsedTaskTokens,
  getDerivedState,
  parseQuickAdd,
  splitQuickAddBulkLines,
  selectStore,
  documentPickerGetDocumentAsync,
  fileSystemReadAsStringAsync,
} = vi.hoisted(() => {
  const addTask = vi.fn();
  const addTasks = vi.fn();
  const addProject = vi.fn();
  const updateSettings = vi.fn();
  const showToast = vi.fn();
  const openTaskScreen = vi.fn();
  const getUsedTaskTokens = vi.fn<() => string[]>(() => []);
  const getDerivedState = vi.fn(() => ({ focusedCount: 0 }));
  const parseQuickAdd = vi.fn<(input: string) => any>((input: string) => ({
    title: input,
    props: {},
    invalidDateCommands: [],
  }));
  const splitQuickAddBulkLines = vi.fn((input: string) => input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean));
  const documentPickerGetDocumentAsync = vi.fn();
  const fileSystemReadAsStringAsync = vi.fn();
  const storeState = {
    addTask,
    addTasks,
    addProject,
    updateSettings,
    areas: [],
    projects: [],
    settings: {},
    tasks: [],
    getDerivedState,
  };
  const selectStore = ((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  )) as any;
  selectStore.getState = () => storeState;
  return {
    addTask,
    addTasks,
    addProject,
    updateSettings,
    showToast,
    openTaskScreen,
    getUsedTaskTokens,
    getDerivedState,
    parseQuickAdd,
    splitQuickAddBulkLines,
    selectStore,
    documentPickerGetDocumentAsync,
    fileSystemReadAsStringAsync,
  };
});

vi.mock('@mindwtr/core', () => ({
  DEFAULT_PROJECT_COLOR: '#3B82F6',
  getDefaultTaskAreaMode: (settings: any) => {
    const mode = settings?.gtd?.defaultAreaMode;
    if (mode === 'none' || mode === 'fixed' || mode === 'active') return mode;
    return settings?.gtd?.defaultAreaId ? 'fixed' : 'none';
  },
  getQuickAddProjectInitialProps: (props: any, fallbackAreaId?: string | null) => {
    const areaId = props?.areaId || fallbackAreaId || undefined;
    return areaId ? { areaId } : undefined;
  },
  getUsedTaskTokens,
  formatFocusTaskLimitText: (template: string, limit: number) => template.replace('{{count}}', String(limit)),
  hasTimeComponent: (value?: string | null) => Boolean(value && /[T\s]\d{2}:\d{2}/.test(value)),
  isSelectableProjectForTaskAssignment: (project: any) => (
    !project.deletedAt && project.status !== 'archived' && project.status !== 'completed'
  ),
  parseQuickAdd,
  normalizeClockTimeInput: (value?: string | null) => String(value ?? '').trim(),
  normalizeFocusTaskLimit: (value: unknown) => (typeof value === 'number' ? value : 3),
  resolveDefaultNewTaskAreaId: (settings: any, areas: any[]) => {
    const mode = settings?.gtd?.defaultAreaMode ?? (settings?.gtd?.defaultAreaId ? 'fixed' : 'none');
    if (mode !== 'fixed') return undefined;
    const areaId = settings?.gtd?.defaultAreaId;
    return typeof areaId === 'string' && areas.some((area) => area.id === areaId && !area.deletedAt)
      ? areaId
      : undefined;
  },
  splitQuickAddBulkLines,
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
  shallow: (left: unknown, right: unknown) => left === right,
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  },
  useTaskStore: selectStore,
}));

const mockThemeTokens = vi.hoisted(() => ({
  value: { isMaterial: false, roles: null, shape: { large: 16 } } as {
    isMaterial: boolean;
    roles: Record<string, string> | null;
    shape: { large: number };
  },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: documentPickerGetDocumentAsync,
}));

vi.mock('expo-file-system', () => ({
  readAsStringAsync: fileSystemReadAsStringAsync,
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
      'agenda.addToFocus': "Add to today's focus",
      'agenda.maxFocusItems': 'Max {{count}} focus items',
      'agenda.removeFromFocus': 'Remove from focus',
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
  useMobileAreaFilter: () => ({ selectedAreaIdForNewTasks: selectedAreaIdForNewTasksMock.current }),
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

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => mockThemeTokens.value,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openTaskScreen,
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

const withPlatform = async (os: typeof Platform.OS, run: () => Promise<void>) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    await run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

describe('QuickCaptureSheet save handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    addTask.mockReset();
    addProject.mockReset();
    updateSettings.mockReset();
    showToast.mockReset();
    selectStore.getState().areas = [];
    selectStore.getState().projects = [];
    selectStore.getState().tasks = [];
    selectStore.getState().settings = {};
    selectedAreaIdForNewTasksMock.current = undefined;
    getDerivedState.mockClear();
    getDerivedState.mockReturnValue({ focusedCount: 0 });
    getUsedTaskTokens.mockClear();
    getUsedTaskTokens.mockReturnValue([]);
    documentPickerGetDocumentAsync.mockReset();
    fileSystemReadAsStringAsync.mockReset();
    parseQuickAdd.mockReset();
    parseQuickAdd.mockImplementation((input: string) => ({
      title: input,
      props: {},
      invalidDateCommands: [],
    }));
    mockThemeTokens.value = { isMaterial: false, roles: null, shape: { large: 16 } };
  });

  it('uses primaryContainer for the save button under Material, below the high-emphasis capture FAB', async () => {
    mockThemeTokens.value = {
      isMaterial: true,
      roles: { primaryContainer: '#00458B', onPrimaryContainer: '#D7E2FF' },
      shape: { large: 16 },
    };

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.saveButtonBackgroundColor).toBe('#00458B');
    expect(body.props.saveButtonTextColor).toBe('#D7E2FF');
  });

  it('keeps the save button on the primary tint under non-Material themes', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet visible openRequestId={1} initialValue="" onClose={vi.fn()} />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.saveButtonBackgroundColor).toBe('#3b82f6');
    expect(body.props.saveButtonTextColor).toBeUndefined();
  });

  it('opens organize options collapsed for global capture', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    expect(body.props.optionsExpanded).toBe(false);
    expect(getUsedTaskTokens).not.toHaveBeenCalled();
  });

  it('keeps the sheet lifted until the Android keyboard finishes hiding, then expands', async () => {
    vi.useFakeTimers();
    const keyboardDismiss = vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const hideListeners: (() => void)[] = [];
    const showListeners: (() => void)[] = [];
    const removeListener = vi.fn();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
      if (event === 'keyboardDidHide') hideListeners.push(cb);
      if (event === 'keyboardDidShow') showListeners.push(cb);
      return { remove: removeListener };
    }) as unknown as typeof Keyboard.addListener);

    await withPlatform('android', async () => {
      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(
          <QuickCaptureSheet
            visible
            openRequestId={1}
            initialValue=""
            onClose={vi.fn()}
          />
        );
        await Promise.resolve();
      });

      const getBody = () => {
        const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
        if (!body) throw new Error('QuickCaptureSheetBody not found');
        return body;
      };

      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      const focus = vi.fn();
      const blur = vi.fn();
      getBody().props.inputRef.current = { blur, focus };

      // Ignore the baseline keyboard-inset listeners registered on mount; this
      // test only cares about the keyboardDidHide gate the More toggle adds.
      hideListeners.length = 0;
      showListeners.length = 0;

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      // The keyboard is dismissed, but the lift must stay on and the sheet must
      // stay collapsed until the keyboard is actually gone. Dropping the lift now
      // would slam the sheet behind the still-visible keyboard (the flicker).
      expect(keyboardDismiss).toHaveBeenCalledOnce();
      expect(blur).toHaveBeenCalledOnce();
      expect(hideListeners).toHaveLength(1);
      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      // A premature timer must not expand the sheet on its own; only the keyboard
      // hide event (or the far safety-net) may.
      await act(async () => {
        vi.advanceTimersByTime(160);
        await Promise.resolve();
      });
      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      // Keyboard finished hiding: now expand and drop the lift together.
      await act(async () => {
        hideListeners.forEach((cb) => cb());
        await Promise.resolve();
      });

      expect(focus).not.toHaveBeenCalled();
      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(false);
      expect(removeListener).toHaveBeenCalled();
      expect(showListeners).toHaveLength(1);

      await act(async () => {
        showListeners.forEach((cb) => cb());
        await Promise.resolve();
      });

      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      expect(getBody().props.optionsExpanded).toBe(false);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(true);
    });
  });

  it('expands Android organize options immediately when the keyboard is already hidden', async () => {
    vi.useFakeTimers();
    vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    const addListener = vi.spyOn(Keyboard, 'addListener');

    await withPlatform('android', async () => {
      let tree!: ReturnType<typeof create>;
      await act(async () => {
        tree = create(
          <QuickCaptureSheet
            visible
            openRequestId={1}
            initialValue=""
            onClose={vi.fn()}
          />
        );
        await Promise.resolve();
      });

      const getBody = () => {
        const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
        if (!body) throw new Error('QuickCaptureSheetBody not found');
        return body;
      };

      getBody().props.inputRef.current = { blur: vi.fn(), focus: vi.fn() };

      // Drop the baseline keyboard-inset listeners registered on mount so we can
      // assert the More toggle adds only the refocus guard.
      addListener.mockClear();

      await act(async () => {
        getBody().props.onToggleOptions();
        await Promise.resolve();
      });

      expect(addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
      expect(getBody().props.optionsExpanded).toBe(true);
      expect(getBody().props.keyboardAvoidingEnabled).toBe(false);
    });
  });

  it('loads context autocomplete only after the context picker opens', async () => {
    vi.useFakeTimers();
    getUsedTaskTokens.mockReturnValue(['@computer']);

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).not.toHaveBeenCalled();

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.onOpenContextPicker();
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(getUsedTaskTokens).toHaveBeenCalledTimes(1);
    const pickers = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetPickers')[0];
    if (!pickers) throw new Error('QuickCaptureSheetPickers not found');
    expect(pickers.props.filteredContexts).toEqual(['@computer']);
    expect(pickers.props.contextOptionsLoading).toBe(false);
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

  it("stars a task for Today's Focus from the capture sheet", async () => {
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="File Q3 estimated tax payment"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    expect(body.props.focusNewTask).toBe(false);

    await act(async () => {
      body.props.onToggleFocusNewTask();
      await Promise.resolve();
    });

    const updatedBody = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!updatedBody) throw new Error('QuickCaptureSheetBody not found after toggle');
    expect(updatedBody.props.focusNewTask).toBe(true);

    await act(async () => {
      updatedBody.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('File Q3 estimated tax payment', expect.objectContaining({
      status: 'inbox',
      isFocusedToday: true,
    }));
  });

  it('confirms multiline capture before creating one task per line', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockImplementation((input: string) => ({
      title: input.replace(/\s+\/next$/u, ''),
      props: input.endsWith('/next') ? { status: 'next' } : {},
      invalidDateCommands: [],
    }));

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue={'Email Bob\n\nCall Alice /next'}
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
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
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(addTasks).toHaveBeenCalledWith([
      { title: 'Email Bob', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Call Alice', initialProps: expect.objectContaining({ status: 'next' }) },
    ]);
  });

  it('imports a text file through the bulk capture confirmation', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(vi.fn());
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    documentPickerGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: 'tasks.txt', uri: 'file://tasks.txt', mimeType: 'text/plain' }],
    });
    fileSystemReadAsStringAsync.mockResolvedValue('First imported task\nSecond imported task\n');

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue=""
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      await body.props.handleImportTextFile();
      await Promise.resolve();
    });

    expect(documentPickerGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({
      multiple: false,
      type: 'text/plain',
    }));
    expect(fileSystemReadAsStringAsync).toHaveBeenCalledWith('file://tasks.txt');
    expect(alertSpy).toHaveBeenCalledWith(
      'Create 2 tasks?',
      expect.stringContaining('First imported task'),
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void | Promise<void> }>;
    const confirm = buttons.find((button) => button.text === 'Create tasks');
    if (!confirm?.onPress) throw new Error('Confirm button not found');

    await act(async () => {
      await confirm.onPress?.();
      await Promise.resolve();
    });

    expect(addTask).not.toHaveBeenCalled();
    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(addTasks).toHaveBeenCalledWith([
      { title: 'First imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
      { title: 'Second imported task', initialProps: expect.objectContaining({ status: 'inbox' }) },
    ]);
  });

  it('opens the created task when save and edit is requested', async () => {
    addTask.mockResolvedValueOnce({ success: true, id: 'task-new' });
    const onClose = vi.fn();
    selectStore.getState().projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Draft launch brief"
          initialProps={{ projectId: 'project-1', status: 'next' }}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');
    await act(async () => {
      body.props.handleSaveAndEdit();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Draft launch brief', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openTaskScreen).toHaveBeenCalledWith('task-new', 'project-1', 'task');
  });

  it('uses the selected area filter for new captures in active area mode', async () => {
    selectedAreaIdForNewTasksMock.current = 'area-work';
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Area-filtered task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Area-filtered task', expect.objectContaining({
      areaId: 'area-work',
      status: 'inbox',
    }));
  });

  it('uses the fixed GTD default area before the selected area filter in fixed area mode', async () => {
    selectedAreaIdForNewTasksMock.current = 'area-work';
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'area-work', name: 'Work', order: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Fixed-default task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Fixed-default task', expect.objectContaining({
      areaId: 'area-home',
      status: 'inbox',
    }));
  });

  it('does not apply the GTD default area while the no-area filter is active', async () => {
    selectedAreaIdForNewTasksMock.current = null;
    selectStore.getState().areas = [
      { id: 'area-home', name: 'Home', order: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
    ];
    selectStore.getState().settings = { gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' } };
    addTask.mockResolvedValue({ success: true, id: 'task-1' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="No-area task"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    const savedProps = addTask.mock.calls[0]?.[1] as { areaId?: string } | undefined;
    expect(savedProps?.areaId).toBeUndefined();
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

  it('creates parsed quick-add projects inside the parsed area', async () => {
    addProject.mockResolvedValue({ id: 'project-launch' });
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    parseQuickAdd.mockReturnValue({
      title: 'Plan campaign',
      props: { areaId: 'area-work' },
      projectTitle: 'Launch',
      invalidDateCommands: [],
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="Plan campaign +Launch !Work"
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
    if (!body) throw new Error('QuickCaptureSheetBody not found');

    await act(async () => {
      body.props.handleSave();
      await Promise.resolve();
    });

    expect(addProject).toHaveBeenCalledWith('Launch', '#3B82F6', { areaId: 'area-work' });
    expect(addTask).toHaveBeenCalledWith('Plan campaign', expect.objectContaining({
      projectId: 'project-launch',
      areaId: undefined,
    }));
  });

  it('keeps project initial props when saving and adding another', async () => {
    selectStore.getState().projects = [{
      id: 'project-1',
      title: 'Launch',
      status: 'active',
    }];
    addTask.mockResolvedValue({ success: true, id: 'task-1' });
    const onClose = vi.fn();

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <QuickCaptureSheet
          visible
          openRequestId={1}
          initialValue="First task"
          initialProps={{ projectId: 'project-1', status: 'next' }}
          onClose={onClose}
        />
      );
      await Promise.resolve();
    });

    const getBody = () => {
      const body = tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheetBody')[0];
      if (!body) throw new Error('QuickCaptureSheetBody not found');
      return body;
    };

    await act(async () => {
      getBody().props.onToggleAddAnother(true);
      await Promise.resolve();
    });

    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('First task', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(getBody().props.value).toBe('');
    expect(getBody().props.projectLabel).toBe('Launch');
    expect(getBody().props.projectSelected).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      getBody().props.onValueChange('Second task');
      await Promise.resolve();
    });
    await act(async () => {
      getBody().props.handleSave();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenLastCalledWith('Second task', expect.objectContaining({
      projectId: 'project-1',
      status: 'next',
    }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
