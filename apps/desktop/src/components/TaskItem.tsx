import { useState, memo, useEffect, useRef, useCallback, useMemo, type DragEvent, type ReactNode } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    Task,
    TaskStatus,
    TaskEditorFieldId,
    type TaskEditorPresentation,
    getProjectNextActionPromptData,
    getLocalizedWeekdayLabels,
    normalizeWeekStartSetting,
    Project,
    type RangeSelectionOptions,
    generateUUID,
    normalizeClockTimeInput,
    normalizeFocusTaskLimit,
    syncMarkdownChecklistWithCanonical,
    tFallback,
    formatFocusTaskLimitText,
    FOCUS_ELIGIBILITY_ACTIVE_STATUSES,
    getTaskFocusEligibility,
    parseQuickAddDateCommands,
    useTaskStore,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { useObsidianStore } from '../store/obsidian-store';
import { useLanguage } from '../contexts/language-context';
import { TaskItemEditor } from './Task/TaskItemEditor';
import { TaskItemDisplay } from './Task/TaskItemDisplay';
import { TaskItemEditorSurface } from './Task/TaskItemEditorSurface';
import { TaskItemFieldRenderer } from './Task/TaskItemFieldRenderer';
import { TaskItemOverlays } from './Task/TaskItemOverlays';
import { ProjectNextActionPrompt } from './Task/ProjectNextActionPrompt';
import { TaskQuickActionMenu } from './Task/TaskQuickActionMenu';
import {
    getRecurrenceRuleValue,
    getRecurrenceRRuleValue,
    getRecurrenceStrategyValue,
    toDateTimeLocalValue,
} from './Task/task-item-helpers';
import { useTaskItemAttachments } from './Task/useTaskItemAttachments';
import { useTaskItemRecurrence } from './Task/useTaskItemRecurrence';
import { useTaskItemAi } from './Task/useTaskItemAi';
import { useTaskItemEditState } from './Task/useTaskItemEditState';
import { useTaskItemProjectContext } from './Task/useTaskItemProjectContext';
import { useTaskItemFieldLayout } from './Task/useTaskItemFieldLayout';
import { useTaskItemSubmit } from './Task/useTaskItemSubmit';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { dispatchContextsTokenSelection } from '../lib/contexts-view-state';
import { reportError } from '../lib/report-error';
import { resolveNativeDateInputLocale } from '../lib/native-date-input-locale';
import { setCalendarTaskDragData } from '../lib/calendar-task-drag';
import { useTaskItemStoreState, useTaskItemUiState } from './Task/useTaskItemStoreState';
import type { TaskInputAcceptedSuggestion } from './Task/TaskInput';

interface TaskItemProps {
    task: Task;
    project?: Project;
    isSelected?: boolean;
    onSelect?: () => void;
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: (options?: RangeSelectionOptions) => void;
    showQuickDone?: boolean;
    showStatusSelect?: boolean;
    showProjectBadgeInActions?: boolean;
    showProjectBadgeInMetadata?: boolean;
    actionsOverlay?: boolean;
    dragHandle?: ReactNode;
    focusToggle?: {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
    readOnly?: boolean;
    compactMetaEnabled?: boolean;
    enableDoubleClickEdit?: boolean;
    showHoverHint?: boolean;
    editorPresentation?: TaskEditorPresentation;
    projectDeadlineLabel?: string;
}

type ProjectNextActionPromptState = {
    candidates: Task[];
    projectId: string;
    projectTitle: string;
    sectionId?: string;
};

export const TaskItem = memo(function TaskItem({
    task,
    project: propProject,
    isSelected,
    onSelect,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    showQuickDone = true,
    showStatusSelect = true,
    showProjectBadgeInActions = true,
    showProjectBadgeInMetadata = true,
    actionsOverlay = false,
    dragHandle,
    focusToggle,
    readOnly = false,
    compactMetaEnabled = true,
    enableDoubleClickEdit = false,
    showHoverHint = true,
    editorPresentation,
    projectDeadlineLabel,
}: TaskItemProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [autoFocusTitle, setAutoFocusTitle] = useState(false);
    const showObsidianNoteAttachment = useObsidianStore((state) => state.config.enabled);
    const [quickActionMenu, setQuickActionMenu] = useState<{ x: number; y: number } | null>(null);
    const taskRootRef = useRef<HTMLDivElement | null>(null);
    const quickActionReturnFocusRef = useRef<HTMLElement | null>(null);
    const modalEditorRef = useRef<HTMLDivElement | null>(null);
    const lastFocusedBeforeModalRef = useRef<HTMLElement | null>(null);
    const {
        updateTask,
        deleteTask,
        addTask,
        moveTask,
        projects,
        sections,
        areas,
        project: storeProject,
        projectArea,
        taskArea: storeTaskArea,
        settings,
        focusedCount,
        duplicateTask,
        promoteTaskToProject,
        resetTaskChecklist,
        restoreTask,
        highlightTaskId,
        setHighlightTask,
        addProject,
        addArea,
        addPerson,
        addSection,
        lockEditing,
        unlockEditing,
        projectMap,
        activeTasksByStatus,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
    } = useTaskItemStoreState({
        task,
        propProject,
        isEditing,
        hasQuickActionMenu: Boolean(quickActionMenu),
    });
    const {
        setProjectView,
        editingTaskId,
        setEditingTaskId,
        isTaskExpanded,
        setTaskExpanded,
        toggleTaskExpanded,
        showToast,
    } = useTaskItemUiState(task.id);
    const setSelectedProjectId = useCallback(
        (value: string | null) => setProjectView({ selectedProjectId: value }),
        [setProjectView]
    );
    const { t, language } = useLanguage();
    const nativeDateInputLocale = useMemo(() => {
        const systemLocale = typeof navigator !== 'undefined'
            ? String(navigator.languages?.[0] || navigator.language || '').trim()
            : '';
        return resolveNativeDateInputLocale({
            language,
            dateFormat: settings?.dateFormat,
            calendarSystem: settings?.calendarSystem,
            timeFormat: settings?.timeFormat,
            weekStart: normalizeWeekStartSetting(settings?.weekStart),
            systemLocale,
        });
    }, [language, settings?.calendarSystem, settings?.dateFormat, settings?.timeFormat, settings?.weekStart]);
    const recurrenceWeekdayLabels = useMemo(
        () => getLocalizedWeekdayLabels(language, 'long'),
        [language]
    );
    const {
        editAttachments,
        attachmentError,
        showLinkPrompt,
        editingLinkAttachmentId,
        linkPromptDefaultValue,
        linkPromptVariant,
        closeLinkPrompt,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        handleAddLinkAttachment,
        removeAttachment,
        openAttachment,
        resetAttachmentState,
        audioAttachment,
        audioSource,
        audioError,
        audioTranscribing,
        audioTranscriptionError,
        audioRef,
        openAudioExternally,
        handleAudioError,
        retryAudioTranscription,
        closeAudio,
        imageAttachment,
        imageSource,
        closeImage,
        textAttachment,
        textContent,
        textError,
        textLoading,
        openTextExternally,
        openImageExternally,
        closeText,
    } = useTaskItemAttachments({ task, t });
    const {
        editTitle,
        setEditTitle,
        editDueDate,
        setEditDueDate,
        editStartTime,
        setEditStartTime,
        editRelativeStartOffset,
        setEditRelativeStartOffset,
        editProjectId,
        setEditProjectId,
        editSectionId,
        setEditSectionId,
        editAreaId,
        setEditAreaId,
        editStatus,
        setEditStatus,
        editContexts,
        setEditContexts,
        editTags,
        setEditTags,
        editDescription,
        setEditDescription,
        editLocation,
        setEditLocation,
        editRecurrence,
        setEditRecurrence,
        editRecurrenceStrategy,
        setEditRecurrenceStrategy,
        editRecurrenceRRule,
        setEditRecurrenceRRule,
        editShowFutureRecurrence,
        setEditShowFutureRecurrence,
        editTimeEstimate,
        setEditTimeEstimate,
        editPriority,
        setEditPriority,
        editEnergyLevel,
        setEditEnergyLevel,
        editAssignedTo,
        setEditAssignedTo,
        editReviewAt,
        setEditReviewAt,
        editRepeatReminderMinutes,
        setEditRepeatReminderMinutes,
        showDescriptionPreview,
        setShowDescriptionPreview,
        resetEditState: resetLocalEditState,
    } = useTaskItemEditState({
        task,
        resetAttachmentState,
    });
    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showWaitingAssignmentPrompt, setShowWaitingAssignmentPrompt] = useState(false);
    const [projectNextActionPrompt, setProjectNextActionPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const [projectNextActionTitle, setProjectNextActionTitle] = useState('');
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const showTaskAge = settings?.appearance?.showTaskAge === true;
    const showFutureStarts = settings?.appearance?.showFutureStarts === true;
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const isCompact = settings?.appearance?.density === 'compact';
    const isHighlighted = highlightTaskId === task.id;
    const recurrenceRule = getRecurrenceRuleValue(task.recurrence);
    const recurrenceStrategy = getRecurrenceStrategyValue(task.recurrence);
    const isStagnant = (task.pushCount ?? 0) > 3;
    const effectiveReadOnly = readOnly || task.status === 'done';
    const effectiveFocusToggle = effectiveReadOnly ? undefined : focusToggle;
    const canCalendarDrag = !actionsOverlay && !dragHandle && !selectionMode && !isEditing && !effectiveReadOnly;
    const quickActionFocus = useMemo(() => {
        if (!quickActionMenu || effectiveReadOnly) return undefined;

        const now = new Date();
        const isFocused = Boolean(task.isFocusedToday);
        const addLabel = tFallback(t, 'agenda.addToFocus', "Add to today's focus");
        const removeLabel = tFallback(t, 'agenda.removeFromFocus', "Remove from today's focus");
        const limitMessage = formatFocusTaskLimitText(
            tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items.'),
            focusTaskLimit,
        );
        const clarifyReason = tFallback(
            t,
            'agenda.focusUnavailableClarifyFirst',
            'Clarify this task before adding it to Focus.',
        );
        const deferredReason = tFallback(
            t,
            'agenda.focusUnavailableDeferred',
            'This task is deferred; change its start date before focusing it.',
        );
        const sequentialReason = tFallback(
            t,
            'agenda.focusUnavailableSequential',
            'Complete the earlier sequential action before focusing this task.',
        );
        const activeFocusBaseTasks = FOCUS_ELIGIBILITY_ACTIVE_STATUSES
            .flatMap((status) => activeTasksByStatus.get(status) ?? [])
        const focusEligibility = getTaskFocusEligibility(task, {
            tasks: activeFocusBaseTasks,
            projects: projectMap,
            now,
            showFutureStarts,
            sequentialProjectIds,
            sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        });
        const isEligible = focusEligibility.eligible;
        const ineligibleReason = focusEligibility.reason === 'deferred'
            ? deferredReason
            : focusEligibility.reason === 'sequential'
                ? sequentialReason
                : clarifyReason;
        const canToggle = isFocused || (isEligible && focusedCount < focusTaskLimit);
        const title = isFocused
            ? removeLabel
            : !isEligible
                ? ineligibleReason
                : focusedCount >= focusTaskLimit
                    ? limitMessage
                    : addLabel;

        return {
            isFocused,
            canToggle,
            label: isFocused ? removeLabel : addLabel,
            title,
            onToggle: () => {
                if (isFocused) {
                    void updateTask(task.id, { isFocusedToday: false })
                        .then((result) => {
                            if (!result.success) showToast(result.error || 'Failed to update task', 'error');
                        });
                    return;
                }
                if (!isEligible) {
                    showToast(ineligibleReason, 'info');
                    return;
                }
                if (focusedCount >= focusTaskLimit) {
                    showToast(limitMessage, 'info');
                    return;
                }
                void updateTask(task.id, { isFocusedToday: true })
                    .then((result) => {
                        if (!result.success) showToast(result.error || 'Failed to update task', 'error');
                    });
            },
        };
    }, [
        activeTasksByStatus,
        effectiveReadOnly,
        focusTaskLimit,
        focusedCount,
        projectMap,
        quickActionMenu,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
        showFutureStarts,
        showToast,
        t,
        task,
        updateTask,
    ]);
    const handleToggleChecklistItem = useCallback((index: number) => {
        if (effectiveReadOnly) return;
        const checklist = task.checklist || [];
        if (!checklist[index]) return;
        const nextChecklist = checklist.map((item, i) =>
            i === index ? { ...item, isCompleted: !item.isCompleted } : item
        );
        const nextDescription = syncMarkdownChecklistWithCanonical(task.description, nextChecklist);
        void updateTask(task.id, {
            checklist: nextChecklist,
            ...(nextDescription !== task.description ? { description: nextDescription } : {}),
        });
    }, [effectiveReadOnly, task, updateTask]);
    const {
        monthlyRecurrence,
        showCustomRecurrence,
        setShowCustomRecurrence,
        customInterval,
        setCustomInterval,
        customMode,
        setCustomMode,
        customOrdinal,
        setCustomOrdinal,
        customWeekday,
        setCustomWeekday,
        customMonthDay,
        setCustomMonthDay,
        openCustomRecurrence,
        applyCustomRecurrence,
    } = useTaskItemRecurrence({
        task,
        editStartTime,
        editDueDate,
        editRecurrence,
        editRecurrenceRRule,
        setEditRecurrence,
        setEditRecurrenceRRule,
    });

    useEffect(() => {
        if (!isHighlighted) return;
        const timer = setTimeout(() => {
            setHighlightTask(null);
        }, 3500);
        return () => clearTimeout(timer);
    }, [isHighlighted, setHighlightTask]);

    const {
        sectionsByProject,
        currentProject,
        currentTaskArea,
        currentProjectColor,
        projectContext,
        tagOptions,
        popularContextOptions,
        popularTagOptions,
        allContexts,
        assignedToOptions,
    } = useTaskItemProjectContext({
        task,
        project: storeProject,
        projectArea,
        taskArea: storeTaskArea,
        sections,
        isEditing,
        loadTokenOptions: isEditing || Boolean(quickActionMenu),
        editProjectId,
        setEditAreaId,
    });

    useEffect(() => {
        const projectId = editProjectId || task.projectId || '';
        if (!projectId) {
            if (editSectionId) setEditSectionId('');
            return;
        }
        const projectSections = sectionsByProject.get(projectId) ?? [];
        if (editSectionId && !projectSections.some((section) => section.id === editSectionId)) {
            setEditSectionId('');
        }
    }, [editProjectId, editSectionId, sectionsByProject, setEditSectionId, task.projectId]);

    const {
        aiEnabled,
        isAIWorking,
        aiClarifyResponse,
        aiError,
        aiBreakdownSteps,
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotEstimate,
        resetCopilotDraft,
        resetAiState,
        clearAiBreakdown,
        clearAiClarify,
        applyCopilotSuggestion,
        applyAISuggestion,
        handleAIClarify,
        handleAIBreakdown,
    } = useTaskItemAi({
        taskId: task.id,
        settings,
        t,
        editTitle,
        editDescription,
        editContexts,
        editTags,
        editStartTime,
        editDueDate,
        editReviewAt,
        contextOptions: allContexts,
        tagOptions,
        projectContext,
        timeEstimatesEnabled,
        setEditTitle,
        setEditContexts,
        setEditTags,
        setEditTimeEstimate,
    });

    const resetEditState = useCallback(() => {
        resetLocalEditState();
        setShowCustomRecurrence(false);
        resetAiState();
    }, [resetLocalEditState, resetAiState, setShowCustomRecurrence]);
    const startEditing = useCallback(() => {
        if (effectiveReadOnly || isEditing) return;
        resetEditState();
        setTaskExpanded(task.id, false);
        setAutoFocusTitle(true);
        setIsEditing(true);
        setEditingTaskId(task.id);
    }, [effectiveReadOnly, isEditing, resetEditState, setEditingTaskId, setTaskExpanded, task.id]);

    const handleCreateProject = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const existing = projects.find((project) => project.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const initialAreaId = editAreaId || undefined;
        const created = await addProject(
            trimmed,
            DEFAULT_PROJECT_COLOR,
            initialAreaId ? { areaId: initialAreaId } : undefined
        );
        return created?.id ?? null;
    }, [addProject, editAreaId, projects]);
    const handleCreateArea = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = areas.find((area) => area.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addArea(trimmed, { color: DEFAULT_PROJECT_COLOR });
        return created?.id ?? null;
    }, [addArea, areas]);
    const createAssignedToPerson = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const created = await addPerson(trimmed);
        if (created) {
            setEditAssignedTo(created.name);
        }
    }, [addPerson, setEditAssignedTo]);
    const handleCreateSection = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const projectId = editProjectId || task.projectId;
        if (!projectId) return null;
        const existing = (sectionsByProject.get(projectId) ?? [])
            .find((section) => section.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addSection(projectId, trimmed);
        return created?.id ?? null;
    }, [addSection, editProjectId, sectionsByProject, task.projectId]);
    const visibleAttachments = (task.attachments || []).filter((a) => !a.deletedAt);
    const visibleEditAttachments = editAttachments.filter((a) => !a.deletedAt);
    const wasEditingRef = useRef(false);

    const {
        showProjectField,
        showAreaField,
        showSectionField,
        basicFields,
        schedulingFields,
        organizationFields,
        detailsFields,
        sectionCounts,
        sectionOpenDefaults,
    } = useTaskItemFieldLayout({
        settings,
        task,
        editStatus,
        editProjectId,
        editSectionId,
        editAreaId,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editContexts,
        editDescription,
        editDueDate,
        editRecurrence,
        editReviewAt,
        editStartTime,
        editTags,
        editLocation,
        editTimeEstimate,
        prioritiesEnabled,
        timeEstimatesEnabled,
        visibleEditAttachmentsLength: visibleEditAttachments.length,
    });
    const activeProjectId = editProjectId || task.projectId || '';
    const projectSections = activeProjectId ? (sectionsByProject.get(activeProjectId) ?? []) : [];
    const toggleDescriptionPreview = useCallback(() => {
        setShowDescriptionPreview((prev) => !prev);
    }, [setShowDescriptionPreview]);
    const editDescriptionFromPreview = useCallback(() => {
        setShowDescriptionPreview(false);
    }, [setShowDescriptionPreview]);
    const handleSetEditDescription = useCallback((value: string) => {
        setEditDescription(value);
        resetCopilotDraft();
    }, [resetCopilotDraft, setEditDescription]);
    const fieldRendererData = useMemo(() => ({
        t,
        task,
        taskId: task.id,
        showDescriptionPreview,
        editDescription,
        attachmentError,
        visibleEditAttachments,
        editStartTime,
        editRelativeStartOffset,
        editDueDate,
        editReviewAt,
        editRepeatReminderMinutes,
        editStatus,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        editShowFutureRecurrence,
        monthlyRecurrence,
        editTimeEstimate,
        editContexts,
        editTags,
        editLocation,
        language,
        dateFormatSetting: settings?.dateFormat,
        nativeDateInputLocale,
        defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '',
        allContextOptions: allContexts,
        allTagOptions: tagOptions,
        popularContextOptions,
        popularTagOptions,
        assignedToOptions,
        showObsidianNoteAttachment,
    }), [
        t,
        task,
        showDescriptionPreview,
        editDescription,
        attachmentError,
        visibleEditAttachments,
        editStartTime,
        editRelativeStartOffset,
        editDueDate,
        editReviewAt,
        editRepeatReminderMinutes,
        editStatus,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        editShowFutureRecurrence,
        monthlyRecurrence,
        editTimeEstimate,
        editContexts,
        editTags,
        editLocation,
        language,
        settings?.dateFormat,
        nativeDateInputLocale,
        settings?.gtd?.defaultScheduleTime,
        allContexts,
        tagOptions,
        popularContextOptions,
        popularTagOptions,
        assignedToOptions,
        showObsidianNoteAttachment,
    ]);
    const fieldRendererHandlers = useMemo(() => ({
        toggleDescriptionPreview,
        editDescriptionFromPreview,
        setEditDescription: handleSetEditDescription,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
        setEditRelativeStartOffset,
        setEditDueDate,
        setEditReviewAt,
        setEditRepeatReminderMinutes,
        setEditStatus,
        setEditPriority,
        setEditEnergyLevel,
        setEditAssignedTo,
        createAssignedToPerson,
        setEditRecurrence,
        setEditRecurrenceStrategy,
        setEditRecurrenceRRule,
        setEditShowFutureRecurrence,
        openCustomRecurrence,
        setEditTimeEstimate,
        setEditContexts,
        setEditTags,
        setEditLocation,
        updateTask,
        resetTaskChecklist,
    }), [
        toggleDescriptionPreview,
        editDescriptionFromPreview,
        handleSetEditDescription,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
        setEditRelativeStartOffset,
        setEditDueDate,
        setEditReviewAt,
        setEditRepeatReminderMinutes,
        setEditStatus,
        setEditPriority,
        setEditEnergyLevel,
        setEditAssignedTo,
        createAssignedToPerson,
        setEditRecurrence,
        setEditRecurrenceStrategy,
        setEditRecurrenceRRule,
        setEditShowFutureRecurrence,
        openCustomRecurrence,
        setEditTimeEstimate,
        setEditContexts,
        setEditTags,
        setEditLocation,
        updateTask,
        resetTaskChecklist,
    ]);

    const renderField = (fieldId: TaskEditorFieldId) => (
        <TaskItemFieldRenderer
            fieldId={fieldId}
            data={fieldRendererData}
            handlers={fieldRendererHandlers}
        />
    );

    useEffect(() => {
        if (effectiveReadOnly && isEditing) {
            setIsEditing(false);
            if (editingTaskId === task.id) {
                setEditingTaskId(null);
            }
            return;
        }
        if (!isEditing) {
            wasEditingRef.current = false;
            return;
        }
        wasEditingRef.current = true;
    }, [effectiveReadOnly, isEditing, editingTaskId, setEditingTaskId, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        if (editingTaskId !== task.id) {
            setIsEditing(false);
        }
    }, [editingTaskId, isEditing, task.id]);

    useEffect(() => {
        if (isEditing) return;
        if (editingTaskId === task.id && !effectiveReadOnly) {
            setTaskExpanded(task.id, false);
            setAutoFocusTitle(true);
            setIsEditing(true);
        }
    }, [editingTaskId, effectiveReadOnly, isEditing, setTaskExpanded, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        if (!autoFocusTitle) return;
        const raf = requestAnimationFrame(() => setAutoFocusTitle(false));
        return () => cancelAnimationFrame(raf);
    }, [autoFocusTitle, isEditing]);

    useEffect(() => {
        if (isEditing) {
            setTaskExpanded(task.id, false);
        }
    }, [isEditing, setTaskExpanded, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        lockEditing();
        return () => {
            unlockEditing();
        };
    }, [isEditing, lockEditing, unlockEditing]);


    const handleDiscardChanges = useCallback(() => {
        resetEditState();
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    }, [editingTaskId, resetEditState, setEditingTaskId, task.id]);

    const handleSubmit = useTaskItemSubmit({
        editAreaId,
        editAssignedTo,
        editAttachments,
        editContexts,
        editDescription,
        editDueDate,
        editEnergyLevel,
        editLocation,
        editPriority,
        editProjectId,
        editRecurrence,
        editRecurrenceRRule,
        editRecurrenceStrategy,
        editShowFutureRecurrence,
        editReviewAt,
        editRepeatReminderMinutes,
        editSectionId,
        editStartTime,
        editRelativeStartOffset,
        editStatus,
        editTags,
        editTimeEstimate,
        editTitle,
        editingTaskId,
        setEditingTaskId,
        setIsEditing,
        showToast,
        task,
        updateTask,
    });

    const project = currentProject;
    const taskArea = currentTaskArea;
    const projectColor = currentProjectColor;
    const handleOpenProject = useCallback((projectId: string) => {
        setHighlightTask(task.id);
        setSelectedProjectId(projectId);
        dispatchNavigateEvent('projects');
    }, [setHighlightTask, setSelectedProjectId, task.id]);
    const handleDuplicateTask = useCallback(async () => {
        if (effectiveReadOnly) return;
        try {
            const result = await duplicateTask(task.id, false);
            if (!result.success || !result.id) {
                showToast(result.error || t('task.duplicateFailed'), 'error');
                return;
            }
            setHighlightTask(result.id);
            if (task.projectId) {
                setSelectedProjectId(task.projectId);
                dispatchNavigateEvent('projects');
            }
            setTaskExpanded(result.id, false);
            setEditingTaskId(result.id);
        } catch (error) {
            reportError('Failed to duplicate task', error);
            showToast(t('task.duplicateFailed'), 'error');
        }
    }, [duplicateTask, effectiveReadOnly, setEditingTaskId, setHighlightTask, setSelectedProjectId, setTaskExpanded, showToast, t, task.id, task.projectId]);
    const handlePromoteTaskToProject = useCallback(async () => {
        if (effectiveReadOnly) return;
        try {
            const result = await promoteTaskToProject(task.id);
            if (!result.success || !result.id) {
                showToast(result.error || t('task.promoteToProjectFailed'), 'error');
                return;
            }
            showToast(
                result.reused ? t('task.promoteToProjectMoved') : t('task.promoteToProjectCreated'),
                'success',
            );
            setHighlightTask(task.id);
            setSelectedProjectId(result.id);
            setEditingTaskId(null);
            setTaskExpanded(task.id, false);
            dispatchNavigateEvent('projects');
            if (typeof window !== 'undefined') {
                window.setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                        detail: {
                            initialProps: {
                                projectId: result.id,
                                status: 'next',
                            },
                        },
                    }));
                }, 80);
            }
        } catch (error) {
            reportError('Failed to create project from task', error);
            showToast(t('task.promoteToProjectFailed'), 'error');
        }
    }, [effectiveReadOnly, promoteTaskToProject, setEditingTaskId, setHighlightTask, setSelectedProjectId, setTaskExpanded, showToast, t, task.id]);
    const handleOpenContextToken = useCallback((token: string) => {
        setHighlightTask(task.id);
        dispatchContextsTokenSelection(token);
        dispatchNavigateEvent('contexts');
    }, [setHighlightTask, task.id]);
    const undoLabel = useMemo(() => tFallback(t, 'common.undo', 'Undo'), [t]);
    const closeProjectNextActionPrompt = useCallback(() => {
        setProjectNextActionPrompt(null);
        setProjectNextActionTitle('');
    }, []);
    const openProjectNextActionPromptIfNeeded = useCallback((completedTaskId: string) => {
        const storeState = useTaskStore.getState();
        const completedTask = storeState._tasksById.get(completedTaskId)
            ?? storeState._allTasks.find((candidate) => candidate.id === completedTaskId)
            ?? { ...task, status: 'done' as TaskStatus };
        const promptData = getProjectNextActionPromptData(
            completedTask,
            storeState._allTasks,
            storeState._allProjects,
        );
        if (!promptData) return;
        setProjectNextActionTitle('');
        setProjectNextActionPrompt({
            candidates: promptData.candidates,
            projectId: promptData.project.id,
            projectTitle: promptData.project.title,
            sectionId: completedTask.sectionId,
        });
    }, [task]);
    const handlePromoteProjectNextAction = useCallback((nextTaskId: string) => {
        void moveTask(nextTaskId, 'next')
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to choose next action');
                }
                closeProjectNextActionPrompt();
            })
            .catch((error) => reportError('Failed to choose project next action', error));
    }, [closeProjectNextActionPrompt, moveTask]);
    const handleAddProjectNextAction = useCallback(() => {
        if (!projectNextActionPrompt) return;
        const title = projectNextActionTitle.trim();
        if (!title) return;
        void addTask(title, {
            status: 'next',
            projectId: projectNextActionPrompt.projectId,
            sectionId: projectNextActionPrompt.sectionId,
        })
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to add next action');
                }
                closeProjectNextActionPrompt();
            })
            .catch((error) => reportError('Failed to add project next action', error));
    }, [addTask, closeProjectNextActionPrompt, projectNextActionPrompt, projectNextActionTitle]);
    const closeWaitingAssignmentPrompt = useCallback(() => {
        setShowWaitingAssignmentPrompt(false);
    }, []);
    const applyWaitingAssignment = useCallback((value: string) => {
        const assignedTo = value.trim() || undefined;
        setShowWaitingAssignmentPrompt(false);
        void moveTask(task.id, 'waiting')
            .then(async (result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                const updateResult = await updateTask(task.id, { assignedTo });
                if (!updateResult.success) {
                    throw new Error(updateResult.error || 'Failed to update waiting assignee');
                }
            })
            .catch((error) => reportError('Failed to move task to waiting', error));
    }, [moveTask, task.id, updateTask]);
    const handleTaskCompleted = useCallback((previousStatus: TaskStatus) => {
        if (undoNotificationsEnabled) {
            showToast(
                `${task.title} marked Done`,
                'info',
                5000,
                {
                    label: undoLabel,
                    onClick: () => {
                        closeProjectNextActionPrompt();
                        void moveTask(task.id, previousStatus);
                    },
                }
            );
        }
        openProjectNextActionPromptIfNeeded(task.id);
    }, [
        closeProjectNextActionPrompt,
        moveTask,
        openProjectNextActionPromptIfNeeded,
        showToast,
        task.id,
        task.title,
        undoLabel,
        undoNotificationsEnabled,
    ]);
    const handleStatusChange = useCallback((nextStatus: TaskStatus) => {
        if (nextStatus === 'waiting' && task.status !== 'waiting') {
            setShowWaitingAssignmentPrompt(true);
            return;
        }
        const previousStatus = task.status;
        void moveTask(task.id, nextStatus)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                if (nextStatus === 'done' && previousStatus !== 'done') {
                    handleTaskCompleted(previousStatus);
                }
            })
            .catch((error) => reportError('Failed to change task status', error));
    }, [
        handleTaskCompleted,
        moveTask,
        task.id,
        task.status,
    ]);
    const handleEditorMarkDone = useCallback(() => {
        if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
        const previousStatus = task.status;
        void handleSubmit(undefined, { statusOverride: 'done' })
            .then((result) => {
                if (!result?.success) return;
                handleTaskCompleted(previousStatus);
            })
            .catch((error) => reportError('Failed to mark task done from editor', error));
    }, [handleSubmit, handleTaskCompleted, task.status]);
    const hasPendingEdits = useCallback(() => {
        if (editTitle !== task.title) return true;
        if (editDescription !== (task.description || '')) return true;
        if (editProjectId !== (task.projectId || '')) return true;
        if (editSectionId !== (task.sectionId || '')) return true;
        if (editAreaId !== (task.areaId || '')) return true;
        if (editStatus !== task.status) return true;
        if (editContexts.trim() !== (task.contexts?.join(', ') || '').trim()) return true;
        if (editTags.trim() !== (task.tags?.join(', ') || '').trim()) return true;
        if (editLocation !== (task.location || '')) return true;
        if (editRecurrence !== getRecurrenceRuleValue(task.recurrence)) return true;
        if (editRecurrenceStrategy !== getRecurrenceStrategyValue(task.recurrence)) return true;
        if (editRecurrenceRRule !== getRecurrenceRRuleValue(task.recurrence)) return true;
        if (editShowFutureRecurrence !== Boolean(task.showFutureRecurrence)) return true;
        if (editTimeEstimate !== (task.timeEstimate || '')) return true;
        if (editPriority !== (task.priority || '')) return true;
        if (editEnergyLevel !== (task.energyLevel || '')) return true;
        if (editAssignedTo !== (task.assignedTo || '')) return true;
        if (editDueDate !== toDateTimeLocalValue(task.dueDate)) return true;
        if (editStartTime !== toDateTimeLocalValue(task.startTime)) return true;
        if (JSON.stringify(editRelativeStartOffset ?? null) !== JSON.stringify(task.relativeStartOffset ?? null)) return true;
        if (editReviewAt !== toDateTimeLocalValue(task.reviewAt)) return true;
        if ((editRepeatReminderMinutes ?? undefined) !== (task.repeatReminderMinutes ?? undefined)) return true;
        return false;
    }, [
        editTitle,
        editDescription,
        editProjectId,
        editSectionId,
        editAreaId,
        editStatus,
        editContexts,
        editTags,
        editLocation,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        editShowFutureRecurrence,
        editTimeEstimate,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editDueDate,
        editStartTime,
        editRelativeStartOffset,
        editReviewAt,
        editRepeatReminderMinutes,
        task,
    ]);
    const taskEditorPresentationSetting = settings?.gtd?.taskEditor?.presentation;
    const resolvedEditorPresentation: TaskEditorPresentation = editorPresentation
        ?? (taskEditorPresentationSetting === 'modal' ? 'modal' : 'inline');
    const isModalEditor = resolvedEditorPresentation === 'modal';
    const getModalFocusableElements = useCallback((): HTMLElement[] => {
        const root = modalEditorRef.current;
        if (!root) return [];
        return Array.from(
            root.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
    }, []);
    useEffect(() => {
        if (!(isEditing && isModalEditor)) {
            if (lastFocusedBeforeModalRef.current) {
                lastFocusedBeforeModalRef.current.focus();
                lastFocusedBeforeModalRef.current = null;
            }
            return;
        }

        lastFocusedBeforeModalRef.current = document.activeElement as HTMLElement | null;
        const timer = setTimeout(() => {
            const active = document.activeElement as HTMLElement | null;
            if (active && modalEditorRef.current?.contains(active)) {
                return;
            }
            const focusable = getModalFocusableElements();
            if (focusable.length > 0) {
                focusable[0].focus();
                return;
            }
            modalEditorRef.current?.focus();
        }, 0);
        return () => clearTimeout(timer);
    }, [getModalFocusableElements, isEditing, isModalEditor]);
    const handleEditorCancel = useCallback(() => {
        if (hasPendingEdits()) {
            setShowDiscardConfirm(true);
            return;
        }
        handleDiscardChanges();
    }, [handleDiscardChanges, hasPendingEdits]);
    const handleOpenQuickActionMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (selectionMode || isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.();
        quickActionReturnFocusRef.current = event.currentTarget.querySelector<HTMLElement>('[data-task-quick-actions-trigger]')
            ?? event.currentTarget;
        setQuickActionMenu({
            x: event.clientX,
            y: event.clientY,
        });
    }, [isEditing, onSelect, selectionMode]);
    const handleOpenQuickActionButton = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (selectionMode || isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.();
        quickActionReturnFocusRef.current = event.currentTarget;
        const rect = event.currentTarget.getBoundingClientRect();
        setQuickActionMenu({
            x: rect.left,
            y: rect.bottom + 4,
        });
    }, [isEditing, onSelect, selectionMode]);
    const handleCloseQuickActionMenu = useCallback(() => {
        setQuickActionMenu(null);
        window.setTimeout(() => {
            quickActionReturnFocusRef.current?.focus();
            quickActionReturnFocusRef.current = null;
        }, 0);
    }, []);

    const handleTitleSuggestionAccept = useCallback((suggestion: TaskInputAcceptedSuggestion): boolean => {
        if (suggestion.kind !== 'command') return false;
        const value = suggestion.value.trim();

        if (suggestion.command === 'note') {
            if (!value) return false;
            const existingDescription = editDescription.trimEnd();
            setEditDescription(existingDescription ? `${existingDescription}\n\n${value}` : value);
            return true;
        }

        if (suggestion.command === 'due' || suggestion.command === 'start' || suggestion.command === 'review') {
            if (!value) return false;
            const parsed = parseQuickAddDateCommands(`/${suggestion.command}:${value}`, new Date(), {
                defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || undefined,
            });
            if (parsed.invalidDateCommands?.length) return false;
            const parsedValue = suggestion.command === 'due'
                ? parsed.props.dueDate
                : suggestion.command === 'start'
                    ? parsed.props.startTime
                    : parsed.props.reviewAt;
            if (!parsedValue) return false;
            const editorValue = toDateTimeLocalValue(parsedValue);
            if (suggestion.command === 'due') {
                setEditDueDate(editorValue);
            } else if (suggestion.command === 'start') {
                setEditStartTime(editorValue);
            } else {
                setEditReviewAt(editorValue);
            }
            return true;
        }

        setEditStatus(suggestion.command);
        return true;
    }, [
        editDescription,
        settings?.gtd?.defaultScheduleTime,
        setEditDescription,
        setEditDueDate,
        setEditReviewAt,
        setEditStartTime,
        setEditStatus,
    ]);

    useEffect(() => {
        if (!isEditing) return;
        const handleGlobalCancel = (event: Event) => {
            const detail = (event as CustomEvent<{ taskId?: string }>).detail;
            if (detail?.taskId && detail.taskId !== task.id) return;
            handleEditorCancel();
        };
        window.addEventListener('mindwtr:cancel-task-edit', handleGlobalCancel);
        return () => window.removeEventListener('mindwtr:cancel-task-edit', handleGlobalCancel);
    }, [handleEditorCancel, isEditing, task.id]);
    const renderEditor = () => (
        <TaskItemEditor
            t={t}
            editTitle={editTitle}
            setEditTitle={setEditTitle}
            editContexts={editContexts}
            setEditContexts={setEditContexts}
            editTags={editTags}
            setEditTags={setEditTags}
            autoFocusTitle={autoFocusTitle}
            resetCopilotDraft={resetCopilotDraft}
            aiEnabled={aiEnabled}
            isAIWorking={isAIWorking}
            handleAIClarify={handleAIClarify}
            handleAIBreakdown={handleAIBreakdown}
            copilotSuggestion={copilotSuggestion}
            copilotApplied={copilotApplied}
            applyCopilotSuggestion={applyCopilotSuggestion}
            copilotContext={copilotContext}
            copilotEstimate={copilotEstimate}
            copilotTags={copilotSuggestion?.tags ?? []}
            timeEstimatesEnabled={timeEstimatesEnabled}
            aiError={aiError}
            aiBreakdownSteps={aiBreakdownSteps}
            onAddBreakdownSteps={() => {
                if (!aiBreakdownSteps?.length) return;
                const newItems = aiBreakdownSteps.map((step) => ({
                    id: generateUUID(),
                    title: step,
                    isCompleted: false,
                }));
                updateTask(task.id, { checklist: [...(task.checklist || []), ...newItems] });
                clearAiBreakdown();
            }}
            onDismissBreakdown={clearAiBreakdown}
            aiClarifyResponse={aiClarifyResponse}
            onSelectClarifyOption={(action) => {
                setEditTitle(action);
                clearAiClarify();
            }}
            onApplyAISuggestion={() => {
                if (aiClarifyResponse?.suggestedAction) {
                    applyAISuggestion(aiClarifyResponse.suggestedAction);
                }
            }}
            onDismissClarify={clearAiClarify}
            projects={projects}
            areas={areas}
            editProjectId={editProjectId}
            setEditProjectId={setEditProjectId}
            sections={projectSections}
            editSectionId={editSectionId}
            setEditSectionId={setEditSectionId}
            editAreaId={editAreaId}
            setEditAreaId={setEditAreaId}
            onCreateProject={handleCreateProject}
            onCreateArea={handleCreateArea}
            onCreateSection={handleCreateSection}
            showProjectField={showProjectField}
            showAreaField={showAreaField}
            showSectionField={showSectionField}
            basicFields={basicFields}
            schedulingFields={schedulingFields}
            organizationFields={organizationFields}
            detailsFields={detailsFields}
            sectionCounts={sectionCounts}
            sectionOpenDefaults={sectionOpenDefaults}
            renderField={renderField}
            language={language}
            inputContexts={allContexts}
            onAcceptTitleSuggestion={handleTitleSuggestionAccept}
            isDoneActionActive={editStatus === 'done'}
            onMarkDone={task.status !== 'done' && task.status !== 'archived' && task.status !== 'reference' ? handleEditorMarkDone : undefined}
            onDuplicateTask={handleDuplicateTask}
            onDeleteTask={task.status === 'inbox' ? () => setShowDeleteConfirm(true) : undefined}
            onCancel={handleEditorCancel}
            onSubmit={handleSubmit}
        />
    );

    const selectAriaLabel = tFallback(t, 'task.select', 'Select task');
    const displayActions = useMemo(() => ({
        onToggleSelect,
        onToggleView: () => toggleTaskExpanded(task.id),
        onEdit: startEditing,
        onDelete: () => setShowDeleteConfirm(true),
        onDuplicate: handleDuplicateTask,
        onStatusChange: handleStatusChange,
        onOpenQuickActions: handleOpenQuickActionButton,
        onOpenProject: project ? handleOpenProject : undefined,
        onOpenContextToken: handleOpenContextToken,
        openAttachment,
        onToggleChecklistItem: handleToggleChecklistItem,
        focusToggle: effectiveFocusToggle,
    }), [
        handleDuplicateTask,
        effectiveFocusToggle,
        handleOpenContextToken,
        handleOpenProject,
        handleOpenQuickActionButton,
        handleStatusChange,
        handleToggleChecklistItem,
        onToggleSelect,
        openAttachment,
        project,
        startEditing,
        task.id,
        toggleTaskExpanded,
    ]);
    const handleCalendarDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!canCalendarDrag) {
            event.preventDefault();
            return;
        }
        setCalendarTaskDragData(event.dataTransfer, task.id);
    }, [canCalendarDrag, task.id]);
    const showConfiguredStatusSelect = showStatusSelect && basicFields.includes('status');

    return (
        <>
            <div
                ref={taskRootRef}
                data-task-id={task.id}
                draggable={canCalendarDrag}
                tabIndex={-1}
                onDragStart={handleCalendarDragStart}
                onClickCapture={onSelect ? (event) => {
                    if (!event.currentTarget.contains(event.target as Node)) return;
                    onSelect?.();
                } : undefined}
                onDoubleClick={(event) => {
                    if (!enableDoubleClickEdit || selectionMode || effectiveReadOnly || isEditing) return;
                    event.stopPropagation();
                    startEditing();
                }}
                onContextMenu={handleOpenQuickActionMenu}
                className={cn(
                    "group rounded-lg hover:bg-muted/50 dark:hover:bg-muted/20 transition-colors animate-in fade-in slide-in-from-bottom-2",
                    isCompact ? "p-2.5" : "px-3 py-3",
                    "focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary/40 focus-within:bg-primary/5",
                    canCalendarDrag && "cursor-grab active:cursor-grabbing",
                    isSelected && "ring-2 ring-inset ring-primary/40 bg-primary/5",
                    isHighlighted && "ring-2 ring-inset ring-primary/70 bg-primary/5"
                )}
            >
                <div className={cn("flex items-start", isCompact ? "gap-2" : "gap-3")}>
                    {selectionMode && (
                        <input
                            type="checkbox"
                            aria-label={selectAriaLabel}
                            checked={isMultiSelected}
                            onClick={(event) => onToggleSelect?.({ range: event.shiftKey })}
                            onChange={() => undefined}
                            className={cn(
                                "h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer",
                                isCompact ? "mt-1" : "mt-1.5"
                            )}
                        />
                    )}

                    <TaskItemEditorSurface
                        editorAriaLabel={t('taskEdit.editTask') || 'Edit task'}
                        getModalFocusableElements={getModalFocusableElements}
                        isEditing={isEditing}
                        isModalEditor={isModalEditor}
                        modalEditorRef={modalEditorRef}
                        onCancel={handleEditorCancel}
                        renderDisplay={() => (
                            <TaskItemDisplay
                                task={task}
                                language={language}
                                project={project}
                                area={taskArea}
                                projectColor={projectColor}
                                selectionMode={selectionMode}
                                isViewOpen={isTaskExpanded}
                                quickActionsOpen={Boolean(quickActionMenu)}
                                actions={displayActions}
                                visibleAttachments={visibleAttachments}
                                recurrenceRule={recurrenceRule}
                                recurrenceStrategy={recurrenceStrategy}
                                prioritiesEnabled={prioritiesEnabled}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                isStagnant={isStagnant}
                                showQuickDone={showQuickDone}
                                showStatusSelect={showConfiguredStatusSelect}
                                showProjectBadgeInActions={showProjectBadgeInActions}
                                showProjectBadgeInMetadata={showProjectBadgeInMetadata}
                                readOnly={effectiveReadOnly}
                                compactMetaEnabled={compactMetaEnabled}
                                dense={isCompact}
                                actionsOverlay={actionsOverlay}
                                dragHandle={dragHandle}
                                showTaskAge={showTaskAge}
                                showHoverHint={showHoverHint}
                                projectDeadlineLabel={projectDeadlineLabel}
                                t={t}
                            />
                        )}
                        renderEditor={renderEditor}
                    />
                </div>
            </div>
            {quickActionMenu && (
                <TaskQuickActionMenu
                    task={task}
                    x={quickActionMenu.x}
                    y={quickActionMenu.y}
                    t={t}
                    dateFormatSetting={settings?.dateFormat}
                    nativeDateInputLocale={nativeDateInputLocale}
                    contextOptions={popularContextOptions}
                    contextSuggestions={allContexts}
                    areas={areas}
                    readOnly={effectiveReadOnly}
                    focusAction={quickActionFocus}
                    onClose={handleCloseQuickActionMenu}
                    onDuplicate={handleDuplicateTask}
                    onPromoteToProject={handlePromoteTaskToProject}
                    onDelete={() => {
                        setShowDeleteConfirm(true);
                    }}
                    onStatusChange={handleStatusChange}
                    onCreateArea={handleCreateArea}
                    onUpdateTask={(updates) => updateTask(task.id, updates)}
                />
            )}
            {projectNextActionPrompt && (
                <ProjectNextActionPrompt
                    isOpen={Boolean(projectNextActionPrompt)}
                    candidates={projectNextActionPrompt.candidates}
                    projectTitle={projectNextActionPrompt.projectTitle}
                    newTitle={projectNextActionTitle}
                    onAddTask={handleAddProjectNextAction}
                    onCancel={closeProjectNextActionPrompt}
                    onChooseTask={handlePromoteProjectNextAction}
                    onNewTitleChange={setProjectNextActionTitle}
                    t={t}
                />
            )}
            <TaskItemOverlays
                applyCustomRecurrence={applyCustomRecurrence}
                audioAttachment={audioAttachment}
                audioError={audioError}
                audioRef={audioRef}
                audioSource={audioSource}
                audioTranscribing={audioTranscribing}
                audioTranscriptionError={audioTranscriptionError}
                clearLinkPrompt={closeLinkPrompt}
                closeAudio={closeAudio}
                closeImage={closeImage}
                closeText={closeText}
                customInterval={customInterval}
                customMode={customMode}
                customMonthDay={customMonthDay}
                customOrdinal={customOrdinal}
                customWeekday={customWeekday}
                deleteTask={deleteTask}
                handleAddLinkAttachment={handleAddLinkAttachment}
                handleAudioError={handleAudioError}
                handleDiscardChanges={handleDiscardChanges}
                handleOpenDeleteConfirm={setShowDeleteConfirm}
                handleOpenDiscardConfirm={setShowDiscardConfirm}
                imageAttachment={imageAttachment}
                imageSource={imageSource}
                onOpenImageExternally={openImageExternally}
                onOpenTextExternally={openTextExternally}
                openAudioExternally={openAudioExternally}
                openDeleteConfirm={showDeleteConfirm}
                openDiscardConfirm={showDiscardConfirm}
                openLinkPrompt={showLinkPrompt}
                linkPromptDefaultValue={linkPromptDefaultValue}
                linkPromptTitle={editingLinkAttachmentId
                    ? t('common.edit')
                    : linkPromptVariant === 'obsidian'
                        ? t('attachments.attachObsidianNote')
                        : t('attachments.addLink')}
                linkPromptDescription={linkPromptVariant === 'obsidian'
                    ? t('attachments.obsidianLinkInputHint')
                    : t('attachments.linkInputHint')}
                linkPromptPlaceholder={linkPromptVariant === 'obsidian'
                    ? t('attachments.obsidianLinkPlaceholder')
                    : t('attachments.linkPlaceholder')}
                openWaitingAssignmentPrompt={showWaitingAssignmentPrompt}
                onCancelWaitingAssignmentPrompt={closeWaitingAssignmentPrompt}
                onConfirmWaitingAssignmentPrompt={applyWaitingAssignment}
                waitingAssignmentDefaultValue={task.assignedTo || ''}
                restoreTask={restoreTask}
                retryAudioTranscription={retryAudioTranscription}
                setCustomInterval={setCustomInterval}
                setCustomMode={setCustomMode}
                setCustomMonthDay={setCustomMonthDay}
                setCustomOrdinal={setCustomOrdinal}
                setCustomWeekday={setCustomWeekday}
                setShowCustomRecurrence={setShowCustomRecurrence}
                showCustomRecurrence={showCustomRecurrence}
                showToast={showToast}
                t={t}
                taskId={task.id}
                textAttachment={textAttachment}
                textContent={textContent}
                textError={textError}
                textLoading={textLoading}
                undoLabel={undoLabel}
                undoNotificationsEnabled={undoNotificationsEnabled}
                weekdayLabels={recurrenceWeekdayLabels}
            />
        </>
    );
});
