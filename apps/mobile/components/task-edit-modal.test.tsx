import React from 'react';
import { Alert, Text } from 'react-native';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { TaskEditModal } from './task-edit-modal';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { syncTaskEditPagerPosition } from './task-edit/task-edit-modal.utils';

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const storeState = {
    tasks: [],
    projects: [{
      id: 'project-1',
      title: 'Project',
      status: 'active',
      color: '#3b82f6',
      order: 0,
      tagIds: [],
      areaId: 'area-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }],
    sections: [],
    areas: [],
    settings: { features: {}, ai: {}, gtd: { taskEditor: { order: [], hidden: [] } } },
    duplicateTask: vi.fn(),
    resetTaskChecklist: vi.fn(),
    addProject: vi.fn(),
    addSection: vi.fn(),
    addArea: vi.fn(),
    deleteTask: vi.fn(),
  };
  const useTaskStore = Object.assign(() => storeState, {
    getState: () => storeState,
  });
  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
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
  }),
}));

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
  buildCopilotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('./task-edit/TaskEditViewTab', () => ({
  TaskEditViewTab: (props: any) => React.createElement('TaskEditViewTab', props),
}));

vi.mock('./task-edit/TaskEditFormTab', () => ({
  TaskEditFormTab: (props: any) => React.createElement('TaskEditFormTab', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn(),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
  },
}));

vi.mock('react-native-draggable-flatlist', () => ({
  NestableDraggableFlatList: (props: any) => React.createElement('NestableDraggableFlatList', props, props.children),
  NestableScrollContainer: (props: any) => React.createElement('NestableScrollContainer', props, props.children),
  ScaleDecorator: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('./task-edit/task-edit-modal.utils', async () => {
  const actual = await vi.importActual<typeof import('./task-edit/task-edit-modal.utils')>('./task-edit/task-edit-modal.utils');
  return {
    ...actual,
    syncTaskEditPagerPosition: vi.fn(),
  };
});

describe('TaskEditModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(syncTaskEditPagerPosition).mockClear();
  });

  it('renders without crashing', () => {
    expect(() => {
      act(() => {
        renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
        );
      });
    }).not.toThrow();
  });

  it('passes the project field to the mobile form tab', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
    });

    const formTab = tree!.root.find((node) => Array.isArray(node.props.basicFields));

    expect(formTab.props.basicFields).toContain('project');
  });

  it('closes immediately when there are no pending changes', () => {
    const onClose = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={vi.fn()}
        />
      );
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    expect(modal).toBeTruthy();

    const alertSpy = vi.spyOn(Alert, 'alert');
    act(() => {
      modal!.props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('prompts before closing when there are unsaved changes and can discard them', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      modal!.props.onRequestClose();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];
    expect(Array.isArray(buttons)).toBe(true);
    expect(buttons.map((button) => button.text)).toEqual([
      'common.cancel',
      'common.discard',
      'common.save',
    ]);

    act(() => {
      buttons[1]?.onPress?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('can save from the discard confirmation', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const modal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      modal!.props.onRequestClose();
    });

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];

    act(() => {
      buttons[2]?.onPress?.();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Changed task' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps quick-add-looking text literal when saving an existing task title', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    const literalTitle = 'Email @home #note +Home /due:tomorrow';
    act(() => {
      formTab.props.onTitleDraftChange(literalTitle);
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    act(() => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      title: literalTitle,
    }));
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('contexts');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('tags');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('dueDate');
    expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('projectId');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves clearing a project and moving the task to an area in one edit', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) =>
      typeof node.props.setEditedTask === 'function'
      && typeof node.props.renderField === 'function'
    )[0];
    act(() => {
      formTab.props.setEditedTask((prev: any) => ({
        ...prev,
        projectId: undefined,
        sectionId: undefined,
        areaId: 'area-1',
      }));
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    act(() => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
      areaId: 'area-1',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks who or what is being waited on before setting status to waiting', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const viewTab = tree!.root.find((node) => typeof node.props.onStatusUpdate === 'function');
    await act(async () => {
      viewTab.props.onStatusUpdate('waiting');
    });

    const waitingInput = tree!.root.findByProps({ placeholder: 'Who is this waiting for?' });
    await act(async () => {
      waitingInput.props.onChangeText('Alex');
    });

    await act(async () => {
      waitingInput.props.onSubmitEditing();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    await act(async () => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      status: 'waiting',
      assignedTo: 'Alex',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the project area when clearing a task project', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) =>
      typeof node.props.setEditedTask === 'function'
      && typeof node.props.renderField === 'function'
    )[0];
    let projectField!: renderer.ReactTestRenderer;
    act(() => {
      projectField = renderer.create(formTab.props.renderField('project'));
    });

    const clearProjectButton = projectField!.root.findAll((node) => (
      typeof node.props.onPress === 'function'
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'common.clear')
    ))[0];
    act(() => {
      clearProjectButton.props.onPress();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    act(() => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
      areaId: 'area-1',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an explicit task area when clearing a task project', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'next',
            projectId: 'project-1',
            sectionId: 'section-1',
            areaId: 'area-2',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) =>
      typeof node.props.setEditedTask === 'function'
      && typeof node.props.renderField === 'function'
    )[0];
    let projectField!: renderer.ReactTestRenderer;
    act(() => {
      projectField = renderer.create(formTab.props.renderField('project'));
    });

    const clearProjectButton = projectField!.root.findAll((node) => (
      typeof node.props.onPress === 'function'
      && node.findAllByType(Text).some((textNode) => textNode.props.children === 'common.clear')
    ))[0];
    act(() => {
      clearProjectButton.props.onPress();
    });

    const header = tree!.root.find((node) =>
      typeof node.props.onDone === 'function'
      && typeof node.props.onDelete === 'function'
    );
    act(() => {
      header.props.onDone();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({
      projectId: undefined,
      sectionId: undefined,
    }));
    const updates = onSave.mock.calls[0]?.[1] ?? {};
    expect(Object.prototype.hasOwnProperty.call(updates, 'areaId')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not prompt after reopening a task that was just saved', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const initialTask = {
      id: 't1',
      title: 'Test task',
      status: 'inbox' as const,
      tags: [],
      contexts: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const savedTask = {
      ...initialTask,
      title: 'Changed task',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={initialTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.onTitleDraftChange === 'function')[0];
    act(() => {
      formTab.props.onTitleDraftChange('Changed task');
    });

    const firstModal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    const alertSpy = vi.spyOn(Alert, 'alert');

    act(() => {
      firstModal!.props.onRequestClose();
    });

    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as { text?: string; onPress?: () => void }[];
    act(() => {
      buttons[2]?.onPress?.();
    });

    expect(onSave).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Changed task' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      tree!.update(
        <TaskEditModal
          visible={false}
          task={savedTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    act(() => {
      tree!.update(
        <TaskEditModal
          visible
          task={savedTask}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    alertSpy.mockClear();
    const reopenedModal = tree!.root.findAll((node) => node.props.visible === true && typeof node.props.onRequestClose === 'function')[0];
    act(() => {
      reopenedModal!.props.onRequestClose();
    });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('syncs the pager to the requested default tab on first open', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible={false}
          task={null}
          onClose={onClose}
          onSave={onSave}
          defaultTab="view"
        />
      );
    });

    vi.mocked(syncTaskEditPagerPosition).mockClear();

    act(() => {
      tree!.update(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
          defaultTab="view"
        />
      );
    });

    expect(vi.mocked(syncTaskEditPagerPosition)).toHaveBeenCalled();
    expect(
      vi.mocked(syncTaskEditPagerPosition).mock.calls.some(
        ([args]) => args?.mode === 'view'
      )
    ).toBe(true);
  });

  it('disables horizontal pager gestures while the description editor is focused', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'Long description',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={onSave}
        />
      );
    });

    const findPager = () => tree!.root.find((node) =>
      node.props.horizontal === true
      && node.props.pagingEnabled === true
      && typeof node.props.scrollEnabled === 'boolean'
    );
    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];

    expect(findPager().props.scrollEnabled).toBe(true);

    await act(async () => {
      const descriptionField = formTab.props.renderField('description');
      descriptionField.props.setIsDescriptionInputFocused(true);
    });

    expect(findPager().props.scrollEnabled).toBe(false);

    await act(async () => {
      const descriptionField = formTab.props.renderField('description');
      descriptionField.props.setIsDescriptionInputFocused(false);
    });

    expect(findPager().props.scrollEnabled).toBe(true);
  });

  it('enables native spell checking for the mobile description editor', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'Fix teh typo',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];
    let descriptionTree: renderer.ReactTestRenderer;
    act(() => {
      descriptionTree = renderer.create(formTab.props.renderField('description'));
    });

    const descriptionInput = descriptionTree!.root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
    });

    expect(descriptionInput.props.spellCheck).toBe(true);
    expect(descriptionInput.props.autoCorrect).toBe(true);
    expect(descriptionInput.props.autoCapitalize).toBe('sentences');
    expect(descriptionInput.props.keyboardType).toBe('default');

    act(() => {
      descriptionTree!.unmount();
      tree!.unmount();
    });
  });

  it('keeps the mobile description Markdown toolbar attached to the keyboard', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            description: 'A note',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
          defaultTab="task"
        />
      );
    });

    const formTab = tree!.root.findAll((node) => typeof node.props.renderField === 'function')[0];
    let descriptionTree: renderer.ReactTestRenderer;
    act(() => {
      descriptionTree = renderer.create(formTab.props.renderField('description'));
    });

    const descriptionInput = descriptionTree!.root.findByProps({
      accessibilityLabel: 'taskEdit.descriptionLabel',
    });

    act(() => {
      descriptionInput.props.onFocus({ nativeEvent: { target: 1 } });
    });

    const inlineToolbars = descriptionTree!.root.findAllByType(MarkdownFormatToolbar);
    const modalToolbars = tree!.root.findAllByType(MarkdownFormatToolbar);
    const visibleModalToolbars = modalToolbars.filter((toolbar) => toolbar.props.visible);

    expect(inlineToolbars).toHaveLength(0);
    expect(visibleModalToolbars).toHaveLength(1);
    expect(visibleModalToolbars[0].props.placement).toBeUndefined();

    act(() => {
      descriptionTree!.unmount();
      tree!.unmount();
    });
  });

  it('closes and delegates preview navigation actions', () => {
    const onClose = vi.fn();
    const onProjectNavigate = vi.fn();
    const onContextNavigate = vi.fn();
    const onTagNavigate = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            projectId: 'project-1',
            tags: ['#urgent'],
            contexts: ['@home'],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={onClose}
          onSave={vi.fn()}
          onProjectNavigate={onProjectNavigate}
          onContextNavigate={onContextNavigate}
          onTagNavigate={onTagNavigate}
        />
      );
    });

    const viewTab = tree!.root.find((node) =>
      typeof node.props.onProjectPress === 'function'
      && typeof node.props.onContextPress === 'function'
      && typeof node.props.onTagPress === 'function'
    );

    act(() => {
      viewTab.props.onProjectPress('project-1');
      viewTab.props.onContextPress('@home');
      viewTab.props.onTagPress('#urgent');
    });

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onProjectNavigate).toHaveBeenCalledWith('project-1');
    expect(onContextNavigate).toHaveBeenCalledWith('@home');
    expect(onTagNavigate).toHaveBeenCalledWith('#urgent');
  });
});
