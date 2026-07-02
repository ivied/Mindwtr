import React from 'react';
import { Alert, Dimensions, Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, Section, Task } from '@mindwtr/core';

const mockScrollTo = vi.hoisted(() => vi.fn());
const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 9001));
const mockMeasureInWindow = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ tint: '#3b82f6', onTint: '#ffffff' }),
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

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
    default: () => null,
}));

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Ionicons: (props: any) => ReactModule.createElement('Ionicons', props),
    };
});

vi.mock('lucide-react-native', () => ({
    CheckCircle2: () => null,
    ClipboardCheck: () => null,
    X: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => children,
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: ({ children }: any) => children,
}));

vi.mock('react-native-draggable-flatlist', () => ({
    NestableScrollContainer: ({ children }: any) => children,
}));

vi.mock('../../components/keyboard-accessory-host', () => ({
    KeyboardAccessoryHost: ({ children }: any) => children,
}));

vi.mock('../../components/expanded-markdown-editor', () => ({
    ExpandedMarkdownEditor: () => null,
}));

vi.mock('../../components/markdown-format-toolbar', () => ({
    MarkdownFormatToolbar: () => null,
}));

vi.mock('../../components/markdown-reference-autocomplete', () => ({
    MarkdownReferenceAutocomplete: () => null,
}));

vi.mock('../../components/markdown-text', () => ({
    MarkdownText: () => null,
}));

const taskListPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('../../components/task-list', async () => {
    const ReactModule = await import('react');
    return {
        TaskList: (props: any) => {
            taskListPropsSpy(props);
            return ReactModule.createElement(
                ReactModule.Fragment,
                null,
                props.headerAccessory,
            );
        },
    };
});

vi.mock('../../components/AttachmentProgressIndicator', () => ({
    AttachmentProgressIndicator: () => null,
}));

import { ProjectDetailModal, getProjectDetailModalSafeAreaEdges, getProjectDetailTaskListOptions } from './ProjectDetailModal';

const project = (status: Project['status']): Project => ({
    id: 'project-1',
    title: 'Launch',
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const section = (id: string, title: string): Section => ({
    id,
    projectId: 'project-1',
    title,
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const themeColors = {
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#1f2937',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    border: '#334155',
    tint: '#60a5fa',
    onTint: '#0f172a',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#60a5fa',
    inputBg: '#1e293b',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
    filterBg: '#1e293b',
};

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: os,
    });
};

const createProjectDetailModalProps = (overrides: Partial<React.ComponentProps<typeof ProjectDetailModal>> = {}) => ({
    addProjectFileAttachment: vi.fn(),
    addSection: vi.fn(),
    closeProjectDetail: vi.fn(),
    commitSelectedProjectNotes: vi.fn(),
    formatProjectDate: (value: string | undefined, fallback: string) => value || fallback,
    handleArchiveSelectedProject: vi.fn(),
    handleSelectedProjectNotesApplyAction: vi.fn(() => ({ value: '', selection: { start: 0, end: 0 } })),
    handleSelectedProjectNotesApplyAutocomplete: vi.fn(),
    handleSelectedProjectNotesChange: vi.fn(),
    handleSelectedProjectNotesSelectionChange: vi.fn(),
    handleSelectedProjectNotesUndo: vi.fn(),
    handleSetProjectStatus: vi.fn(),
    isSelectedProjectNotesFocused: false,
    modalHeaderStyle: [{}],
    notesExpanded: true,
    notesFullscreen: false,
    onCloseNotesFullscreen: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDownloadAttachment: vi.fn(),
    onOpenAreaPicker: vi.fn(),
    onOpenAttachment: vi.fn(),
    onOpenProjectQuickAdd: vi.fn(),
    onOpenTagPicker: vi.fn(),
    onRemoveProjectAttachment: vi.fn(),
    deleteSection: vi.fn(),
    reorderSections: vi.fn(),
    onSetLinkInput: vi.fn(),
    onSetLinkModalVisible: vi.fn(),
    onSetNotesExpanded: vi.fn(),
    onSetSelectedProject: vi.fn(),
    onSetSelectedProjectNotesFocused: vi.fn(),
    onSetShowDueDatePicker: vi.fn(),
    onSetShowNotesFullscreen: vi.fn(),
    onSetShowNotesPreview: vi.fn(),
    onSetShowProjectMeta: vi.fn(),
    onSetShowReviewPicker: vi.fn(),
    onSetShowStatusMenu: vi.fn(),
    onProjectTaskSortByChange: vi.fn(),
    onToggleShowCompletedTasks: vi.fn(),
    overlayVisible: true,
    presentationStyle: 'fullScreen' as const,
    projectTaskSortBy: 'default' as const,
    selectedProject: { ...project('active'), supportNotes: 'Draft' },
    selectedProjectAreaName: 'No Area',
    selectedProjectSections: [],
    selectedProjectNotes: 'Draft',
    selectedProjectNotesDirection: 'ltr' as const,
    selectedProjectNotesInputRef: { current: null },
    selectedProjectNotesSelection: { start: 5, end: 5 },
    selectedProjectNotesTextDirectionStyle: {},
    selectedProjectNotesUndoDepth: 0,
    showCompletedTasks: false,
    showDueDatePicker: false,
    showNotesPreview: false,
    showProjectMeta: true,
    showReviewPicker: false,
    showStatusMenu: false,
    statusPalette: {
        active: { bg: '#1d4ed822', border: '#1d4ed8', text: '#1d4ed8' },
        waiting: { bg: '#f59e0b22', border: '#f59e0b', text: '#f59e0b' },
        someday: { bg: '#a855f722', border: '#a855f7', text: '#a855f7' },
        archived: { bg: '#334155', border: '#334155', text: '#94a3b8' },
    },
    t: (key: string) => ({
        'attachments.addFile': 'Add file',
        'attachments.addLink': 'Add link',
        'attachments.title': 'Attachments',
        'common.back': 'Back',
        'common.clear': 'Clear',
        'common.delete': 'Delete',
        'common.edit': 'Edit',
        'common.hideCompleted': 'Hide completed',
        'common.loading': 'Loading',
        'common.none': 'None',
        'common.notSet': 'Not set',
        'common.save': 'Save',
        'common.showCompleted': 'Show completed',
        'nav.addTask': 'Add task',
        'markdown.edit': 'Edit',
        'markdown.expand': 'Expand',
        'markdown.preview': 'Preview',
        'project.notes': 'Project notes',
        'projects.archive': 'Archive',
        'projects.areaLabel': 'Area',
        'projects.addSection': 'Add Section',
        'projects.deleteSectionConfirm': 'Are you sure you want to delete this section?',
        'projects.duplicate': 'Duplicate',
        'projects.moveDown': 'Move down',
        'projects.moveUp': 'Move up',
        'projects.notesPlaceholder': 'Notes',
        'projects.noArea': 'No Area',
        'projects.reactivate': 'Reactivate',
        'projects.reorderTasks': 'Order',
        'projects.reviewAt': 'Review',
        'projects.sectionPlaceholder': 'Section title',
        'projects.sectionsLabel': 'Sections',
        'projects.sequentialAcrossSections': 'Across sections',
        'projects.sequentialScope': 'Sequential Scope',
        'projects.sequentialWithinSections': 'Within sections',
        'projects.statusLabel': 'Status',
        'sort.default': 'Default',
        'sort.due': 'Due date',
        'sort.label': 'Sort',
        'settings.manage': 'Manage',
        'status.active': 'Active',
        'status.someday': 'Someday',
        'status.waiting': 'Waiting',
        'taskEdit.details': 'Details',
        'taskEdit.dueDateLabel': 'Due Date',
        'taskEdit.tagsLabel': 'Tags',
    }[key] ?? key),
    tc: themeColors,
    updateProject: vi.fn(),
    updateSection: vi.fn(),
    ...overrides,
});

afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatformOs,
    });
    mockScrollTo.mockReset();
    mockFindNodeHandle.mockReset();
    mockFindNodeHandle.mockReturnValue(9001);
    mockMeasureInWindow.mockReset();
    taskListPropsSpy.mockClear();
    vi.restoreAllMocks();
});

describe('ProjectDetailModal safe area handling', () => {
    it('reserves the top inset for Android full-screen release modals', () => {
        expect(getProjectDetailModalSafeAreaEdges('fullScreen')).toEqual(['top', 'left', 'right', 'bottom']);
    });

    it('preserves the existing page-sheet header spacing path', () => {
        expect(getProjectDetailModalSafeAreaEdges('pageSheet')).toEqual(['left', 'right', 'bottom']);
    });
});

describe('ProjectDetailModal notes editing', () => {
    it('commits project notes when the inline notes editor blurs', () => {
        const commitSelectedProjectNotes = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ commitSelectedProjectNotes })} />);
        });

        const notesInput = tree.root.findAllByType(TextInput).find((input) => (
            input.props.placeholder === 'Notes'
        ));

        expect(notesInput).toBeTruthy();

        act(() => {
            notesInput?.props.onBlur();
        });

        expect(commitSelectedProjectNotes).toHaveBeenCalledTimes(1);
    });
});

describe('ProjectDetailModal section management', () => {
    it('creates a section from project details', async () => {
        const addSection = vi.fn().mockResolvedValue(section('section-created', 'Grammar'));
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ addSection })} />);
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-add-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-title-input' }).props.onChangeText('Grammar');
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'project-section-save-button' }).props.onPress();
        });

        expect(addSection).toHaveBeenCalledWith('project-1', 'Grammar');
    });

    it('renames an existing section from project details', async () => {
        const updateSection = vi.fn().mockResolvedValue({ ok: true });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                selectedProjectSections: [section('section-1', 'Planning')],
                updateSection,
            })} />);
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-edit-section-1' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-title-input' }).props.onChangeText('Speaking');
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'project-section-save-button' }).props.onPress();
        });

        expect(updateSection).toHaveBeenCalledWith('section-1', { title: 'Speaking' });
    });

    it('confirms before deleting a section from project details', async () => {
        const deleteSection = vi.fn();
        vi.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
            buttons?.[1]?.onPress?.();
        }) as typeof Alert.alert);
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                deleteSection,
                selectedProjectSections: [section('section-1', 'Planning')],
            })} />);
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-delete-section-1' }).props.onPress();
        });

        expect(Alert.alert).toHaveBeenCalledWith(
            'Sections',
            'Are you sure you want to delete this section?',
            expect.any(Array),
        );
        expect(deleteSection).toHaveBeenCalledWith('section-1');
    });

    it('reorders sections from project details', async () => {
        const reorderSections = vi.fn().mockResolvedValue(undefined);
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                reorderSections,
                selectedProjectSections: [
                    { ...section('section-1', 'Planning'), order: 0 },
                    { ...section('section-2', 'Speaking'), order: 1 },
                ],
            })} />);
        });

        await act(async () => {
            tree.root.findByProps({ testID: 'project-sections-button' }).props.onPress();
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'project-section-move-down-section-1' }).props.onPress();
        });

        expect(reorderSections).toHaveBeenCalledWith('project-1', ['section-2', 'section-1']);
    });
});

describe('ProjectDetailModal task sorting', () => {
    it('opens global quick add for project task creation instead of inline add', () => {
        const onOpenProjectQuickAdd = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({ onOpenProjectQuickAdd })} />);
        });

        expect(taskListPropsSpy).toHaveBeenCalled();
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].allowAdd).toBe(false);

        act(() => {
            tree.root.findByProps({ testID: 'project-add-task-button' }).props.onPress();
        });

        expect(onOpenProjectQuickAdd).toHaveBeenCalledWith(expect.objectContaining({
            id: 'project-1',
            title: 'Launch',
        }));
    });

    it('passes the project-local sort to TaskList and handles sort changes', () => {
        const onProjectTaskSortByChange = vi.fn();
        const selectedProjectTasks = [
            {
                id: 'project-task-1',
                title: 'Project task',
                status: 'next',
                projectId: 'project-1',
                createdAt: '2026-05-12T00:00:00.000Z',
                updatedAt: '2026-05-12T00:00:00.000Z',
            },
        ] as Task[];
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                onProjectTaskSortByChange,
                projectTaskSortBy: 'default',
                selectedProjectTasks,
            })} />);
        });

        expect(taskListPropsSpy).toHaveBeenCalled();
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].projectSortBy).toBe('default');
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].taskSource).toBe(selectedProjectTasks);
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].showFilterButton).toBe(false);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-sort-toggle' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'sort-option-due' }).props.onPress();
        });

        expect(onProjectTaskSortByChange).toHaveBeenCalledWith('due');
    });

    it('keeps project task controls outside the scrolling task list', () => {
        const onOpenProjectQuickAdd = vi.fn();
        const onProjectTaskSortByChange = vi.fn();
        const onToggleShowCompletedTasks = vi.fn();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                onOpenProjectQuickAdd,
                onProjectTaskSortByChange,
                onToggleShowCompletedTasks,
                selectedProjectSections: [
                    section('section-1', 'Research'),
                    section('section-2', 'Design'),
                ],
            })} />);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].headerAccessory).toBeUndefined();
        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].externalFilterOpenSignal).toBe(0);

        act(() => {
            tree.root.findByProps({ testID: 'project-task-filter-button' }).props.onPress();
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].externalFilterOpenSignal).toBe(1);

        act(() => {
            tree.root.findByProps({ testID: 'project-add-task-button' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-sort-toggle' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'sort-option-due' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-pinned-show-completed-toggle' }).props.onPress();
        });
        act(() => {
            tree.root.findByProps({ testID: 'project-task-reorder-toggle' }).props.onPress();
        });

        expect(onOpenProjectQuickAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-1' }));
        expect(onProjectTaskSortByChange).toHaveBeenCalledWith('due');
        expect(onToggleShowCompletedTasks).toHaveBeenCalledTimes(1);
        expect(tree.root.findByProps({ testID: 'project-task-reorder-toggle' }).props.accessibilityState).toEqual({ selected: true });
    });

    it('uses compact visibility icons for the completed-task toggle', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const hiddenToggle = tree.root.findByProps({ testID: 'project-pinned-show-completed-toggle' });
        expect(hiddenToggle.props.accessibilityRole).toBe('switch');
        expect(hiddenToggle.props.accessibilityLabel).toBe('Show completed');
        expect(hiddenToggle.props.accessibilityState).toEqual({ checked: false });
        expect(hiddenToggle.findByProps({ name: 'eye-off-outline' }).props.name).toBe('eye-off-outline');

        act(() => {
            tree.update(<ProjectDetailModal {...createProjectDetailModalProps({ showCompletedTasks: true })} />);
        });

        const visibleToggle = tree.root.findByProps({ testID: 'project-pinned-show-completed-toggle' });
        expect(visibleToggle.props.accessibilityLabel).toBe('Hide completed');
        expect(visibleToggle.props.accessibilityState).toEqual({ checked: true });
        expect(visibleToggle.findByProps({ name: 'eye-outline' }).props.name).toBe('eye-outline');
    });

    it('pins project bulk selection actions above the scrolling task list', () => {
        const onOpenOrganize = vi.fn();
        const props = createProjectDetailModalProps();
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...props} />);
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(taskListProps.bulkBarPlacement).toBe('external');
        expect(taskListProps.enableProjectBulkOrganize).toBe(true);
        expect(typeof taskListProps.onBulkBarPropsChange).toBe('function');

        act(() => {
            taskListProps.onBulkBarPropsChange({
                bulkActionLabel: '',
                bulkActionLoading: false,
                handleBatchDelete: vi.fn(),
                handleBatchMove: vi.fn(),
                hasSelection: true,
                onExitSelectionMode: vi.fn(),
                onOpenOrganize,
                onOpenTagModal: vi.fn(),
                onToggleRangeSelectMode: vi.fn(),
                rangeSelectMode: false,
                selectedCount: 3,
                t: props.t,
                themeColors,
            });
        });

        const pinnedBulkBar = tree.root.findByProps({ testID: 'project-task-selection-bulk-bar' });
        expect(pinnedBulkBar.findByProps({ testID: 'task-list-range-select-toggle' })).toBeTruthy();

        act(() => {
            pinnedBulkBar.findByProps({ accessibilityLabel: 'Bulk organize' }).props.onPress();
        });

        expect(onOpenOrganize).toHaveBeenCalledTimes(1);
    });

    it('reflects the active in-sheet filter count on the pinned filter button badge', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof taskListProps.onFilterStateChange).toBe('function');

        act(() => {
            taskListProps.onFilterStateChange({ activeCount: 2, hasActive: true });
        });

        const filterButton = tree.root.findByProps({ testID: 'project-task-filter-button' });
        expect(filterButton.findAllByProps({ children: 2 }).length).toBeGreaterThan(0);
    });
});

describe('ProjectDetailModal project task virtualization', () => {
    it('resets the static task list scroll window before reopening a project', () => {
        const selectedProject = { ...project('active'), supportNotes: 'Draft' };
        const selectedProjectTasks = Array.from({ length: 120 }, (_, index) => ({
            id: `project-task-${index + 1}`,
            title: `Project task ${index + 1}`,
            status: 'next',
            projectId: selectedProject.id,
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        })) as Task[];
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                selectedProject,
                selectedProjectTasks,
            })} />);
        });

        act(() => {
            tree.root.findByType(ScrollView).props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 720 },
                    layoutMeasurement: { height: 540 },
                },
            });
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].staticListVirtualization).toEqual({
            scrollOffsetY: 720,
            viewportHeight: 540,
        });

        taskListPropsSpy.mockClear();

        act(() => {
            tree.update(<ProjectDetailModal {...createProjectDetailModalProps({
                overlayVisible: false,
                selectedProject: null,
                selectedProjectTasks: [],
            })} />);
        });

        expect(taskListPropsSpy).not.toHaveBeenCalled();

        act(() => {
            tree.update(<ProjectDetailModal {...createProjectDetailModalProps({
                selectedProject,
                selectedProjectTasks,
            })} />);
        });

        expect(taskListPropsSpy.mock.calls.at(-1)?.[0].staticListVirtualization).toEqual({
            scrollOffsetY: 0,
            viewportHeight: 0,
        });
    });


    it('restores the project task scroll offset when the external bulk bar appears', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            tree.root.findByType(ScrollView).props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 480 },
                    layoutMeasurement: { height: 620 },
                },
            });
        });

        const taskListProps = taskListPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof taskListProps.onBulkBarPropsChange).toBe('function');

        act(() => {
            taskListProps.onBulkBarPropsChange({
                bulkActionLabel: '',
                bulkActionLoading: false,
                handleBatchDelete: vi.fn(),
                handleBatchMove: vi.fn(),
                hasSelection: true,
                onExitSelectionMode: vi.fn(),
                onOpenTagModal: vi.fn(),
                onToggleRangeSelectMode: vi.fn(),
                rangeSelectMode: false,
                selectedCount: 1,
                t: createProjectDetailModalProps().t,
                themeColors,
            });
        });

        expect(mockScrollTo).toHaveBeenCalledWith({ y: 480, animated: false });
    });
});

describe('ProjectDetailModal keyboard handling', () => {
    it('uses Android height-based keyboard avoidance for project task quick-add', () => {
        setPlatform('android');
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
        expect(tree.root.findByType(ScrollView).props.keyboardDismissMode).toBe('on-drag');
        expect(tree.root.findByType(ScrollView).props.scrollsChildToFocus).toBe(false);
        expect(taskListPropsSpy).toHaveBeenCalled();
        expect(typeof taskListPropsSpy.mock.calls.at(-1)?.[0].onQuickAddInputFocus).toBe('function');
    });

    it('adds Android keyboard bottom space so project quick-add can scroll above the keyboard', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockReturnValue({
            width: 390,
            height: 800,
            scale: 3,
            fontScale: 1,
        });
        const listeners = new Map<string, (event?: any) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: any) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520 } });
        });

        expect(tree.root.findByType(ScrollView).props.contentContainerStyle).toEqual(
            expect.arrayContaining([expect.objectContaining({ paddingBottom: 304 })])
        );
    });

    it('keeps the project quick-add row visible when Android resizes the modal before the keyboard event', () => {
        setPlatform('android');
        vi.spyOn(Dimensions, 'get').mockImplementation(((dimension: 'window' | 'screen') => ({
            width: 390,
            height: dimension === 'screen' ? 800 : 520,
            scale: 3,
            fontScale: 1,
        })) as any);
        const listeners = new Map<string, (event?: any) => void>();
        vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: any) => void) => {
            listeners.set(eventName, listener);
            return { remove: () => listeners.delete(eventName) };
        }) as any);
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        }) as any);
        const targetY = 500;
        const targetH = 44;
        const scrollY = 0;
        const scrollH = 520;
        mockMeasureInWindow.mockImplementation(((handle: number, callback: any) => {
            if (handle === 42) {
                callback(0, targetY, 320, targetH);
                return;
            }
            callback(0, scrollY, 390, scrollH);
        }) as any);
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        act(() => {
            tree.root.findByType(ScrollView).props.onScroll({ nativeEvent: { contentOffset: { y: 360 } } });
            taskListPropsSpy.mock.calls.at(-1)?.[0].onQuickAddInputFocus(42);
        });

        expect(mockScrollTo).not.toHaveBeenCalled();

        act(() => {
            listeners.get('keyboardDidShow')?.({ endCoordinates: { screenY: 520, height: 280 } });
        });

        const visibleBottom = Math.min(scrollY + scrollH, 520);
        const visibleHeight = visibleBottom - scrollY;
        const bottomClearance = visibleHeight * 0.18;
        const measuredOverlap = (targetY + targetH) - (visibleBottom - bottomClearance);
        expect(tree.root.findByType(ScrollView).props.contentContainerStyle).toEqual(
            expect.arrayContaining([expect.objectContaining({ paddingBottom: 304 })])
        );
        expect(mockScrollTo).toHaveBeenCalledWith({ y: 360 + measuredOverlap, animated: true });
    });
});

describe('ProjectDetailModal lifecycle actions', () => {
    it('groups Duplicate and Archive in a section separate from the Type setting', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const actionsSection = tree.root.findByProps({ testID: 'project-actions-section' });
        expect(actionsSection.findByProps({ testID: 'project-duplicate-button' })).toBeTruthy();
        expect(actionsSection.findByProps({ testID: 'project-archive-button' })).toBeTruthy();
        // The Type toggle must stay with the Status/Type card, not read as part of the actions.
        expect(actionsSection.findAllByProps({ testID: 'project-type-toggle' })).toHaveLength(0);
    });

    it('surfaces that completing a project files it in Archived', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps()} />);
        });

        const helper = tree.root.findByProps({ testID: 'project-actions-helper' });
        const helperText = String(helper.props.children).toLowerCase();
        expect(helperText).toContain('complet');
        expect(helperText).toContain('archived');
    });

    it('shows Reactivate instead of Archive in the actions section for archived projects', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<ProjectDetailModal {...createProjectDetailModalProps({
                selectedProject: { ...project('archived'), supportNotes: 'Draft' },
            })} />);
        });

        const actionsSection = tree.root.findByProps({ testID: 'project-actions-section' });
        expect(actionsSection.findByProps({ testID: 'project-reactivate-button' })).toBeTruthy();
        expect(actionsSection.findAllByProps({ testID: 'project-archive-button' })).toHaveLength(0);
    });
});

describe('ProjectDetailModal archived projects', () => {
    it('shows archived task data without quick-add or reorder controls', () => {
        expect(getProjectDetailTaskListOptions(project('archived'))).toEqual({
            allowAdd: false,
            enableProjectReorder: false,
            groupCompletedTasksLast: false,
            includeArchived: true,
            includeDone: true,
        });
    });

    it('keeps normal task controls and hides done tasks for non-archived projects by default', () => {
        expect(getProjectDetailTaskListOptions(project('active'))).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            groupCompletedTasksLast: false,
            includeArchived: false,
            includeDone: false,
        });
    });

    it('shows done tasks for active projects when the completed toggle is on', () => {
        expect(getProjectDetailTaskListOptions(project('active'), true)).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            groupCompletedTasksLast: true,
            includeArchived: false,
            includeDone: true,
        });
    });
});
