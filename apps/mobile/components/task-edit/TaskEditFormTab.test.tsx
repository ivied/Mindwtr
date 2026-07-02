import React from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskEditFormTab } from './TaskEditFormTab';

const mockScrollTo = vi.hoisted(() => vi.fn());
const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 9001));
const mockMeasureInWindow = vi.hoisted(() => vi.fn());

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  const ReactModule = await import('react');
  return {
    ...actual,
    findNodeHandle: mockFindNodeHandle,
    ScrollView: ReactModule.forwardRef((props: any, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
      return ReactModule.createElement('ScrollView', props, props.children);
    }),
    UIManager: {
      ...((actual as any).UIManager ?? {}),
      measureInWindow: mockMeasureInWindow,
    },
  };
});

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    border: '#333',
    secondaryText: '#aaa',
    text: '#fff',
    tint: '#3b82f6',
  }),
}));

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
};

const baseProps = {
  t: (key: string) => key,
  tc: {
    bg: '#000',
    cardBg: '#111',
    taskItemBg: '#111',
    inputBg: '#111',
    filterBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    icon: '#aaa',
    tint: '#3b82f6',
    onTint: '#fff',
    tabIconDefault: '#aaa',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  },
  styles: {
    tabPage: {},
    content: {},
    contentContainer: { paddingBottom: 32, flexGrow: 1 },
    formGroup: {},
    label: {},
    input: {},
    aiRow: {},
    aiButton: {},
    aiButtonText: {},
    aiWorking: {},
    aiWorkingText: {},
    copilotPill: {},
    copilotText: {},
    copilotHint: {},
    emptySectionHint: {},
    emptySectionHintText: {},
  },
  inputStyle: {},
  editedTask: {},
  setEditedTask: vi.fn(),
  aiEnabled: false,
  isAIWorking: false,
  handleAIClarify: vi.fn(),
  handleAIBreakdown: vi.fn(),
  copilotSuggestion: null,
  copilotApplied: false,
  applyCopilotSuggestion: vi.fn(),
  copilotContext: undefined,
  copilotEstimate: undefined,
  copilotTags: [],
  timeEstimatesEnabled: true,
  renderField: vi.fn(),
  basicFields: [],
  schedulingFields: [],
  organizationFields: [],
  detailsFields: [],
  sectionOpenDefaults: {
    basic: true,
    scheduling: false,
    organization: false,
    details: false,
  },
  showDatePicker: null,
  pendingStartDate: null,
  pendingDueDate: null,
  getSafePickerDateValue: vi.fn(() => new Date('2025-01-01T00:00:00.000Z')),
  onDateChange: vi.fn(),
  containerWidth: 390,
  textDirectionStyle: {},
  titleDraft: 'Task',
  onTitleDraftChange: vi.fn(),
};

const findScrollContainer = (tree: ReturnType<typeof create>) =>
  tree.root.findByType(ScrollView);

describe('TaskEditFormTab keyboard handling', () => {
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
    vi.restoreAllMocks();
    mockScrollTo.mockReset();
    mockFindNodeHandle.mockClear();
    mockMeasureInWindow.mockReset();
  });

  it('does not render collapsible sections that have no fields', () => {
    const renderField = vi.fn((fieldId: string) => React.createElement('Field', { fieldId }));

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          renderField={renderField}
          schedulingFields={[]}
          organizationFields={['project' as any]}
          detailsFields={[]}
        />
      );
    });

    const sectionHeaders = (label: string) => tree.root.findAll(
      (node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label
    );

    expect(sectionHeaders('taskEdit.scheduling')).toHaveLength(0);
    expect(sectionHeaders('taskEdit.organization').length).toBeGreaterThan(0);
    expect(sectionHeaders('taskEdit.details')).toHaveLength(0);
    expect(renderField).toHaveBeenCalledWith('project');
  });

  it('adds an iOS keyboard bottom inset so focused lower inputs can scroll above the keyboard', () => {
    setPlatform('ios');
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 800,
      scale: 3,
      fontScale: 1,
    });
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskEditFormTab {...baseProps} />);
    });

    expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBeUndefined();
    expect(findScrollContainer(tree).props.keyboardDismissMode).toBe('interactive');
    expect(listeners.has('keyboardWillShow')).toBe(true);
    expect(listeners.has('keyboardWillChangeFrame')).toBe(true);
    expect(listeners.has('keyboardWillHide')).toBe(true);

    act(() => {
      listeners.get('keyboardWillShow')?.({ endCoordinates: { screenY: 500 } });
    });

    expect(findScrollContainer(tree).props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 332 })])
    );

    act(() => {
      listeners.get('keyboardWillHide')?.();
    });

    expect(findScrollContainer(tree).props.contentContainerStyle).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 332 })])
    );
  });

  it('keeps Android height-based keyboard avoidance', () => {
    setPlatform('android');
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 800,
      scale: 3,
      fontScale: 1,
    });
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskEditFormTab {...baseProps} />);
    });

    expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
    expect(findScrollContainer(tree).props.keyboardDismissMode).toBe('on-drag');
    expect(findScrollContainer(tree).props.scrollsChildToFocus).toBe(false);
    expect(listeners.has('keyboardDidShow')).toBe(true);
    expect(listeners.has('keyboardDidChangeFrame')).toBe(true);
    expect(listeners.has('keyboardDidHide')).toBe(true);

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520 } });
    });

    expect(findScrollContainer(tree).props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 312 })])
    );
  });

  it('tracks title focus without forcing fallback scrolling when no native handle is reported', () => {
    const onTitleInputFocusChange = vi.fn();
    const onInputFocusTracked = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          onInputFocusTracked={onInputFocusTracked}
          onTitleInputFocusChange={onTitleInputFocusChange}
        />
      );
    });

    const titleInput = tree.root.findAllByType(TextInput)[0];

    act(() => {
      titleInput.props.onFocus({ nativeEvent: {} });
    });

    expect(onInputFocusTracked).toHaveBeenCalledWith(undefined);
    expect(onTitleInputFocusChange).toHaveBeenCalledWith(true);

    act(() => {
      titleInput.props.onBlur();
    });

    expect(onTitleInputFocusChange).toHaveBeenCalledWith(false);
  });

  it('wraps the title across lines and strips newlines from pasted titles', () => {
    const onTitleDraftChange = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab {...baseProps} onTitleDraftChange={onTitleDraftChange} />
      );
    });

    const titleInput = tree.root.findAllByType(TextInput)[0];
    expect(titleInput.props.multiline).toBe(true);

    act(() => {
      titleInput.props.onChangeText('line one\nline two');
    });

    expect(onTitleDraftChange).toHaveBeenCalledWith('line one line two');
  });

  it('does not schedule measured scrolling when the title input reports a native handle', () => {
    setPlatform('ios');
    const onTitleInputFocusChange = vi.fn();
    const onInputFocusTracked = vi.fn();
    const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          onInputFocusTracked={onInputFocusTracked}
          onTitleInputFocusChange={onTitleInputFocusChange}
        />
      );
    });

    requestAnimationFrameSpy.mockClear();

    const titleInput = tree.root.findAllByType(TextInput)[0];

    act(() => {
      titleInput.props.onFocus({ nativeEvent: { target: 42 } });
    });

    expect(onInputFocusTracked).toHaveBeenCalledWith(undefined);
    expect(onTitleInputFocusChange).toHaveBeenCalledWith(true);
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });

  it('does not run measured Android scrolling before keyboard metrics settle', () => {
    setPlatform('android');
    const registeredHandlers: Array<((targetInput?: number | string) => void) | null> = [];
    const requestAnimationFrameSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          registerScrollToEnd={(handler) => {
            registeredHandlers.push(handler);
          }}
        />
      );
    });

    requestAnimationFrameSpy.mockClear();

    act(() => {
      registeredHandlers.at(-1)?.(42);
    });

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
  });

  it('does not auto-scroll Android upward from stale focused-input measurements', () => {
    setPlatform('android');
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 800,
      scale: 3,
      fontScale: 1,
    });
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);
    mockFindNodeHandle.mockReturnValue(9001);
    mockMeasureInWindow.mockImplementation(((handle: number, callback: any) => {
      if (handle === 42) {
        callback(0, 260, 320, 40);
        return;
      }
      callback(0, 300, 390, 600);
    }) as any);
    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation(((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }) as any);
    const registeredHandlers: Array<((targetInput?: number | string) => void) | null> = [];
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          registerScrollToEnd={(handler) => {
            registeredHandlers.push(handler);
          }}
        />
      );
    });

    mockScrollTo.mockClear();
    requestAnimationFrameSpy.mockClear();

    act(() => {
      findScrollContainer(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 420 } } });
      listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520 } });
      registeredHandlers.at(-1)?.(42);
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalled();
    expect(mockMeasureInWindow).toHaveBeenCalled();
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it('scrolls Android focused inputs by the measured overlap with the keyboard', () => {
    setPlatform('android');
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 800,
      scale: 3,
      fontScale: 1,
    });
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);
    mockFindNodeHandle.mockReturnValue(9001);
    const targetY = 700;
    const targetH = 60;
    const scrollY = 0;
    const scrollH = 800;
    const keyboardTop = 520;
    mockMeasureInWindow.mockImplementation(((handle: number, callback: any) => {
      if (handle === 42) {
        callback(0, targetY, 320, targetH);
        return;
      }
      callback(0, scrollY, 390, scrollH);
    }) as any);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as any);
    const registeredHandlers: Array<((targetInput?: number | string) => void) | null> = [];
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          registerScrollToEnd={(handler) => {
            registeredHandlers.push(handler);
          }}
        />
      );
    });
    mockScrollTo.mockClear();

    act(() => {
      findScrollContainer(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 420 } } });
      registeredHandlers.at(-1)?.(42);
    });

    expect(mockScrollTo).not.toHaveBeenCalled();

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: keyboardTop } });
      registeredHandlers.at(-1)?.(42);
    });

    const visibleBottom = Math.min(scrollY + scrollH, keyboardTop);
    const visibleTop = scrollY;
    const visibleHeight = visibleBottom - visibleTop;
    const bottomClearance = visibleHeight * 0.18;
    const measuredOverlap = (targetY + targetH) - (visibleBottom - bottomClearance);
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 420 + measuredOverlap, animated: true });
  });

  it('ignores stale string keyboard targets instead of applying a fixed Android scroll', () => {
    setPlatform('android');
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 800,
      scale: 3,
      fontScale: 1,
    });
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);
    const registeredHandlers: Array<((targetInput?: number | string) => void) | null> = [];
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          registerScrollToEnd={(handler) => {
            registeredHandlers.push(handler);
          }}
        />
      );
    });

    act(() => {
      findScrollContainer(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } });
      registeredHandlers.at(-1)?.('description-end-keyboard-scroll');
    });

    expect(mockScrollTo).not.toHaveBeenCalled();

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520 } });
      registeredHandlers.at(-1)?.('description-end-keyboard-scroll');
    });

    expect(mockMeasureInWindow).not.toHaveBeenCalled();
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it('renders a configured mobile location field in the details section', () => {
    const renderField = vi.fn((fieldId) => (
      <TextInput accessibilityLabel={fieldId} value={`field:${fieldId}`} />
    ));
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          detailsFields={['location']}
          renderField={renderField}
          sectionOpenDefaults={{ ...baseProps.sectionOpenDefaults, details: true }}
        />
      );
    });

    const inputs = tree.root.findAllByType(TextInput);
    const locationInput = inputs.find((input) => input.props.accessibilityLabel === 'location');

    expect(locationInput?.props.value).toBe('field:location');
    expect(renderField).toHaveBeenCalledWith('location');
  });

  it('keeps empty detail fields collapsed by default', () => {
    const renderField = vi.fn((fieldId) => (
      <TextInput accessibilityLabel={fieldId} value={`field:${fieldId}`} />
    ));
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          detailsFields={['description', 'checklist']}
          renderField={renderField}
        />
      );
    });

    const detailsHeader = tree.root.findAllByType(Pressable)
      .find((pressable) => pressable.props.accessibilityLabel === 'taskEdit.details');
    const renderedInputs = tree.root.findAllByType(TextInput);

    expect(detailsHeader?.props.accessibilityState).toMatchObject({ expanded: false });
    expect(renderedInputs.some((input) => input.props.accessibilityLabel === 'description')).toBe(false);
    expect(renderedInputs.some((input) => input.props.accessibilityLabel === 'checklist')).toBe(false);
  });

  it('opens details when a collapsed detail section contains task data', () => {
    const renderField = vi.fn((fieldId) => (
      <TextInput accessibilityLabel={fieldId} value={`field:${fieldId}`} />
    ));
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditFormTab
          {...baseProps}
          editedTask={{ description: 'Notes' }}
          detailsFields={['description']}
          renderField={renderField}
        />
      );
    });

    const detailsHeader = tree.root.findAllByType(Pressable)
      .find((pressable) => pressable.props.accessibilityLabel === 'taskEdit.details');

    expect(detailsHeader?.props.accessibilityState).toMatchObject({ expanded: true });
    expect(renderField).toHaveBeenCalledWith('description');
  });
});
