import React from 'react';
import { Platform, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTaskStore } from '@mindwtr/core';

import { TaskEditContentField } from './TaskEditContentField';

const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 314));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    findNodeHandle: mockFindNodeHandle,
  };
});

vi.mock('../markdown-reference-autocomplete', () => ({
  MarkdownReferenceAutocomplete: (props: any) => React.createElement('MarkdownReferenceAutocomplete', props),
}));

vi.mock('../markdown-text', () => ({
  MarkdownText: (props: any) => React.createElement('MarkdownText', props),
}));

const withPlatform = (os: typeof Platform.OS, run: () => void) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

const baseProps: any = {
  addFileAttachment: vi.fn(),
  addImageAttachment: vi.fn(),
  applyAssignedToSuggestion: vi.fn(),
  applyContextSuggestion: vi.fn(),
  applyTagSuggestion: vi.fn(),
  areas: [],
  assignedToSuggestions: [],
  availableStatusOptions: ['inbox', 'next', 'waiting', 'scheduled', 'someday', 'completed'],
  applyQuickDate: vi.fn(),
  commitContextDraft: vi.fn(),
  commitTagDraft: vi.fn(),
  contextInputDraft: '',
  contextTokenSuggestions: [],
  customWeekdays: [],
  dailyInterval: 1,
  descriptionDraft: '# Heading\n\nLong description',
  descriptionInputRef: React.createRef<TextInput>(),
  descriptionSelection: { start: 0, end: 0 },
  descriptionSelectionRestorePending: false,
  setDescriptionSelection: vi.fn(),
  descriptionToolbarInteractionUntilRef: { current: 0 },
  isDescriptionInputFocused: false,
  setIsDescriptionInputFocused: vi.fn(),
  handleDescriptionChange: vi.fn(),
  handleDescriptionKeyPress: vi.fn(),
  applyChecklistUpdate: vi.fn(),
  applyDescriptionResult: vi.fn(),
  openDescriptionExpandedEditor: vi.fn(),
  downloadAttachment: vi.fn(),
  editLinkAttachment: vi.fn(),
  editedTask: { id: 'task-1', title: 'Task' },
  formatDate: vi.fn((value) => value ?? ''),
  formatDueDate: vi.fn((value) => value ?? ''),
  frequentContextSuggestions: [],
  frequentTagSuggestions: [],
  getSafePickerDateValue: vi.fn(() => new Date('2025-01-01T00:00:00.000Z')),
  handleInputFocus: vi.fn(),
  handleResetChecklist: vi.fn(),
  language: 'en',
  monthlyPattern: 'date',
  onDateChange: vi.fn(),
  openAddLinkAttachment: vi.fn(),
  openAttachment: vi.fn(),
  openCustomRecurrence: vi.fn(),
  pendingDueDate: null,
  pendingStartDate: null,
  prioritiesEnabled: true,
  energyLevelOptions: [],
  priorityOptions: [],
  projects: [],
  projectSections: [],
  recurrenceOptions: [],
  recurrenceRRuleValue: '',
  recurrenceRuleValue: '',
  recurrenceStrategyValue: 'due',
  recurrenceWeekdayButtons: [],
  removeAttachment: vi.fn(),
  selectedContextTokens: new Set<string>(),
  selectedTagTokens: new Set<string>(),
  setCustomWeekdays: vi.fn(),
  setEditedTask: vi.fn(),
  setIsContextInputFocused: vi.fn(),
  setIsTagInputFocused: vi.fn(),
  setLinkInputTouched: vi.fn(),
  setLinkModalVisible: vi.fn(),
  setShowAreaPicker: vi.fn(),
  setShowDatePicker: vi.fn(),
  setShowDescriptionPreview: vi.fn(),
  setShowProjectPicker: vi.fn(),
  setShowSectionPicker: vi.fn(),
  showDatePicker: null,
  showDescriptionPreview: false,
  styles: {
    formGroup: {},
    inlineHeader: {},
    label: {},
    inlineActions: {},
    inlineAction: {},
    input: {},
    textArea: {},
    markdownPreview: {},
    checklistContainer: {},
    checklistHeader: {},
    checklistHeaderLabel: {},
    checklistHeaderButton: {},
    checklistHeaderButtonText: {},
    checklistItem: {},
    checklistOrderPanel: {},
    checklistOrderItem: {},
    checklistOrderTitle: {},
    checklistOrderControls: {},
    checklistOrderButton: {},
    checklistOrderButtonDisabled: {},
    checkboxTouch: {},
    checkbox: {},
    checkboxChecked: {},
    checkmark: {},
    checklistInput: {},
    completedText: {},
    deleteBtn: {},
    deleteBtnText: {},
    addChecklistBtn: {},
    addChecklistText: {},
    checklistActions: {},
    checklistActionButton: {},
    checklistActionText: {},
  },
  tagInputDraft: '',
  tagTokenSuggestions: [],
  task: null,
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
  timeEstimateOptions: [],
  timeEstimatesEnabled: true,
  titleDraft: 'Task',
  toggleQuickContextToken: vi.fn(),
  toggleQuickTagToken: vi.fn(),
  updateContextInput: vi.fn(),
  updateTagInput: vi.fn(),
  visibleAttachments: [],
};

const createChecklistState = (checklist = [{ id: 'check-1', title: 'Item 1', isCompleted: false }]) => {
  let state: any = {
    id: 'task-1',
    title: 'Task',
    checklist,
  };
  const setEditedTask = vi.fn((next: any) => {
    state = typeof next === 'function' ? next(state) : next;
  });
  const applyChecklistUpdate = vi.fn((nextChecklist: any) => {
    state = { ...state, checklist: nextChecklist };
  });
  return {
    getState: () => state,
    applyChecklistUpdate,
    setEditedTask,
  };
};

describe('TaskEditContentField', () => {
  afterEach(() => {
    useTaskStore.setState({ settings: {} });
  });

  it('registers the iOS description input as a keyboard auto-scroll target', () => {
    const handleInputFocus = vi.fn();
    const setIsDescriptionInputFocused = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('ios', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            handleInputFocus={handleInputFocus}
            setIsDescriptionInputFocused={setIsDescriptionInputFocused}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(setIsDescriptionInputFocused).toHaveBeenCalledWith(true);
      expect(handleInputFocus).toHaveBeenCalledWith(42);
    });
  });

  it('registers the Android description header as the focus scroll target', () => {
    const handleInputFocus = vi.fn();
    const setIsDescriptionInputFocused = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            handleInputFocus={handleInputFocus}
            setIsDescriptionInputFocused={setIsDescriptionInputFocused}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(setIsDescriptionInputFocused).toHaveBeenCalledWith(true);
      expect(mockFindNodeHandle).toHaveBeenCalled();
      expect(handleInputFocus).toHaveBeenCalledWith(314);
      expect(handleInputFocus).not.toHaveBeenCalledWith(42);
    });
  });

  it('does not nudge Android keyboard scrolling when the inline description caret reaches the end', () => {
    const descriptionDraft = 'First line\nLast line';
    const handleInputFocus = vi.fn();
    const setDescriptionSelection = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionDraft={descriptionDraft}
            isDescriptionInputFocused
            handleInputFocus={handleInputFocus}
            setDescriptionSelection={setDescriptionSelection}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });
      const endSelection = { start: descriptionDraft.length, end: descriptionDraft.length };

      act(() => {
        input.props.onSelectionChange({ nativeEvent: { selection: endSelection } });
      });

      expect(setDescriptionSelection).toHaveBeenCalledWith(endSelection);
      expect(handleInputFocus).toHaveBeenCalledWith(undefined);
      expect(handleInputFocus).not.toHaveBeenCalledWith('description-end-keyboard-scroll');
    });
  });

  it('does not nudge Android keyboard scrolling for middle description taps', () => {
    const descriptionDraft = [
      'Intro line',
      '[First link](https://example.com/first)',
      '[Second link](https://example.com/second)',
      '[Third link](https://example.com/third)',
      'Last line',
    ].join('\n');
    const handleInputFocus = vi.fn();
    const setDescriptionSelection = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionDraft={descriptionDraft}
            isDescriptionInputFocused
            handleInputFocus={handleInputFocus}
            setDescriptionSelection={setDescriptionSelection}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });
      const middleSelection = { start: descriptionDraft.indexOf('Second'), end: descriptionDraft.indexOf('Second') };

      act(() => {
        input.props.onSelectionChange({ nativeEvent: { selection: middleSelection } });
      });

      expect(setDescriptionSelection).toHaveBeenCalledWith(middleSelection);
      expect(handleInputFocus).toHaveBeenCalledWith(undefined);
      expect(handleInputFocus).not.toHaveBeenCalledWith('description-end-keyboard-scroll');
    });
  });

  it('keeps the Android description editor in plain-text spellcheck mode', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="description"
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

    expect(input.props.spellCheck).toBe(true);
    expect(input.props.autoCorrect).toBe(true);
    expect(input.props.autoCapitalize).toBe('sentences');
    expect(input.props.autoComplete).toBe('off');
    expect(input.props.importantForAutofill).toBe('no');
    expect(input.props.inputMode).toBe('text');
    expect(input.props.textContentType).toBe('none');
    expect(input.props.keyboardType).toBe('default');
  });

  it('temporarily controls Android description selection during caret restoration', () => {
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionSelection={{ start: 9, end: 9 }}
            descriptionSelectionRestorePending
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      expect(input.props.selection).toEqual({ start: 9, end: 9 });
    });
  });

  it('wraps selected checklist item text from mobile key presses', () => {
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
    });

    const preventDefault = vi.fn();
    act(() => {
      input.props.onKeyPress({ nativeEvent: { key: '[' }, preventDefault });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(getState().checklist[0].title).toBe('[Item 1]');

    const callsAfterKeyPress = applyChecklistUpdate.mock.calls.length;
    act(() => {
      input.props.onChangeText('[');
    });

    expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterKeyPress);
  });

  it('leaves checklist key presses to native text input when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
    });

    const preventDefault = vi.fn();
    act(() => {
      input.props.onKeyPress({ nativeEvent: { key: '[' }, preventDefault });
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(getState().checklist[0].title).toBe('Item 1');

    act(() => {
      input.props.onChangeText('[');
    });

    expect(getState().checklist[0].title).toBe('[');
  });

  it('keeps Android checklist cursor inside a collapsed pair and ignores duplicate native insertion', () => {
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="checklist"
            editedTask={getState()}
            applyChecklistUpdate={applyChecklistUpdate}
            setEditedTask={setEditedTask}
          />
        );
      });

      let input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

      const preventDefault = vi.fn();
      act(() => {
        input.props.onKeyPress({ nativeEvent: { key: '(' }, preventDefault });
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(getState().checklist[0].title).toBe('()');

      input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
      expect(input.props.selection).toEqual({ start: 1, end: 1 });

      const callsAfterKeyPress = applyChecklistUpdate.mock.calls.length;
      act(() => {
        input.props.onChangeText('(');
      });

      expect(getState().checklist[0].title).toBe('()');
      expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterKeyPress);

      input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
      act(() => {
        input.props.onChangeText('(())');
      });

      expect(getState().checklist[0].title).toBe('()');
      expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterKeyPress);
    });
  });

  it('tracks the focused Android checklist row handle for measured scrolling', () => {
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState();
    const handleInputFocus = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="checklist"
            editedTask={getState()}
            applyChecklistUpdate={applyChecklistUpdate}
            handleInputFocus={handleInputFocus}
            setEditedTask={setEditedTask}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(handleInputFocus).toHaveBeenCalledWith(42);
    });
  });

  it('does not add another blank checklist item while one is already empty', () => {
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const addItem = tree.root.findByProps({ testID: 'mobile-checklist-add-item' });

    act(() => {
      addItem.props.onPress();
      addItem.props.onPress();
    });

    expect(applyChecklistUpdate).not.toHaveBeenCalled();
  });

  it('wraps selected checklist item text from native mobile text changes', () => {
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
      input.props.onChangeText('~');
    });

    expect(getState().checklist[0].title).toBe('~~Item 1~~');
  });

  it('keeps native checklist text changes plain when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
      input.props.onChangeText('~');
    });

    expect(getState().checklist[0].title).toBe('~');
  });

  it('orders checklist items from compact mobile order controls', () => {
    const checklist = [
      { id: 'check-1', title: 'Item 1', isCompleted: false },
      { id: 'check-2', title: 'Item 2', isCompleted: false },
      { id: 'check-3', title: 'Item 3', isCompleted: true },
    ];
    const { getState, applyChecklistUpdate, setEditedTask } = createChecklistState(checklist);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          editedTask={getState()}
          applyChecklistUpdate={applyChecklistUpdate}
          setEditedTask={setEditedTask}
        />
      );
    });

    const orderToggle = tree.root.findByProps({ testID: 'mobile-checklist-order-toggle' });

    act(() => {
      orderToggle.props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'mobile-checklist-order-panel' })).toBeTruthy();

    const moveFirstDown = tree.root.findByProps({ testID: 'mobile-checklist-move-down-check-1' });

    act(() => {
      moveFirstDown.props.onPress();
    });

    expect(getState().checklist.map((item: any) => item.id)).toEqual([
      'check-2',
      'check-1',
      'check-3',
    ]);
  });
});
