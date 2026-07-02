import React from 'react';
import {
    Alert,
    Dimensions,
    findNodeHandle,
    Keyboard,
    Modal,
    KeyboardAvoidingView,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Platform,
    ScrollView,
    type ScrollViewProps,
    Text,
    TextInput,
    TouchableOpacity,
    UIManager,
    View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NestableScrollContainer } from 'react-native-draggable-flatlist';
import {
    type Attachment,
    getAttachmentDisplayTitle,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type Project,
    type ProjectSequenceTaskCue,
    type Section,
    type Task,
    type TaskSortBy,
    getSequentialProjectTaskCues,
    safeParseDate,
    tFallback,
} from '@mindwtr/core';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { KeyboardAccessoryHost } from '../../components/keyboard-accessory-host';
import { ExpandedMarkdownEditor } from '../../components/expanded-markdown-editor';
import { MarkdownFormatToolbar } from '../../components/markdown-format-toolbar';
import { MarkdownReferenceAutocomplete } from '../../components/markdown-reference-autocomplete';
import { MarkdownText } from '../../components/markdown-text';
import { TaskList } from '../../components/task-list';
import { TaskListBulkBar, type TaskListBulkBarProps } from '../task-list/TaskListBulkBar';
import { TaskListSortModal } from '../task-list/TaskListSortModal';
import { AttachmentProgressIndicator } from '../../components/AttachmentProgressIndicator';
import { projectsScreenStyles as styles } from './projects-screen.styles';
import { getAndroidKeyboardFrame } from '../../lib/android-keyboard-frame';

const PROJECT_TASK_SORT_OPTIONS: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];

type ProjectDetailModalProps = {
    addProjectFileAttachment: () => void | Promise<void>;
    addSection: (projectId: string, title: string) => Promise<Section | null> | Section | null;
    closeProjectDetail: () => void;
    commitSelectedProjectNotes: () => void;
    formatProjectDate: (value: string | undefined, fallback: string) => string;
    handleArchiveSelectedProject: () => void;
    handleSelectedProjectNotesApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult;
    handleSelectedProjectNotesApplyAutocomplete: (next: { selection: MarkdownSelection; value: string }) => void;
    handleSelectedProjectNotesChange: (text: string) => void;
    handleSelectedProjectNotesSelectionChange: (selection: MarkdownSelection) => void;
    handleSelectedProjectNotesUndo: () => MarkdownSelection | undefined;
    handleSetProjectStatus: (status: Project['status']) => void;
    isSelectedProjectNotesFocused: boolean;
    modalHeaderStyle: Record<string, unknown>[];
    notesExpanded: boolean;
    notesFullscreen: boolean;
    onCloseNotesFullscreen: () => void;
    onDuplicateProject: (projectId: string) => void;
    onOpenAreaPicker: () => void;
    onOpenTagPicker: () => void;
    onRemoveProjectAttachment: (id: string) => void;
    deleteSection: (id: string) => Promise<unknown> | unknown;
    reorderSections: (projectId: string, orderedIds: string[]) => Promise<unknown> | unknown;
    onSetLinkInput: (value: string) => void;
    onSetLinkModalVisible: (visible: boolean) => void;
    onSetNotesExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    onSetSelectedProjectNotesFocused: React.Dispatch<React.SetStateAction<boolean>>;
    onSetSelectedProject: React.Dispatch<React.SetStateAction<Project | null>>;
    onSetShowDueDatePicker: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowNotesFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowNotesPreview: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowProjectMeta: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowReviewPicker: React.Dispatch<React.SetStateAction<boolean>>;
    onSetShowStatusMenu: React.Dispatch<React.SetStateAction<boolean>>;
    onToggleShowCompletedTasks: () => void;
    onProjectTaskSortByChange: (sortBy: TaskSortBy) => void;
    onDownloadAttachment: (attachment: Attachment) => void | Promise<void>;
    onOpenAttachment: (attachment: Attachment) => void | Promise<void>;
    onOpenProjectQuickAdd: (project: Project) => void;
    overlayVisible: boolean;
    presentationStyle: 'pageSheet' | 'fullScreen';
    projectTaskSortBy: TaskSortBy;
    selectedProjectAreaName: string;
    selectedProject: Project | null;
    selectedProjectSections?: Section[];
    selectedProjectTasks?: Task[];
    selectedProjectNotes: string;
    selectedProjectNotesDirection: 'ltr' | 'rtl';
    selectedProjectNotesInputRef: React.RefObject<TextInput | null>;
    selectedProjectNotesSelection: MarkdownSelection;
    selectedProjectNotesTextDirectionStyle: Record<string, unknown>;
    selectedProjectNotesUndoDepth: number;
    showDueDatePicker: boolean;
    showNotesPreview: boolean;
    showProjectMeta: boolean;
    showReviewPicker: boolean;
    showStatusMenu: boolean;
    showCompletedTasks: boolean;
    statusPalette: Record<Project['status'], { bg: string; border: string; text: string }>;
    t: (key: string) => string;
    tc: ThemeColors;
    updateProject: (id: string, updates: Partial<Project>) => void;
    updateSection: (id: string, updates: Partial<Section>) => Promise<unknown> | unknown;
};

function ProjectSectionManagerModal({
    addSection,
    canManage,
    deleteSection,
    onClose,
    projectId,
    reorderSections,
    sections,
    t,
    tc,
    updateSection,
    visible,
}: {
    addSection: (projectId: string, title: string) => Promise<Section | null> | Section | null;
    canManage: boolean;
    deleteSection: (id: string) => Promise<unknown> | unknown;
    onClose: () => void;
    projectId: string;
    reorderSections: (projectId: string, orderedIds: string[]) => Promise<unknown> | unknown;
    sections: Section[];
    t: (key: string) => string;
    tc: ThemeColors;
    updateSection: (id: string, updates: Partial<Section>) => Promise<unknown> | unknown;
    visible: boolean;
}) {
    const filledButton = useFilledButtonColors();
    const [draft, setDraft] = React.useState('');
    const [editingSectionId, setEditingSectionId] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const sectionTitle = tFallback(t, 'projects.sectionsLabel', 'Sections');
    const addSectionLabel = tFallback(t, 'projects.addSection', 'Add Section');
    const sectionPlaceholder = tFallback(t, 'projects.sectionPlaceholder', 'Section title');
    const saveLabel = tFallback(t, 'common.save', 'Save');
    const editLabel = tFallback(t, 'common.edit', 'Edit');
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const deleteLabel = tFallback(t, 'common.delete', 'Delete');
    const moveUpLabel = tFallback(t, 'projects.moveUp', 'Move up');
    const moveDownLabel = tFallback(t, 'projects.moveDown', 'Move down');
    const noneLabel = tFallback(t, 'common.none', 'None');
    const deleteConfirm = tFallback(
        t,
        'projects.deleteSectionConfirm',
        'Are you sure you want to delete this section?'
    );
    const sectionReorderFailed = tFallback(t, 'projects.sectionReorderFailed', 'Failed to reorder sections.');
    const editing = sections.find((section) => section.id === editingSectionId);
    const showEditor = canManage && editingSectionId !== null;

    React.useEffect(() => {
        if (visible) return;
        setDraft('');
        setEditingSectionId(null);
        setSaving(false);
    }, [visible]);

    const openCreate = React.useCallback(() => {
        setEditingSectionId('');
        setDraft('');
    }, []);

    const openEdit = React.useCallback((section: Section) => {
        setEditingSectionId(section.id);
        setDraft(section.title);
    }, []);

    const closeEditor = React.useCallback(() => {
        setEditingSectionId(null);
        setDraft('');
    }, []);

    const saveSection = React.useCallback(async () => {
        if (!canManage || saving) return;
        const title = draft.trim();
        if (!title) return;
        setSaving(true);
        try {
            if (editingSectionId) {
                await updateSection(editingSectionId, { title });
            } else {
                await addSection(projectId, title);
            }
            closeEditor();
        } finally {
            setSaving(false);
        }
    }, [addSection, canManage, closeEditor, draft, editingSectionId, projectId, saving, updateSection]);

    const confirmDeleteSection = React.useCallback((section: Section) => {
        if (!canManage) return;
        Alert.alert(
            sectionTitle,
            deleteConfirm,
            [
                { text: cancelLabel, style: 'cancel' },
                {
                    text: deleteLabel,
                    style: 'destructive',
                    onPress: () => {
                        void Promise.resolve(deleteSection(section.id));
                        if (editingSectionId === section.id) closeEditor();
                    },
                },
            ],
        );
    }, [canManage, cancelLabel, closeEditor, deleteConfirm, deleteLabel, deleteSection, editingSectionId, sectionTitle]);

    const moveSection = React.useCallback((sectionId: string, offset: -1 | 1) => {
        if (!canManage) return;
        const currentIndex = sections.findIndex((section) => section.id === sectionId);
        const nextIndex = currentIndex + offset;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sections.length) return;

        const nextIds = sections.map((section) => section.id);
        const [moved] = nextIds.splice(currentIndex, 1);
        if (!moved) return;
        nextIds.splice(nextIndex, 0, moved);

        void Promise.resolve(reorderSections(projectId, nextIds)).catch(() => {
            Alert.alert(sectionTitle, sectionReorderFailed);
        });
    }, [canManage, projectId, reorderSections, sectionReorderFailed, sectionTitle, sections]);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
            accessibilityViewIsModal
        >
            <View style={styles.overlay}>
                <View style={[styles.sectionManagerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <View style={styles.sectionManagerHeader}>
                        <Text style={[styles.sectionManagerTitle, { color: tc.text }]} accessibilityRole="header">
                            {sectionTitle}
                        </Text>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={cancelLabel}
                            onPress={onClose}
                            style={styles.sectionManagerCloseButton}
                        >
                            <Ionicons name="close" size={20} color={tc.secondaryText} />
                        </TouchableOpacity>
                    </View>

                    {canManage ? (
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={addSectionLabel}
                            onPress={openCreate}
                            style={[styles.sectionManagerAddButton, { backgroundColor: filledButton.backgroundColor, borderColor: filledButton.backgroundColor }]}
                            testID="project-section-add-button"
                        >
                            <Ionicons name="add" size={16} color={filledButton.textColor ?? tc.onTint} />
                            <Text style={[styles.sectionManagerAddButtonText, { color: filledButton.textColor ?? tc.onTint }]} numberOfLines={1}>
                                {addSectionLabel}
                            </Text>
                        </TouchableOpacity>
                    ) : null}

                    {showEditor ? (
                        <View style={[styles.sectionEditor, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                            <Text style={[styles.sectionEditorLabel, { color: tc.secondaryText }]}>
                                {editing ? sectionTitle : addSectionLabel}
                            </Text>
                            <TextInput
                                value={draft}
                                onChangeText={setDraft}
                                placeholder={sectionPlaceholder}
                                placeholderTextColor={tc.secondaryText}
                                style={[styles.sectionEditorInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                autoCapitalize="sentences"
                                returnKeyType="done"
                                onSubmitEditing={saveSection}
                                testID="project-section-title-input"
                            />
                            <View style={styles.sectionEditorActions}>
                                <TouchableOpacity
                                    accessibilityRole="button"
                                    accessibilityLabel={cancelLabel}
                                    onPress={closeEditor}
                                    style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.secondaryText }]}>{cancelLabel}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    accessibilityRole="button"
                                    accessibilityLabel={saveLabel}
                                    disabled={!draft.trim() || saving}
                                    onPress={saveSection}
                                    style={[
                                        styles.linkModalButton,
                                        { backgroundColor: filledButton.backgroundColor },
                                        (!draft.trim() || saving) && styles.linkModalButtonDisabled,
                                    ]}
                                    testID="project-section-save-button"
                                >
                                    <Text style={[styles.linkModalButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{saveLabel}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : null}

                    {sections.length === 0 ? (
                        <View style={[styles.sectionManagerEmpty, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                            <Text style={[styles.helperText, { color: tc.secondaryText }]}>{noneLabel}</Text>
                        </View>
                    ) : (
                        <ScrollView
                            style={[styles.sectionManagerList, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                            contentContainerStyle={styles.sectionManagerListContent}
                        >
                            {sections.map((section, index) => {
                                const canMoveUp = index > 0;
                                const canMoveDown = index < sections.length - 1;
                                return (
                                    <View
                                        key={section.id}
                                        style={[styles.sectionManagerRow, { borderBottomColor: tc.border }]}
                                        testID={`project-section-row-${section.id}`}
                                    >
                                        <View style={styles.sectionManagerRowTitleWrap}>
                                            <Text style={[styles.sectionManagerRowTitle, { color: tc.text }]} numberOfLines={1}>
                                                {section.title}
                                            </Text>
                                        </View>
                                        {canManage ? (
                                            <View style={styles.sectionManagerRowActions}>
                                                <View style={styles.sectionManagerOrderButtons}>
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${moveUpLabel}: ${section.title}`}
                                                        accessibilityState={{ disabled: !canMoveUp }}
                                                        disabled={!canMoveUp}
                                                        onPress={() => moveSection(section.id, -1)}
                                                        style={[
                                                            styles.sectionManagerIconButton,
                                                            { borderColor: tc.border, backgroundColor: tc.cardBg },
                                                            !canMoveUp && styles.sectionManagerIconButtonDisabled,
                                                        ]}
                                                        testID={`project-section-move-up-${section.id}`}
                                                    >
                                                        <Ionicons name="chevron-up" size={16} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`${moveDownLabel}: ${section.title}`}
                                                        accessibilityState={{ disabled: !canMoveDown }}
                                                        disabled={!canMoveDown}
                                                        onPress={() => moveSection(section.id, 1)}
                                                        style={[
                                                            styles.sectionManagerIconButton,
                                                            { borderColor: tc.border, backgroundColor: tc.cardBg },
                                                            !canMoveDown && styles.sectionManagerIconButtonDisabled,
                                                        ]}
                                                        testID={`project-section-move-down-${section.id}`}
                                                    >
                                                        <Ionicons name="chevron-down" size={16} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                </View>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`${editLabel}: ${section.title}`}
                                                    onPress={() => openEdit(section)}
                                                    style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                    testID={`project-section-edit-${section.id}`}
                                                >
                                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{editLabel}</Text>
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`${deleteLabel}: ${section.title}`}
                                                    onPress={() => confirmDeleteSection(section)}
                                                    style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                    testID={`project-section-delete-${section.id}`}
                                                >
                                                    <Text style={[styles.smallButtonText, { color: tc.danger }]}>{deleteLabel}</Text>
                                                </TouchableOpacity>
                                            </View>
                                        ) : null}
                                    </View>
                                );
                            })}
                        </ScrollView>
                    )}
                </View>
            </View>
        </Modal>
    );
}

function ProjectDetailScrollFrame({
    backgroundColor,
    children,
    keyboardBottomInset,
    onScroll,
    reorderMode,
    reorderOwnsScroll,
    scrollRef,
}: {
    backgroundColor: string;
    children: React.ReactNode;
    keyboardBottomInset: number;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    reorderMode: boolean;
    reorderOwnsScroll: boolean;
    scrollRef: React.RefObject<ScrollView | null>;
}) {
    const androidScrollViewFocusProps: Partial<ScrollViewProps> & { scrollsChildToFocus?: boolean } = (
        Platform.OS === 'android' ? { scrollsChildToFocus: false } : {}
    );
    const scrollProps = {
        style: [{ flex: 1 }, { backgroundColor }],
        contentContainerStyle: [
            styles.projectDetailScroll,
            { backgroundColor },
            keyboardBottomInset > 0 ? { paddingBottom: 24 + keyboardBottomInset } : null,
        ],
        keyboardShouldPersistTaps: 'always' as const,
    };

    const scrollNode = reorderOwnsScroll ? (
        // Section-less reorder uses a single self-scrolling DraggableFlatList that owns the
        // scroll, so the frame is a plain flex column instead of a nested scroll container.
        <View style={[{ flex: 1 }, { backgroundColor }]}>
            {children}
        </View>
    ) : reorderMode ? (
        // Multi-section reorder needs the nested draggable wrapper required by the library:
        // https://github.com/computerjazz/react-native-draggable-flatlist#nesting-draggableflatlists
        <NestableScrollContainer {...scrollProps}>
            {children}
        </NestableScrollContainer>
    ) : (
        // Normal mode stays on a plain ScrollView so Swipeable rows keep horizontal gestures.
        <ScrollView
            {...scrollProps}
            ref={scrollRef}
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            directionalLockEnabled
            nestedScrollEnabled
            onScroll={onScroll}
            scrollEventThrottle={16}
            {...androidScrollViewFocusProps}
        >
            {children}
        </ScrollView>
    );

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'android' ? 'height' : undefined}
            keyboardVerticalOffset={0}
            style={[{ flex: 1 }, { backgroundColor }]}
        >
            {scrollNode}
        </KeyboardAvoidingView>
    );
}

export function ProjectDetailModal({
    addProjectFileAttachment,
    addSection,
    closeProjectDetail,
    commitSelectedProjectNotes,
    formatProjectDate,
    handleArchiveSelectedProject,
    handleSelectedProjectNotesApplyAction,
    handleSelectedProjectNotesApplyAutocomplete,
    handleSelectedProjectNotesChange,
    handleSelectedProjectNotesSelectionChange,
    handleSelectedProjectNotesUndo,
    handleSetProjectStatus,
    isSelectedProjectNotesFocused,
    modalHeaderStyle,
    notesExpanded,
    notesFullscreen,
    onCloseNotesFullscreen,
    onDuplicateProject,
    onDownloadAttachment,
    onOpenAreaPicker,
    onOpenAttachment,
    onOpenProjectQuickAdd,
    onOpenTagPicker,
    onRemoveProjectAttachment,
    deleteSection,
    reorderSections,
    onSetLinkInput,
    onSetLinkModalVisible,
    onSetNotesExpanded,
    onSetSelectedProject,
    onSetSelectedProjectNotesFocused,
    onSetShowDueDatePicker,
    onSetShowNotesFullscreen,
    onSetShowNotesPreview,
    onSetShowProjectMeta,
    onSetShowReviewPicker,
    onSetShowStatusMenu,
    onToggleShowCompletedTasks,
    onProjectTaskSortByChange,
    overlayVisible,
    presentationStyle,
    projectTaskSortBy,
    selectedProjectAreaName,
    selectedProject,
    selectedProjectSections = [],
    selectedProjectTasks,
    selectedProjectNotes,
    selectedProjectNotesDirection,
    selectedProjectNotesInputRef,
    selectedProjectNotesSelection,
    selectedProjectNotesTextDirectionStyle,
    selectedProjectNotesUndoDepth,
    showDueDatePicker,
    showNotesPreview,
    showProjectMeta,
    showReviewPicker,
    showStatusMenu,
    showCompletedTasks,
    statusPalette,
    t,
    tc,
    updateProject,
    updateSection,
}: ProjectDetailModalProps) {
    const filledButton = useFilledButtonColors();
    const [projectTaskReorderMode, setProjectTaskReorderMode] = React.useState(false);
    const [projectTaskFilterOpenSignal, setProjectTaskFilterOpenSignal] = React.useState(0);
    const [projectTaskFilterActiveCount, setProjectTaskFilterActiveCount] = React.useState(0);
    const [projectSortModalVisible, setProjectSortModalVisible] = React.useState(false);
    const [projectTaskBulkBarProps, setProjectTaskBulkBarProps] = React.useState<TaskListBulkBarProps | null>(null);
    const [sectionManagerVisible, setSectionManagerVisible] = React.useState(false);
    const projectDetailScrollRef = React.useRef<ScrollView | null>(null);
    const projectDetailScrollOffsetRef = React.useRef(0);
    const pendingProjectDetailScrollRestoreRef = React.useRef<number | null>(null);
    const projectTaskBulkBarPropsRef = React.useRef<TaskListBulkBarProps | null>(null);
    const [projectDetailScrollWindow, setProjectDetailScrollWindow] = React.useState({
        offsetY: 0,
        viewportHeight: 0,
    });
    const projectDetailKeyboardTopRef = React.useRef(Dimensions.get('window').height);
    const projectDetailKeyboardVisibleRef = React.useRef(false);
    const projectDetailFocusedInputHandleRef = React.useRef<number | null>(null);
    const [projectDetailKeyboardBottomInset, setProjectDetailKeyboardBottomInset] = React.useState(0);
    const safeAreaEdges = getProjectDetailModalSafeAreaEdges(presentationStyle);
    const taskListOptions = getProjectDetailTaskListOptions(selectedProject, showCompletedTasks);
    const canManageProjectSections = selectedProject?.status !== 'archived';
    // Section-less projects reorder through one self-scrolling DraggableFlatList; sectioned
    // projects keep the nested-list layout (one draggable list per section).
    const projectReorderOwnsScroll = projectTaskReorderMode && selectedProjectSections.length === 0;
    const showCompletedLabel = showCompletedTasks
        ? tFallback(t, 'common.hideCompleted', 'Hide completed')
        : tFallback(t, 'common.showCompleted', 'Show completed');
    const sequentialScopeLabel = tFallback(t, 'projects.sequentialScope', 'Sequential Scope');
    const sequentialAcrossSectionsLabel = tFallback(t, 'projects.sequentialAcrossSections', 'Across sections');
    const sequentialWithinSectionsLabel = tFallback(t, 'projects.sequentialWithinSections', 'Within sections');
    const sequentialScopeHelpLabel = tFallback(t, 'projects.sequentialScopeHelpLabel', 'Sequential scope help');
    const sequentialScopeHelpText = tFallback(
        t,
        'projects.sequentialScopeHelpText',
        'Across sections surfaces one available action for the whole project. Within sections surfaces one available action per section.'
    );
    const projectTypeHelpLabel = tFallback(t, 'projects.projectTypeHelpLabel', 'Project type help');
    const projectTypeHelpText = tFallback(
        t,
        'projects.projectTypeHelpText',
        'Sequential projects surface one available action at a time. Parallel projects can surface multiple independent Next tasks.'
    );
    const sequenceCueLabels = React.useMemo<Record<ProjectSequenceTaskCue, string>>(
        () => ({
            available: tFallback(t, 'projects.availableNextAction', 'Available next action'),
            later: tFallback(t, 'projects.laterInSequence', 'Later in sequence'),
        }),
        [t]
    );
    const resolvedSequentialScope = selectedProject?.sequentialScope === 'section' ? 'section' : 'project';
    const projectTaskSequenceCues = React.useMemo<Map<string, ProjectSequenceTaskCue>>(() => {
        if (!selectedProject || projectTaskSortBy !== 'default') return new Map();
        return getSequentialProjectTaskCues(selectedProject, selectedProjectTasks ?? []);
    }, [projectTaskSortBy, selectedProject, selectedProjectTasks]);
    const getTaskSequenceCue = React.useCallback(
        (task: Task) => projectTaskSequenceCues.get(task.id),
        [projectTaskSequenceCues]
    );
    const showProjectTypeHelp = React.useCallback(() => {
        Alert.alert(projectTypeHelpLabel, projectTypeHelpText);
    }, [projectTypeHelpLabel, projectTypeHelpText]);
    const showSequentialScopeHelp = React.useCallback(() => {
        Alert.alert(sequentialScopeHelpLabel, sequentialScopeHelpText);
    }, [sequentialScopeHelpLabel, sequentialScopeHelpText]);
    const sortLabel = tFallback(t, 'sort.label', 'Sort');
    const projectSectionsLabel = tFallback(t, 'projects.sectionsLabel', 'Sections');
    const addProjectTaskLabel = tFallback(t, 'nav.addTask', 'Add task');
    const projectOrderLabel = tFallback(t, 'projects.reorderTasks', 'Order');
    const hasProjectTaskOrderTargets = Boolean(
        selectedProjectSections.length > 1
        || (selectedProjectTasks ?? []).some((task) => (
            !task.deletedAt && (taskListOptions.includeDone || task.status !== 'done')
        ))
    );
    const openProjectQuickAdd = React.useCallback(() => {
        if (!selectedProject || !taskListOptions.allowAdd) return;
        onOpenProjectQuickAdd(selectedProject);
    }, [onOpenProjectQuickAdd, selectedProject, taskListOptions.allowAdd]);
    const openProjectTaskFilters = React.useCallback(() => {
        setProjectTaskFilterOpenSignal((value) => value + 1);
    }, []);
    const handleProjectFilterStateChange = React.useCallback(
        ({ activeCount }: { activeCount: number; hasActive: boolean }) => {
            setProjectTaskFilterActiveCount(activeCount);
        },
        []
    );
    const handleProjectBulkBarPropsChange = React.useCallback((props: TaskListBulkBarProps | null) => {
        const hadBulkBar = projectTaskBulkBarPropsRef.current !== null;
        const hasBulkBar = props !== null;
        if (hadBulkBar !== hasBulkBar && projectDetailScrollOffsetRef.current > 0) {
            pendingProjectDetailScrollRestoreRef.current = projectDetailScrollOffsetRef.current;
        }
        projectTaskBulkBarPropsRef.current = props;
        setProjectTaskBulkBarProps(props);
    }, []);
    const openProjectTaskSort = React.useCallback(() => {
        setProjectSortModalVisible(true);
    }, []);
    const handleProjectTaskSortSelect = React.useCallback((option: TaskSortBy) => {
        setProjectSortModalVisible(false);
        onProjectTaskSortByChange(option);
    }, [onProjectTaskSortByChange]);
    const toggleProjectTaskReorderMode = React.useCallback(() => {
        setProjectTaskReorderMode((value) => !value);
    }, []);
    const filterButtonLabel = tFallback(t, 'filters.label', 'Filters');
    const doneButtonLabel = tFallback(t, 'common.done', 'Done');
    const projectTypeLabel = tFallback(t, 'projects.projectTypeLabel', 'Type');
    const projectActionsLabel = tFallback(t, 'projects.actionsLabel', 'Actions');
    const projectActionsHelpText = tFallback(
        t,
        'projects.archiveHelp',
        'Completing a project files it in Archived — reactivate it anytime.'
    );
    const projectStatusLabel = selectedProject
        ? (selectedProject.status === 'active'
            ? t('status.active')
            : selectedProject.status === 'waiting'
                ? t('status.waiting')
                : selectedProject.status === 'someday'
                    ? t('status.someday')
                    : tFallback(t, 'status.archived', 'Archived'))
        : '';
    const sortIsActive = projectTaskSortBy !== 'default';
    const projectTaskPinnedToolbar = selectedProject ? (
        <View style={[styles.projectTaskPinnedToolbar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
            <TouchableOpacity
                accessibilityLabel={projectTaskFilterActiveCount > 0 ? `${filterButtonLabel}: ${projectTaskFilterActiveCount}` : filterButtonLabel}
                accessibilityRole="button"
                onPress={openProjectTaskFilters}
                hitSlop={8}
                style={[
                    styles.projectTaskPinnedControl,
                    {
                        backgroundColor: projectTaskFilterActiveCount > 0 ? `${tc.tint}20` : tc.filterBg,
                        borderColor: projectTaskFilterActiveCount > 0 ? tc.tint : tc.border,
                    },
                ]}
                testID="project-task-filter-button"
            >
                <View style={styles.projectTaskPinnedControlIcon}>
                    <Ionicons
                        name="options-outline"
                        size={20}
                        color={projectTaskFilterActiveCount > 0 ? tc.tint : tc.secondaryText}
                    />
                    {projectTaskFilterActiveCount > 0 ? (
                        <View style={[styles.projectTaskPinnedBadge, { backgroundColor: tc.tint }]}>
                            <Text style={[styles.projectTaskPinnedBadgeText, { color: tc.onTint }]}>
                                {projectTaskFilterActiveCount}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </TouchableOpacity>
            <TouchableOpacity
                accessibilityLabel={`${sortLabel}: ${t(`sort.${projectTaskSortBy}`)}`}
                accessibilityRole="button"
                accessibilityState={{ selected: sortIsActive }}
                onPress={openProjectTaskSort}
                hitSlop={8}
                style={[
                    styles.projectTaskPinnedControl,
                    {
                        backgroundColor: sortIsActive ? `${tc.tint}20` : tc.filterBg,
                        borderColor: sortIsActive ? tc.tint : tc.border,
                    },
                ]}
                testID="project-task-sort-toggle"
            >
                <View style={styles.projectTaskPinnedControlIcon}>
                    <Ionicons
                        name="swap-vertical-outline"
                        size={20}
                        color={sortIsActive ? tc.tint : tc.secondaryText}
                    />
                </View>
            </TouchableOpacity>
            {selectedProject.status !== 'archived' ? (
                <TouchableOpacity
                    accessibilityLabel={showCompletedLabel}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: showCompletedTasks }}
                    onPress={onToggleShowCompletedTasks}
                    hitSlop={8}
                    style={[
                        styles.projectTaskPinnedControl,
                        {
                            backgroundColor: showCompletedTasks ? tc.tint : tc.filterBg,
                            borderColor: showCompletedTasks ? tc.tint : tc.border,
                        },
                    ]}
                    testID="project-pinned-show-completed-toggle"
                >
                    <View style={styles.projectTaskPinnedControlIcon}>
                        <Ionicons
                            name={showCompletedTasks ? 'eye-outline' : 'eye-off-outline'}
                            size={20}
                            color={showCompletedTasks ? tc.onTint : tc.secondaryText}
                        />
                    </View>
                </TouchableOpacity>
            ) : null}
            {taskListOptions.enableProjectReorder && hasProjectTaskOrderTargets && !sortIsActive ? (
                <TouchableOpacity
                    accessibilityLabel={projectTaskReorderMode ? doneButtonLabel : projectOrderLabel}
                    accessibilityRole="button"
                    accessibilityState={{ selected: projectTaskReorderMode }}
                    onPress={toggleProjectTaskReorderMode}
                    hitSlop={8}
                    style={[
                        styles.projectTaskPinnedControl,
                        {
                            backgroundColor: projectTaskReorderMode ? tc.tint : tc.filterBg,
                            borderColor: projectTaskReorderMode ? tc.tint : tc.border,
                        },
                    ]}
                    testID="project-task-reorder-toggle"
                >
                    <View style={styles.projectTaskPinnedControlIcon}>
                        <Ionicons
                            name={projectTaskReorderMode ? 'checkmark' : 'reorder-three-outline'}
                            size={20}
                            color={projectTaskReorderMode ? tc.onTint : tc.secondaryText}
                        />
                    </View>
                </TouchableOpacity>
            ) : null}
            <View style={styles.projectTaskPinnedSpacer} />
            {taskListOptions.allowAdd ? (
                <TouchableOpacity
                    accessibilityLabel={addProjectTaskLabel}
                    accessibilityRole="button"
                    onPress={openProjectQuickAdd}
                    hitSlop={8}
                    style={[
                        styles.projectTaskPinnedAddButton,
                        { backgroundColor: filledButton.backgroundColor, borderColor: filledButton.backgroundColor },
                    ]}
                    testID="project-add-task-button"
                >
                    <Ionicons name="add" size={24} color={filledButton.textColor ?? tc.onTint} />
                </TouchableOpacity>
            ) : null}
        </View>
    ) : null;
    const projectTaskSelectionBulkBar = projectTaskBulkBarProps ? (
        <View testID="project-task-selection-bulk-bar">
            <TaskListBulkBar {...projectTaskBulkBarProps} />
        </View>
    ) : null;
    const setSelectedProjectSequentialScope = (sequentialScope: Project['sequentialScope']) => {
        if (!selectedProject) return;
        updateProject(selectedProject.id, { sequentialScope });
        onSetSelectedProject({ ...selectedProject, sequentialScope });
    };

    const restoreProjectDetailScrollOffset = React.useCallback((offsetY: number) => {
        if (!Number.isFinite(offsetY) || offsetY <= 0) return;
        const scrollToOffset = () => {
            projectDetailScrollRef.current?.scrollTo({ y: offsetY, animated: false });
        };
        scrollToOffset();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(scrollToOffset);
        }
    }, []);

    React.useLayoutEffect(() => {
        const offsetY = pendingProjectDetailScrollRestoreRef.current;
        if (offsetY === null) return;
        pendingProjectDetailScrollRestoreRef.current = null;
        if (projectReorderOwnsScroll) return;
        restoreProjectDetailScrollOffset(offsetY);
    }, [projectReorderOwnsScroll, projectTaskBulkBarProps, restoreProjectDetailScrollOffset]);

    const resetProjectDetailVirtualWindow = React.useCallback(() => {
        projectDetailScrollOffsetRef.current = 0;
        pendingProjectDetailScrollRestoreRef.current = null;
        setProjectDetailScrollWindow((current) => {
            if (current.offsetY === 0 && current.viewportHeight === 0) {
                return current;
            }
            return { offsetY: 0, viewportHeight: 0 };
        });
    }, []);

    React.useEffect(() => {
        resetProjectDetailVirtualWindow();
    }, [resetProjectDetailVirtualWindow, selectedProject?.id]);

    React.useEffect(() => {
        setProjectTaskReorderMode(false);
        setSectionManagerVisible(false);
    }, [overlayVisible, selectedProject?.id]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        if (typeof Keyboard?.addListener !== 'function') return;
        const updateKeyboardTop = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const frame = getAndroidKeyboardFrame(event);
            projectDetailKeyboardTopRef.current = frame.keyboardTop;
            projectDetailKeyboardVisibleRef.current = frame.visible;
            setProjectDetailKeyboardBottomInset(frame.inset);
            const focusedInputHandle = projectDetailFocusedInputHandleRef.current;
            if (projectDetailKeyboardVisibleRef.current && focusedInputHandle) {
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(() => scrollProjectInputIntoView(focusedInputHandle));
                } else {
                    setTimeout(() => scrollProjectInputIntoView(focusedInputHandle), 0);
                }
            }
        };
        const resetKeyboardTop = () => {
            projectDetailKeyboardTopRef.current = Dimensions.get('window').height;
            projectDetailKeyboardVisibleRef.current = false;
            setProjectDetailKeyboardBottomInset(0);
        };
        const showListener = Keyboard.addListener('keyboardDidShow', updateKeyboardTop);
        const changeListener = Keyboard.addListener('keyboardDidChangeFrame', updateKeyboardTop);
        const hideListener = Keyboard.addListener('keyboardDidHide', resetKeyboardTop);
        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
        };
    }, []);

    const scrollProjectInputIntoView = React.useCallback((targetInput?: number | string) => {
        if (Platform.OS !== 'android') return;
        const targetHandle = typeof targetInput === 'number'
            ? targetInput
            : typeof targetInput === 'string'
                ? Number(targetInput)
                : NaN;
        if (!Number.isFinite(targetHandle) || targetHandle <= 0) return;
        projectDetailFocusedInputHandleRef.current = targetHandle;
        if (!projectDetailKeyboardVisibleRef.current) return;
        const scrollView = projectDetailScrollRef.current;
        if (!scrollView) return;
        const scrollHandle = findNodeHandle(scrollView);
        if (!scrollHandle) return;

        const measureAndScroll = () => {
            UIManager.measureInWindow(targetHandle, (_x, targetY, _w, targetH) => {
                if (!Number.isFinite(targetY) || !Number.isFinite(targetH)) return;
                UIManager.measureInWindow(scrollHandle, (_sx, scrollY, _sw, scrollH) => {
                    if (!Number.isFinite(scrollY) || !Number.isFinite(scrollH)) return;
                    const visibleTop = scrollY;
                    const keyboardTop = projectDetailKeyboardTopRef.current;
                    const visibleBottom = Math.min(scrollY + scrollH, keyboardTop);
                    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                    const bottomClearance = visibleHeight * 0.18;
                    const effectiveVisibleBottom = visibleBottom - bottomClearance;
                    const targetBottom = targetY + targetH;
                    if (targetBottom <= effectiveVisibleBottom) return;
                    const delta = targetBottom - effectiveVisibleBottom;
                    const nextOffset = Math.max(0, projectDetailScrollOffsetRef.current + delta);
                    projectDetailScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                });
            });
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                measureAndScroll();
                requestAnimationFrame(measureAndScroll);
            });
        } else {
            setTimeout(measureAndScroll, 0);
        }
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'android' || projectDetailKeyboardBottomInset <= 0) return;
        const focusedInputHandle = projectDetailFocusedInputHandleRef.current;
        if (!focusedInputHandle) return;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => scrollProjectInputIntoView(focusedInputHandle));
        } else {
            setTimeout(() => scrollProjectInputIntoView(focusedInputHandle), 0);
        }
    }, [projectDetailKeyboardBottomInset, scrollProjectInputIntoView]);

    return (
        <Modal
            visible={overlayVisible}
            animationType="slide"
            presentationStyle={presentationStyle}
            transparent={false}
            allowSwipeDismissal
            onRequestClose={closeProjectDetail}
        >
            {/* Android Modal content needs its own gesture root; the screen root does not cover Modal.
                https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/installation/#android */}
            <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardAccessoryHost backgroundColor={tc.bg}>
                    <SafeAreaView style={[styles.projectDetailRoot, { backgroundColor: tc.bg }]} edges={safeAreaEdges}>
                        {selectedProject ? (
                            <>
                                <View style={modalHeaderStyle}>
                                    <TouchableOpacity
                                        onPress={closeProjectDetail}
                                        style={styles.backButton}
                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('common.back') || 'Back'}
                                    >
                                        <Ionicons name="chevron-back" size={24} color={tc.tint} />
                                    </TouchableOpacity>
                                    <TextInput
                                        style={[styles.modalTitle, { color: tc.text, marginLeft: 8, flex: 1 }]}
                                        value={selectedProject.title}
                                        onChangeText={(text) => onSetSelectedProject({ ...selectedProject, title: text })}
                                        onSubmitEditing={() => {
                                            const title = selectedProject.title.trim();
                                            if (!title) return;
                                            updateProject(selectedProject.id, { title });
                                            onSetSelectedProject({ ...selectedProject, title });
                                        }}
                                        onEndEditing={() => {
                                            const title = selectedProject.title.trim();
                                            if (!title) return;
                                            updateProject(selectedProject.id, { title });
                                            onSetSelectedProject({ ...selectedProject, title });
                                        }}
                                        returnKeyType="done"
                                    />
                                </View>
                                {projectTaskPinnedToolbar}
                                {projectTaskSelectionBulkBar}
                                <ProjectDetailScrollFrame
                                    backgroundColor={tc.bg}
                                    keyboardBottomInset={projectDetailKeyboardBottomInset}
                                    onScroll={(event) => {
                                        const offsetY = event.nativeEvent.contentOffset.y;
                                        const viewportHeight = event.nativeEvent.layoutMeasurement?.height
                                            ?? projectDetailScrollWindow.viewportHeight;
                                        projectDetailScrollOffsetRef.current = offsetY;
                                        setProjectDetailScrollWindow((current) => {
                                            if (
                                                Math.abs(current.offsetY - offsetY) < 32
                                                && Math.abs(current.viewportHeight - viewportHeight) < 1
                                            ) {
                                                return current;
                                            }
                                            return { offsetY, viewportHeight };
                                        });
                                    }}
                                    reorderMode={projectTaskReorderMode}
                                    reorderOwnsScroll={projectReorderOwnsScroll}
                                    scrollRef={projectDetailScrollRef}
                                >
                                <View style={[styles.detailsToggle, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                    <TouchableOpacity
                                        style={styles.detailsToggleButton}
                                        onPress={() => onSetShowProjectMeta((prev) => !prev)}
                                        accessibilityRole="button"
                                        accessibilityState={{ expanded: showProjectMeta }}
                                        testID="project-details-toggle"
                                    >
                                        <Text style={[styles.detailsToggleText, { color: tc.text }]}>
                                            {showProjectMeta ? '▾' : '▸'} {t('taskEdit.details')}
                                        </Text>
                                    </TouchableOpacity>
                                    <View
                                        style={[
                                            styles.statusPicker,
                                            {
                                                backgroundColor: statusPalette[selectedProject.status]?.bg ?? tc.filterBg,
                                                borderColor: statusPalette[selectedProject.status]?.border ?? tc.border,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[styles.statusPickerText, { color: statusPalette[selectedProject.status]?.text ?? tc.text }]}
                                            numberOfLines={1}
                                        >
                                            {projectStatusLabel}
                                        </Text>
                                    </View>
                                </View>

                                {showProjectMeta && (
                                    <>
                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <View style={styles.reviewLabelRow}>
                                                <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('projects.statusLabel')}</Text>
                                                <TouchableOpacity
                                                    onPress={() => onSetShowStatusMenu((prev) => !prev)}
                                                    style={[
                                                        styles.statusPicker,
                                                        {
                                                            backgroundColor: statusPalette[selectedProject.status]?.bg ?? tc.filterBg,
                                                            borderColor: statusPalette[selectedProject.status]?.border ?? tc.border,
                                                        },
                                                    ]}
                                                    testID="project-status-picker"
                                                >
                                                    <Text style={[styles.statusPickerText, { color: statusPalette[selectedProject.status]?.text ?? tc.text }]}>
                                                        {projectStatusLabel}
                                                    </Text>
                                                    <Text style={[styles.statusPickerText, { color: statusPalette[selectedProject.status]?.text ?? tc.text }]}>▾</Text>
                                                </TouchableOpacity>
                                            </View>
                                            {showStatusMenu && (
                                                <View style={[styles.statusMenu, { backgroundColor: tc.inputBg, borderColor: tc.border, marginHorizontal: 0, marginTop: 8, marginBottom: 0 }]}>
                                                    {(['active', 'waiting', 'someday'] as const).map((status) => {
                                                        const isActive = selectedProject.status === status;
                                                        const palette = statusPalette[status];
                                                        return (
                                                            <TouchableOpacity
                                                                key={status}
                                                                onPress={() => handleSetProjectStatus(status)}
                                                                style={[styles.statusMenuItem, isActive && { backgroundColor: tc.filterBg }]}
                                                            >
                                                                <View style={[styles.statusDot, { backgroundColor: palette?.border ?? tc.border }]} />
                                                                <Text style={[styles.statusMenuText, { color: palette?.text ?? tc.text }]}>
                                                                    {status === 'active'
                                                                        ? t('status.active')
                                                                        : status === 'waiting'
                                                                            ? t('status.waiting')
                                                                            : t('status.someday')}
                                                                </Text>
                                                            </TouchableOpacity>
                                                        );
                                                    })}
                                                </View>
                                            )}

                                            <View style={[styles.reviewLabelRow, styles.projectSettingsRowSpacing]}>
                                                <Text style={[styles.reviewLabel, { color: tc.text }]}>{projectTypeLabel}</Text>
                                                <View style={styles.projectTypeControls}>
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        onPress={() => {
                                                            updateProject(selectedProject.id, { isSequential: !selectedProject.isSequential });
                                                            onSetSelectedProject({ ...selectedProject, isSequential: !selectedProject.isSequential });
                                                        }}
                                                        style={[
                                                            styles.sequentialToggle,
                                                            {
                                                                backgroundColor: selectedProject.isSequential ? tc.tint : tc.filterBg,
                                                                borderColor: selectedProject.isSequential ? tc.tint : tc.border,
                                                            },
                                                        ]}
                                                        testID="project-type-toggle"
                                                    >
                                                        <Text
                                                            style={[
                                                                styles.sequentialToggleText,
                                                                { color: selectedProject.isSequential ? tc.onTint : tc.secondaryText },
                                                            ]}
                                                        >
                                                            {selectedProject.isSequential
                                                                ? tFallback(t, 'projects.sequential', 'Sequential')
                                                                : tFallback(t, 'projects.parallel', 'Parallel')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        accessibilityLabel={projectTypeHelpLabel}
                                                        accessibilityRole="button"
                                                        onPress={showProjectTypeHelp}
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        style={[
                                                            styles.projectTypeHelpButton,
                                                            { backgroundColor: tc.filterBg, borderColor: tc.border },
                                                        ]}
                                                    >
                                                        <Ionicons name="help-circle-outline" size={17} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]} testID="project-actions-section">
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{projectActionsLabel}</Text>
                                            <Text
                                                style={[styles.projectActionsHelper, { color: tc.secondaryText }]}
                                                testID="project-actions-helper"
                                            >
                                                {projectActionsHelpText}
                                            </Text>
                                            <View style={styles.projectManageActions}>
                                                <TouchableOpacity
                                                    onPress={() => onDuplicateProject(selectedProject.id)}
                                                    style={[styles.projectManageButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('projects.duplicate')}
                                                    testID="project-duplicate-button"
                                                >
                                                    <Ionicons name="copy-outline" size={16} color={tc.tint} />
                                                    <Text style={[styles.statusButtonText, { color: tc.tint }]}>
                                                        {t('projects.duplicate')}
                                                    </Text>
                                                </TouchableOpacity>
                                                {selectedProject.status === 'archived' ? (
                                                    <TouchableOpacity
                                                        onPress={() => handleSetProjectStatus('active')}
                                                        style={[styles.projectManageButton, styles.reactivateButton, { borderColor: tc.border }]}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('projects.reactivate')}
                                                        testID="project-reactivate-button"
                                                    >
                                                        <Ionicons name="refresh-outline" size={16} color="#3B82F6" />
                                                        <Text style={[styles.statusButtonText, styles.reactivateText]}>
                                                            {t('projects.reactivate')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ) : (
                                                    <TouchableOpacity
                                                        onPress={handleArchiveSelectedProject}
                                                        style={[styles.projectManageButton, styles.archiveButton, { borderColor: tc.border }]}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('projects.archive')}
                                                        testID="project-archive-button"
                                                    >
                                                        <Ionicons name="archive-outline" size={16} color="#6B7280" />
                                                        <Text style={[styles.statusButtonText, styles.archiveText]}>
                                                            {t('projects.archive')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                )}
                                            </View>
                                        </View>

                                        {selectedProject.isSequential && (
                                            <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                                <View style={styles.reviewLabelRow}>
                                                    <Text style={[styles.reviewLabel, { color: tc.text }]}>{sequentialScopeLabel}</Text>
                                                    <TouchableOpacity
                                                        accessibilityLabel={sequentialScopeHelpLabel}
                                                        accessibilityRole="button"
                                                        onPress={showSequentialScopeHelp}
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        style={[
                                                            styles.projectTypeHelpButton,
                                                            { backgroundColor: tc.filterBg, borderColor: tc.border },
                                                        ]}
                                                    >
                                                        <Ionicons name="help-circle-outline" size={17} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                </View>
                                                <View style={styles.sequentialScopeOptions}>
                                                    {(['project', 'section'] as const).map((scope) => {
                                                        const selected = resolvedSequentialScope === scope;
                                                        return (
                                                            <TouchableOpacity
                                                                key={scope}
                                                                accessibilityRole="button"
                                                                accessibilityState={{ selected }}
                                                                onPress={() => setSelectedProjectSequentialScope(scope)}
                                                                style={[
                                                                    styles.sequentialScopeButton,
                                                                    {
                                                                        backgroundColor: selected ? tc.tint : tc.inputBg,
                                                                        borderColor: selected ? tc.tint : tc.border,
                                                                    },
                                                                ]}
                                                            >
                                                                <Text
                                                                    style={[
                                                                        styles.sequentialScopeText,
                                                                        { color: selected ? tc.onTint : tc.text },
                                                                    ]}
                                                                >
                                                                    {scope === 'section'
                                                                        ? sequentialWithinSectionsLabel
                                                                        : sequentialAcrossSectionsLabel}
                                                                </Text>
                                                            </TouchableOpacity>
                                                        );
                                                    })}
                                                </View>
                                            </View>
                                        )}

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <View style={styles.reviewLabelRow}>
                                                <Text style={[styles.reviewLabel, { color: tc.text }]}>{projectSectionsLabel}</Text>
                                                {(canManageProjectSections || selectedProjectSections.length > 0) ? (
                                                    <TouchableOpacity
                                                        accessibilityRole="button"
                                                        accessibilityLabel={selectedProjectSections.length > 0
                                                            ? tFallback(t, 'settings.manage', 'Manage')
                                                            : tFallback(t, 'projects.addSection', 'Add Section')}
                                                        onPress={() => setSectionManagerVisible(true)}
                                                        style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                        testID="project-sections-button"
                                                    >
                                                        <Text style={[styles.smallButtonText, { color: tc.tint }]}>
                                                            {selectedProjectSections.length > 0
                                                                ? tFallback(t, 'settings.manage', 'Manage')
                                                                : tFallback(t, 'projects.addSection', 'Add Section')}
                                                        </Text>
                                                    </TouchableOpacity>
                                                ) : null}
                                            </View>
                                            {selectedProjectSections.length === 0 ? (
                                                <Text style={[styles.helperText, { color: tc.secondaryText }]}>
                                                    {tFallback(t, 'common.none', 'None')}
                                                </Text>
                                            ) : (
                                                <View style={styles.projectSectionPillRow}>
                                                    {selectedProjectSections.map((section) => (
                                                        <View
                                                            key={section.id}
                                                            style={[styles.projectSectionPill, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                        >
                                                            <Text style={[styles.projectSectionPillText, { color: tc.text }]} numberOfLines={1}>
                                                                {section.title}
                                                            </Text>
                                                        </View>
                                                    ))}
                                                </View>
                                            )}
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('projects.areaLabel')}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={onOpenAreaPicker}
                                            >
                                                <Text style={{ color: tc.text }}>{selectedProjectAreaName}</Text>
                                            </TouchableOpacity>
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('taskEdit.tagsLabel')}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={onOpenTagPicker}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {selectedProject.tagIds?.length ? selectedProject.tagIds.join(', ') : t('common.none')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>

                                        <View style={[styles.notesContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <View style={styles.notesHeaderRow}>
                                                <TouchableOpacity
                                                    style={[styles.notesHeader, { flex: 1 }]}
                                                    onPress={() => {
                                                        onSetNotesExpanded(!notesExpanded);
                                                        if (notesExpanded) onSetShowNotesPreview(false);
                                                    }}
                                                >
                                                    <Text style={[styles.notesTitle, { color: tc.text }]}>
                                                        {notesExpanded ? '▾' : '▸'} {t('project.notes')}
                                                    </Text>
                                                </TouchableOpacity>
                                                {notesExpanded && (
                                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                        <TouchableOpacity
                                                            onPress={() => onSetShowNotesPreview((value) => !value)}
                                                            style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                        >
                                                            <Text style={[styles.smallButtonText, { color: tc.tint }]}>
                                                                {showNotesPreview ? t('markdown.edit') : t('markdown.preview')}
                                                            </Text>
                                                        </TouchableOpacity>
                                                        <TouchableOpacity
                                                            onPress={() => onSetShowNotesFullscreen(true)}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('markdown.expand')}
                                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        >
                                                            <Ionicons name="expand-outline" size={20} color={tc.tint} />
                                                        </TouchableOpacity>
                                                    </View>
                                                )}
                                            </View>
                                            {notesExpanded && (
                                                showNotesPreview ? (
                                                    <View style={[styles.markdownPreview, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                                        <MarkdownText markdown={selectedProjectNotes} tc={tc} direction={selectedProjectNotesDirection} />
                                                    </View>
                                                ) : (
                                                    <>
                                                        <MarkdownFormatToolbar
                                                            selection={selectedProjectNotesSelection}
                                                            onSelectionChange={handleSelectedProjectNotesSelectionChange}
                                                            inputRef={selectedProjectNotesInputRef}
                                                            t={t}
                                                            tc={tc}
                                                            visible={isSelectedProjectNotesFocused}
                                                            canUndo={selectedProjectNotesUndoDepth > 0}
                                                            onUndo={handleSelectedProjectNotesUndo}
                                                            onApplyAction={handleSelectedProjectNotesApplyAction}
                                                        />
                                                        <MarkdownReferenceAutocomplete
                                                            value={selectedProjectNotes}
                                                            selection={selectedProjectNotesSelection}
                                                            inputRef={selectedProjectNotesInputRef}
                                                            visible={isSelectedProjectNotesFocused}
                                                            onApplyResult={handleSelectedProjectNotesApplyAutocomplete}
                                                            t={t}
                                                            tc={tc}
                                                        />
                                                        <TextInput
                                                            ref={selectedProjectNotesInputRef}
                                                            style={[
                                                                styles.notesInput,
                                                                selectedProjectNotesTextDirectionStyle,
                                                                { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                                                            ]}
                                                            multiline
                                                            placeholder={t('projects.notesPlaceholder')}
                                                            placeholderTextColor={tc.secondaryText}
                                                            value={selectedProjectNotes}
                                                            onFocus={() => onSetSelectedProjectNotesFocused(true)}
                                                            onBlur={() => {
                                                                onSetSelectedProjectNotesFocused(false);
                                                                commitSelectedProjectNotes();
                                                            }}
                                                            onChangeText={handleSelectedProjectNotesChange}
                                                            onSelectionChange={(event) => {
                                                                handleSelectedProjectNotesSelectionChange(event.nativeEvent.selection);
                                                            }}
                                                            selection={selectedProjectNotesSelection}
                                                            onEndEditing={commitSelectedProjectNotes}
                                                        />
                                                    </>
                                                )
                                            )}
                                        </View>

                                        <View style={[styles.attachmentsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <View style={styles.attachmentsHeader}>
                                                <Text style={[styles.attachmentsTitle, { color: tc.text }]}>{t('attachments.title')}</Text>
                                                <View style={styles.attachmentsActions}>
                                                    <TouchableOpacity
                                                        onPress={addProjectFileAttachment}
                                                        style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                    >
                                                        <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addFile')}</Text>
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                        onPress={() => {
                                                            onSetLinkModalVisible(true);
                                                            onSetLinkInput('');
                                                        }}
                                                        style={[styles.smallButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                                    >
                                                        <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addLink')}</Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                            {((selectedProject.attachments || []) as Attachment[]).filter((attachment) => !attachment.deletedAt).length === 0 ? (
                                                <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                                            ) : (
                                                <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                                                    {((selectedProject.attachments || []) as Attachment[])
                                                        .filter((attachment) => !attachment.deletedAt)
                                                        .map((attachment) => {
                                                            const isMissing = attachment.kind === 'file'
                                                                && (!attachment.uri || attachment.localStatus === 'missing');
                                                            const canDownload = isMissing && Boolean(attachment.cloudKey);
                                                            const isDownloading = attachment.localStatus === 'downloading';
                                                            return (
                                                                <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                                                    <TouchableOpacity
                                                                        style={styles.attachmentTitleWrap}
                                                                        onPress={() => onOpenAttachment(attachment)}
                                                                        disabled={isDownloading}
                                                                    >
                                                                        <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                                                            {getAttachmentDisplayTitle(attachment)}
                                                                        </Text>
                                                                        <AttachmentProgressIndicator attachmentId={attachment.id} />
                                                                    </TouchableOpacity>
                                                                    {isDownloading ? (
                                                                        <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                                            {t('common.loading')}
                                                                        </Text>
                                                                    ) : canDownload ? (
                                                                        <TouchableOpacity onPress={() => onDownloadAttachment(attachment)}>
                                                                            <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                                                                {t('attachments.download')}
                                                                            </Text>
                                                                        </TouchableOpacity>
                                                                    ) : isMissing ? (
                                                                        <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                                            {t('attachments.missing')}
                                                                        </Text>
                                                                    ) : null}
                                                                    <TouchableOpacity onPress={() => onRemoveProjectAttachment(attachment.id)}>
                                                                        <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                                                            {t('attachments.remove')}
                                                                        </Text>
                                                                    </TouchableOpacity>
                                                                </View>
                                                            );
                                                        })}
                                                </View>
                                            )}
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('taskEdit.dueDateLabel') || 'Due Date'}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={() => onSetShowDueDatePicker(true)}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {formatProjectDate(selectedProject.dueDate, t('common.notSet'))}
                                                </Text>
                                            </TouchableOpacity>
                                            {!!selectedProject.dueDate && (
                                                <TouchableOpacity
                                                    style={styles.clearReviewBtn}
                                                    onPress={() => {
                                                        updateProject(selectedProject.id, { dueDate: undefined });
                                                        onSetSelectedProject({ ...selectedProject, dueDate: undefined });
                                                    }}
                                                >
                                                    <Text style={[styles.clearReviewText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                                </TouchableOpacity>
                                            )}
                                            {showDueDatePicker && (
                                                <DateTimePicker
                                                    value={safeParseDate(selectedProject.dueDate) ?? new Date()}
                                                    mode="date"
                                                    display="default"
                                                        onChange={(_, date) => {
                                                            onSetShowDueDatePicker(false);
                                                            if (date) {
                                                                const iso = date.toISOString().slice(0, 10);
                                                                updateProject(selectedProject.id, { dueDate: iso });
                                                                onSetSelectedProject({ ...selectedProject, dueDate: iso });
                                                            }
                                                        }}
                                                />
                                            )}
                                        </View>

                                        <View style={[styles.reviewContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.reviewLabel, { color: tc.text }]}>{t('projects.reviewAt') || 'Review Date'}</Text>
                                            <TouchableOpacity
                                                style={[styles.reviewButton, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                onPress={() => onSetShowReviewPicker(true)}
                                            >
                                                <Text style={{ color: tc.text }}>
                                                    {formatProjectDate(selectedProject.reviewAt, t('common.notSet'))}
                                                </Text>
                                            </TouchableOpacity>
                                            {!!selectedProject.reviewAt && (
                                                <TouchableOpacity
                                                    style={styles.clearReviewBtn}
                                                    onPress={() => {
                                                        updateProject(selectedProject.id, { reviewAt: undefined });
                                                        onSetSelectedProject({ ...selectedProject, reviewAt: undefined });
                                                    }}
                                                >
                                                    <Text style={[styles.clearReviewText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                                </TouchableOpacity>
                                            )}
                                            {showReviewPicker && (
                                                <DateTimePicker
                                                    value={new Date(selectedProject.reviewAt || Date.now())}
                                                    mode="date"
                                                    display="default"
                                                        onChange={(_, date) => {
                                                            onSetShowReviewPicker(false);
                                                            if (date) {
                                                                const iso = date.toISOString();
                                                                updateProject(selectedProject.id, { reviewAt: iso });
                                                                onSetSelectedProject({ ...selectedProject, reviewAt: iso });
                                                            }
                                                        }}
                                                />
                                            )}
                                        </View>
                                    </>
                                )}

                                <View style={projectReorderOwnsScroll ? styles.projectReorderListFill : undefined}>
                                    <TaskList
                                        statusFilter="all"
                                        title={selectedProject.title}
                                        showHeader={false}
                                        showFilterButton={false}
                                        onFilterStateChange={handleProjectFilterStateChange}
                                        showTimeEstimateFilters={false}
                                        projectId={selectedProject.id}
                                        taskSource={selectedProjectTasks}
                                        allowAdd={false}
                                        staticList
                                        bulkBarPlacement="external"
                                        staticListVirtualization={{
                                            scrollOffsetY: projectDetailScrollWindow.offsetY,
                                            viewportHeight: projectDetailScrollWindow.viewportHeight,
                                        }}
                                        enableBulkActions
                                        enableProjectBulkOrganize={taskListOptions.allowAdd}
                                        onBulkBarPropsChange={handleProjectBulkBarPropsChange}
                                        externalFilterOpenSignal={projectTaskFilterOpenSignal}
                                        showSort={false}
                                        enableProjectReorder={taskListOptions.enableProjectReorder}
                                        projectSortBy={projectTaskSortBy}
                                        includeArchived={taskListOptions.includeArchived}
                                        includeDone={taskListOptions.includeDone}
                                        groupCompletedTasksLast={taskListOptions.groupCompletedTasksLast}
                                        getTaskSequenceCue={getTaskSequenceCue}
                                        sequenceCueLabels={sequenceCueLabels}
                                        onQuickAddInputFocus={scrollProjectInputIntoView}
                                        projectReorderMode={projectTaskReorderMode}
                                        projectReorderOwnsScroll={projectReorderOwnsScroll}
                                        onProjectReorderModeChange={setProjectTaskReorderMode}
                                    />
                                </View>
                                </ProjectDetailScrollFrame>
                                <TaskListSortModal
                                    onClose={() => setProjectSortModalVisible(false)}
                                    onSelect={handleProjectTaskSortSelect}
                                    sortBy={projectTaskSortBy}
                                    sortOptions={PROJECT_TASK_SORT_OPTIONS}
                                    t={t}
                                    themeColors={tc}
                                    visible={projectSortModalVisible}
                                />
                                <ProjectSectionManagerModal
                                    addSection={addSection}
                                    canManage={canManageProjectSections}
                                    deleteSection={deleteSection}
                                    onClose={() => setSectionManagerVisible(false)}
                                    projectId={selectedProject.id}
                                    reorderSections={reorderSections}
                                    sections={selectedProjectSections}
                                    t={t}
                                    tc={tc}
                                    updateSection={updateSection}
                                    visible={sectionManagerVisible}
                                />
                                <ExpandedMarkdownEditor
                                    isOpen={notesFullscreen}
                                    onClose={onCloseNotesFullscreen}
                                    value={selectedProjectNotes}
                                    onChange={handleSelectedProjectNotesChange}
                                    onCommit={commitSelectedProjectNotes}
                                    title={t('project.notes')}
                                    headerTitle={selectedProject.title || t('project.notes')}
                                    placeholder={t('projects.notesPlaceholder')}
                                    t={t}
                                    initialMode="edit"
                                    direction={selectedProjectNotesDirection}
                                    selection={selectedProjectNotesSelection}
                                    onSelectionChange={handleSelectedProjectNotesSelectionChange}
                                    canUndo={selectedProjectNotesUndoDepth > 0}
                                    onUndo={handleSelectedProjectNotesUndo}
                                    onApplyAction={handleSelectedProjectNotesApplyAction}
                                />
                            </>
                        ) : null}
                    </SafeAreaView>
                </KeyboardAccessoryHost>
            </GestureHandlerRootView>
        </Modal>
    );
}

export function getProjectDetailModalSafeAreaEdges(presentationStyle: ProjectDetailModalProps['presentationStyle']) {
    return presentationStyle === 'fullScreen'
        ? ['top', 'left', 'right', 'bottom'] as const
        : ['left', 'right', 'bottom'] as const;
}

export function getProjectDetailTaskListOptions(selectedProject: Project | null, showCompletedTasks = false) {
    const isArchived = selectedProject?.status === 'archived';
    return {
        allowAdd: !isArchived,
        enableProjectReorder: !isArchived,
        includeArchived: isArchived,
        includeDone: isArchived || showCompletedTasks,
        groupCompletedTasksLast: !isArchived && showCompletedTasks,
    };
}
