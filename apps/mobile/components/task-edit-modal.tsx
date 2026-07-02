import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Modal, Animated, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    Task,
    TaskEditorFieldId,
    useTaskStore,
    type Attachment,
    type RecurrenceWeekday,
    type RecurrenceByDay,
    type TaskStatus,
    buildRRuleString,
    parseRRuleString,
    resolveAutoTextDirection,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    normalizeClockTimeInput,
    shallow,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { ExpandedMarkdownEditor } from './expanded-markdown-editor';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { styles } from './task-edit/task-edit-modal.styles';
import { TaskEditFieldRenderer } from './task-edit/TaskEditFieldRenderer';
import { useTaskDescriptionEditor } from './task-edit/use-task-description-editor';
import { TaskEditViewTab } from './task-edit/TaskEditViewTab';
import { TaskEditFormTab } from './task-edit/TaskEditFormTab';
import { TaskEditHeader } from './task-edit/TaskEditHeader';
import { TaskEditModalErrorBoundary } from './task-edit/TaskEditModalErrorBoundary';
import { TaskEditOverlayStack } from './task-edit/TaskEditOverlayStack';
import { TaskEditTabs } from './task-edit/TaskEditTabs';
import {
    MAX_VISIBLE_SUGGESTIONS,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
} from './task-edit/recurrence-utils';
import { getAssignedToSuggestions } from './task-metadata-suggestions';
import { useTaskEditCopilot } from './task-edit/use-task-edit-copilot';
import { getEditedTaskValue, logTaskError } from './task-edit/task-edit-modal.utils';
import {
    parseTokenList,
    replaceTrailingToken,
} from './task-edit/task-edit-token-utils';
import { useTaskEditActions } from './task-edit/use-task-edit-actions';
import { useTaskEditAttachments } from './task-edit/use-task-edit-attachments';
import { useTaskEditDates } from './task-edit/use-task-edit-dates';
import { useTaskEditPager } from './task-edit/use-task-edit-pager';
import { useTaskEditPreview } from './task-edit/use-task-edit-preview';
import {
    useTaskEditState,
} from './task-edit/use-task-edit-state';
import { useTaskEditDerivedState } from './task-edit/use-task-edit-derived-state';
import { useTaskTokenSuggestions } from './task-edit/use-task-token-suggestions';


const EMPTY_COPILOT_TAGS: string[] = [];

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
    defaultTab?: 'task' | 'view';
    onProjectNavigate?: (projectId: string) => void;
    onContextNavigate?: (context: string) => void;
    onTagNavigate?: (tag: string) => void;
}

function TaskEditModalInner({
    visible,
    task,
    onClose,
    onSave,
    onFocusMode,
    defaultTab,
    onProjectNavigate,
    onContextNavigate,
    onTagNavigate,
}: TaskEditModalProps) {
    const { showToast } = useToast();
    const {
        tasks,
        projects,
        sections,
        areas,
        people,
        settings,
        duplicateTask,
        promoteTaskToProject,
        resetTaskChecklist,
        addProject,
        addSection,
        addArea,
        addPerson,
        deleteTask,
        restoreTask,
        allContexts = [],
        allTags = [],
        contextTokenUsage = [],
        tagTokenUsage = [],
    } = useTaskStore((state) => {
        const derived = state.getDerivedState();
        return {
            tasks: state.tasks,
            projects: state.projects,
            sections: state.sections,
            areas: state.areas,
            people: state.people,
            settings: state.settings,
            duplicateTask: state.duplicateTask,
            promoteTaskToProject: state.promoteTaskToProject,
            resetTaskChecklist: state.resetTaskChecklist,
            addProject: state.addProject,
            addSection: state.addSection,
            addArea: state.addArea,
            addPerson: state.addPerson,
            deleteTask: state.deleteTask,
            restoreTask: state.restoreTask,
            allContexts: derived.allContexts,
            allTags: derived.allTags,
            contextTokenUsage: derived.contextTokenUsage,
            tagTokenUsage: derived.tagTokenUsage,
        };
    }, shallow);
    const { t, language } = useLanguage();
    const rawThemeColors = useThemeColors();
    const tc = useMemo(() => rawThemeColors, [
        rawThemeColors.bg,
        rawThemeColors.border,
        rawThemeColors.cardBg,
        rawThemeColors.danger,
        rawThemeColors.filterBg,
        rawThemeColors.icon,
        rawThemeColors.inputBg,
        rawThemeColors.onTint,
        rawThemeColors.secondaryText,
        rawThemeColors.success,
        rawThemeColors.tabIconDefault,
        rawThemeColors.tabIconSelected,
        rawThemeColors.taskItemBg,
        rawThemeColors.text,
        rawThemeColors.tint,
        rawThemeColors.warning,
    ]);
    const prioritiesEnabled = settings.features?.priorities !== false;
    const timeEstimatesEnabled = settings.features?.timeEstimates !== false;
    const resetCopilotStateRef = useRef<() => void>(() => {});
    const descriptionToolbarInteractionUntilRef = useRef(0);
    const {
        aiModal,
        baseTaskRef,
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        editedTask,
        isAIWorking,
        isContextInputFocused,
        isTagInputFocused,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setEditTab,
        setEditedTask,
        setIsAIWorking,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setPendingDueDate,
        setPendingStartDate,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        setTagInputDraft,
        setTitleDraft,
        showAreaPicker,
        showDatePicker,
        showDescriptionPreview,
        showProjectPicker,
        showSectionPicker,
        tagInputDraft,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    } = useTaskEditState({
        defaultTab,
        resetCopilotStateRef,
        task,
        tasks,
        visible,
    });
    const recurrenceWeekdayButtons = useMemo(() => getLocalizedWeekdayButtons(language, 'narrow'), [language]);
    const recurrenceWeekdayLabels = useMemo(() => getLocalizedWeekdayLabels(language, 'long'), [language]);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = settings.ai?.provider ?? 'openai';

    const contextOptions = React.useMemo(() => Array.from(new Set([
            ...allContexts,
            ...(editedTask.contexts ?? []),
        ])).filter(Boolean), [allContexts, editedTask.contexts]);
    const tagOptions = React.useMemo(() => Array.from(new Set([
            ...allTags,
            ...(editedTask.tags ?? []),
        ])).filter(Boolean), [allTags, editedTask.tags]);
    const {
        handlePreviewContextPress,
        handlePreviewProjectPress,
        handlePreviewTagPress,
        projectContext,
    } = useTaskEditPreview({
        editedProjectId: editedTask.projectId,
        includeProjectContext: aiEnabled,
        onClose,
        onContextNavigate,
        onProjectNavigate,
        onTagNavigate,
        projectId: task?.projectId,
        projects,
        task,
        tasks,
    });

    const {
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotEstimate,
        copilotTags,
        resetCopilotDraft,
        resetCopilotState,
        applyCopilotSuggestion,
    } = useTaskEditCopilot({
        settings,
        aiEnabled,
        aiProvider,
        timeEstimatesEnabled,
        titleDraft,
        descriptionDraft,
        contextOptions,
        tagOptions,
        editedTask,
        visible,
        setEditedTask,
    });
    resetCopilotStateRef.current = resetCopilotState;

    const {
        addFileAttachment,
        addImageAttachment,
        audioAttachment,
        audioLoading,
        audioTranscribing,
        audioTranscriptionError,
        audioModalVisible,
        audioStatus,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        downloadAttachment,
        editLinkAttachment,
        editingLinkAttachmentId,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAddLinkAttachment,
        openAttachment,
        removeAttachment,
        retryAudioTranscription,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        toggleAudioPlayback,
        visibleAttachments,
    } = useTaskEditAttachments({
        editedTask,
        setEditedTask,
        t,
        visible,
    });

    const {
        contextTokenSuggestions,
        tagTokenSuggestions,
        frequentContextSuggestions,
        frequentTagSuggestions,
        selectedContextTokens,
        selectedTagTokens,
    } = useTaskTokenSuggestions({
        editedContexts: editedTask.contexts,
        editedTags: editedTask.tags,
        contextInputDraft,
        tagInputDraft,
        allContexts,
        allTags,
        contextTokenUsage,
        tagTokenUsage,
    });
    const assignedToSuggestions = useMemo(
        () => getAssignedToSuggestions(tasks, String(editedTask.assignedTo ?? ''), MAX_VISIBLE_SUGGESTIONS, people),
        [editedTask.assignedTo, people, tasks]
    );

    const closeAIModal = () => setAiModal(null);
    const setTitleImmediate = useCallback((text: string) => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        titleDraftRef.current = text;
        setTitleDraft(text);
        setEditedTask((prev) => ({ ...prev, title: text }));
    }, [setEditedTask]);
    const handleTitleDraftChange = useCallback((text: string) => {
        titleDraftRef.current = text;
        setTitleDraft(text);
        resetCopilotDraft();
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
        }
        titleDebounceRef.current = setTimeout(() => {
            setEditedTask((prev) => ({ ...prev, title: text }));
        }, 250);
    }, [resetCopilotDraft, setEditedTask]);
    const {
        activeProjectId,
        availableStatusOptions,
        basicFields,
        dailyInterval,
        detailsFields,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields,
        energyLevelOptions,
        priorityOptions,
        projectFilterAreaId,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        schedulingFields,
        sectionOpenDefaults,
        showStatusField,
        timeEstimateOptions,
    } = useTaskEditDerivedState({
        task,
        editedTask,
        settings,
        projects,
        sections,
        prioritiesEnabled,
        timeEstimatesEnabled,
        contextInputDraft,
        descriptionDraft,
        tagInputDraft,
        visibleAttachmentsLength: visibleAttachments.length,
        t,
    });
    const isReference = (editedTask.status ?? task?.status) === 'reference';

    useEffect(() => {
        const projectId = getEditedTaskValue(editedTask, task, 'projectId');
        const sectionId = getEditedTaskValue(editedTask, task, 'sectionId');
        if (!sectionId) return;
        if (!projectId) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
            return;
        }
        const isValid = sections.some((section) => section.id === sectionId && section.projectId === projectId && !section.deletedAt);
        if (!isValid) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
        }
    }, [editedTask.projectId, editedTask.sectionId, sections, setEditedTask, task?.projectId, task?.sectionId]);

    useEffect(() => {
        if (!activeProjectId) {
            setShowSectionPicker(false);
        }
    }, [activeProjectId]);

    const {
        applyQuickDate,
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    } = useTaskEditDates({
        editedTask,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
        defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || '',
        t,
    });

    const mergedTask = useMemo(() => ({
        ...(task ?? {}),
        ...editedTask,
    }), [task, editedTask]);

    const [customRecurrenceVisible, setCustomRecurrenceVisible] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday>(monthlyWeekdayCode);
    const [customMonthDay, setCustomMonthDay] = useState<number>(monthlyAnchorDate.getDate());
    const [waitingAssignmentModalVisible, setWaitingAssignmentModalVisible] = useState(false);
    const [waitingAssignmentInput, setWaitingAssignmentInput] = useState('');
    const [isTitleInputFocused, setIsTitleInputFocused] = useState(false);

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday = monthlyWeekdayCode;
        const monthDay = parsed.byMonthDay?.[0];
        if (monthDay) {
            mode = 'date';
            setCustomMonthDay(Math.min(Math.max(monthDay, 1), 31));
        }
        const token = parsed.byDay?.find((day) => /^(-1|1|2|3|4)/.test(String(day)));
        if (token) {
            const match = String(token).match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
            if (match) {
                mode = 'nth';
                ordinal = (match[1] ?? '1') as '1' | '2' | '3' | '4' | '-1';
                weekday = match[2] as RecurrenceWeekday;
            }
        }
        setCustomInterval(interval);
        setCustomMode(mode);
        setCustomOrdinal(ordinal);
        setCustomWeekday(weekday);
        if (!monthDay) {
            setCustomMonthDay(monthlyAnchorDate.getDate());
        }
        setCustomRecurrenceVisible(true);
    }, [monthlyAnchorDate, monthlyWeekdayCode, recurrenceRRuleValue]);

    const applyCustomRecurrence = useCallback(() => {
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
        const safeMonthDay = Math.min(Math.max(Math.round(customMonthDay || 1), 1), 31);
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval)
            : [
                'FREQ=MONTHLY',
                safeInterval > 1 ? `INTERVAL=${safeInterval}` : null,
                `BYMONTHDAY=${safeMonthDay}`,
            ].filter(Boolean).join(';');
        setEditedTask(prev => ({
            ...prev,
            recurrence: {
                rule: 'monthly',
                strategy: recurrenceStrategyValue,
                ...(customMode === 'nth' ? { byDay: [`${customOrdinal}${customWeekday}` as RecurrenceByDay] } : {}),
                ...(customMode === 'date' ? { byMonthDay: [safeMonthDay] } : {}),
                rrule,
            },
        }));
        setCustomRecurrenceVisible(false);
    }, [customInterval, customMode, customOrdinal, customWeekday, customMonthDay, recurrenceStrategyValue, setEditedTask]);

    const [isMarkdownOverlayOpen, setIsMarkdownOverlayOpen] = useState(false);
    const {
        containerWidth,
        handleContainerLayout,
        handleInputFocus,
        handleMomentumScrollEnd,
        handleTabPress,
        registerScrollTaskFormToEnd,
        scrollRef,
        scrollX,
    } = useTaskEditPager({
        editTab,
        isMarkdownOverlayOpen,
        setEditTab,
        taskId: task?.id,
        visible,
    });

    useEffect(() => {
        if (!visible) {
            setIsMarkdownOverlayOpen(false);
            setIsTitleInputFocused(false);
        }
    }, [visible]);

    const descriptionEditor = useTaskDescriptionEditor({
        task,
        descriptionDraft,
        descriptionDraftRef,
        setDescriptionDraft,
        descriptionDebounceRef,
        setEditedTask,
        resetCopilotDraft,
        onMarkdownOverlayVisibilityChange: setIsMarkdownOverlayOpen,
        onInputFocusTracked: handleInputFocus,
    });

    const updateContextInput = useCallback((text: string) => {
        setContextInputDraft(text);
        setEditedTask((prev) => ({ ...prev, contexts: parseTokenList(text, '@') }));
    }, [setEditedTask]);
    const updateTagInput = useCallback((text: string) => {
        setTagInputDraft(text);
        setEditedTask((prev) => ({ ...prev, tags: parseTokenList(text, '#') }));
    }, [setEditedTask]);
    const applyContextSuggestion = useCallback((token: string) => {
        updateContextInput(replaceTrailingToken(contextInputDraft, token));
    }, [contextInputDraft, updateContextInput]);
    const applyTagSuggestion = useCallback((token: string) => {
        updateTagInput(replaceTrailingToken(tagInputDraft, token));
    }, [tagInputDraft, updateTagInput]);
    const applyAssignedToSuggestion = useCallback((assignedTo: string) => {
        setEditedTask((prev) => ({ ...prev, assignedTo }));
    }, [setEditedTask]);
    const createAssignedToPerson = useCallback(async (name: string) => {
        const created = await addPerson(name);
        if (created) {
            setEditedTask((prev) => ({ ...prev, assignedTo: created.name }));
        }
        return created;
    }, [addPerson, setEditedTask]);
    const closeWaitingAssignmentModal = useCallback(() => {
        setWaitingAssignmentModalVisible(false);
    }, []);
    const confirmWaitingAssignment = useCallback(() => {
        const assignedTo = waitingAssignmentInput.trim() || undefined;
        setEditedTask((prev) => ({ ...prev, status: 'waiting', assignedTo }));
        setWaitingAssignmentModalVisible(false);
    }, [setEditedTask, waitingAssignmentInput]);
    const requestStatusChange = useCallback((status: TaskStatus) => {
        const currentStatus = editedTask.status ?? task?.status;
        if (status === 'waiting' && currentStatus !== 'waiting') {
            setWaitingAssignmentInput(String(editedTask.assignedTo ?? task?.assignedTo ?? ''));
            setWaitingAssignmentModalVisible(true);
            return;
        }
        setEditedTask((prev) => ({ ...prev, status }));
    }, [editedTask.assignedTo, editedTask.status, setEditedTask, task?.assignedTo, task?.status]);
    const toggleQuickContextToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(contextInputDraft, '@'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateContextInput(Array.from(next).join(', '));
    }, [contextInputDraft, updateContextInput]);
    const toggleQuickTagToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(tagInputDraft, '#'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateTagInput(Array.from(next).join(', '));
    }, [tagInputDraft, updateTagInput]);
    const commitContextDraft = useCallback(() => {
        setIsContextInputFocused(false);
        updateContextInput(parseTokenList(contextInputDraft, '@').join(', '));
    }, [contextInputDraft, updateContextInput]);
    const commitTagDraft = useCallback(() => {
        setIsTagInputFocused(false);
        updateTagInput(parseTokenList(tagInputDraft, '#').join(', '));
    }, [tagInputDraft, updateTagInput]);

    const {
        applyChecklistUpdate,
        handleAIClarify,
        handleAIBreakdown,
        handleAttemptClose,
        handleConvertToReference,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handlePromoteTaskToProject,
        handleResetChecklist,
        handleShare,
    } = useTaskEditActions({
        aiEnabled,
        baseTaskRef,
        closeAIModal,
        contextInputDraft,
        customWeekdays,
        deleteTask,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        duplicateTask,
        promoteTaskToProject,
        editedTask,
        formatDate,
        formatDueDate,
        formatTimeEstimateLabel,
        isAIWorking,
        isContextInputFocused,
        isTagInputFocused,
        onClose,
        onSave,
        prioritiesEnabled,
        projectContext,
        recurrenceRuleValue,
        recurrenceRRuleValue,
        recurrenceStrategyValue,
        resetTaskChecklist,
        restoreTask,
        sections,
        setAiModal,
        setDescriptionDraft,
        setEditedTask,
        setIsAIWorking,
        setTitleImmediate,
        settings,
        showToast,
        t,
        tagInputDraft,
        task,
        tasks,
        timeEstimatesEnabled,
        titleDebounceRef,
        titleDraftRef,
    });

    const inputStyle = useMemo(
        () => ({ backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }),
        [tc.border, tc.inputBg, tc.text]
    );
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = useMemo(() => ({
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    }) as const, [resolvedDirection]);
    const openAttachmentRef = useRef(openAttachment);
    useEffect(() => {
        openAttachmentRef.current = openAttachment;
    }, [openAttachment]);
    const stableOpenAttachment = useCallback((attachment: Attachment) => (
        openAttachmentRef.current(attachment)
    ), []);
    const noopAIAction = useCallback(() => {}, []);
    const formHandleAIClarify = aiEnabled ? handleAIClarify : noopAIAction;
    const formHandleAIBreakdown = aiEnabled ? handleAIBreakdown : noopAIAction;
    const formApplyCopilotSuggestion = aiEnabled ? applyCopilotSuggestion : noopAIAction;
    const formCopilotTags = aiEnabled ? copilotTags : EMPTY_COPILOT_TAGS;
    const fieldRendererProps = useMemo(() => ({
        addFileAttachment,
        addImageAttachment,
        applyAssignedToSuggestion,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
        assignedToSuggestions,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        contextInputDraft,
        contextTokenSuggestions,
        createAssignedToPerson,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionInputRef: descriptionEditor.descriptionInputRef,
        descriptionSelection: descriptionEditor.descriptionSelection,
        descriptionSelectionRestorePending: descriptionEditor.descriptionSelectionRestorePending,
        setDescriptionSelection: descriptionEditor.setDescriptionSelection,
        descriptionToolbarInteractionUntilRef,
        isDescriptionInputFocused: descriptionEditor.isDescriptionInputFocused,
        setIsDescriptionInputFocused: descriptionEditor.setIsDescriptionInputFocused,
        handleDescriptionChange: descriptionEditor.handleDescriptionChange,
        handleDescriptionKeyPress: descriptionEditor.handleDescriptionKeyPress,
        applyDescriptionResult: descriptionEditor.applyDescriptionResult,
        applyQuickDate,
        openDescriptionExpandedEditor: descriptionEditor.openDescriptionExpandedEditor,
        downloadAttachment,
        editLinkAttachment,
        editedTask,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        applyChecklistUpdate,
        language,
        monthlyPattern,
        onDateChange,
        openAddLinkAttachment,
        openAttachment: stableOpenAttachment,
        openCustomRecurrence,
        pendingDueDate,
        pendingStartDate,
        prioritiesEnabled,
        energyLevelOptions,
        priorityOptions,
        projects,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        recurrenceWeekdayButtons,
        requestStatusChange,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setEditedTask,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setLinkInputTouched,
        setLinkModalVisible,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        showDatePicker,
        showDescriptionPreview,
        styles,
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    }), [
        addFileAttachment,
        addImageAttachment,
        applyAssignedToSuggestion,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
        assignedToSuggestions,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        contextInputDraft,
        contextTokenSuggestions,
        createAssignedToPerson,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionEditor.applyDescriptionResult,
        descriptionEditor.descriptionInputRef,
        descriptionEditor.descriptionSelection,
        descriptionEditor.descriptionSelectionRestorePending,
        descriptionEditor.handleDescriptionChange,
        descriptionEditor.handleDescriptionKeyPress,
        descriptionEditor.isDescriptionInputFocused,
        descriptionEditor.openDescriptionExpandedEditor,
        descriptionEditor.setDescriptionSelection,
        descriptionEditor.setIsDescriptionInputFocused,
        descriptionToolbarInteractionUntilRef,
        downloadAttachment,
        editLinkAttachment,
        editedTask,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        applyChecklistUpdate,
        language,
        monthlyPattern,
        onDateChange,
        openAddLinkAttachment,
        stableOpenAttachment,
        openCustomRecurrence,
        pendingDueDate,
        pendingStartDate,
        prioritiesEnabled,
        energyLevelOptions,
        priorityOptions,
        projects,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        recurrenceWeekdayButtons,
        requestStatusChange,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setEditedTask,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setLinkInputTouched,
        setLinkModalVisible,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        showDatePicker,
        showDescriptionPreview,
        styles,
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    ]);
    const renderField = useCallback((fieldId: TaskEditorFieldId) => (
        <TaskEditFieldRenderer fieldId={fieldId} {...fieldRendererProps} />
    ), [fieldRendererProps]);
    const handleViewStatusUpdate = useCallback((status: TaskStatus) => {
        requestStatusChange(status);
    }, [requestStatusChange]);
    const isTaskFormTextInputFocused = isTitleInputFocused
        || descriptionEditor.isDescriptionInputFocused
        || isContextInputFocused
        || isTagInputFocused;

    if (!task) return null;

    return (
        <>
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onRequestClose={handleAttemptClose}
        >
            <KeyboardAccessoryHost>
                <SafeAreaView
                    style={[styles.container, { backgroundColor: tc.bg }]}
                    edges={['top']}
                >
                    <TaskEditHeader
                        onDone={handleDone}
                        onShare={handleShare}
                        onDuplicate={handleDuplicateTask}
                        onPromoteToProject={handlePromoteTaskToProject}
                        onDelete={handleDeleteTask}
                        onConvertToReference={handleConvertToReference}
                        showConvertToReference={!isReference}
                    />

                    <TaskEditTabs
                        editTab={editTab}
                        onTabPress={handleTabPress}
                        scrollX={scrollX}
                        containerWidth={containerWidth}
                    />

                    <View
                        style={styles.tabContent}
                        onLayout={handleContainerLayout}
                    >
                        <Animated.ScrollView
                            ref={scrollRef}
                            horizontal
                            pagingEnabled
                            scrollEnabled={!isMarkdownOverlayOpen && !isTaskFormTextInputFocused}
                            scrollEventThrottle={16}
                            showsHorizontalScrollIndicator={false}
                            directionalLockEnabled
                            onScroll={Animated.event(
                                [{ nativeEvent: { contentOffset: { x: scrollX } } }],
                                { useNativeDriver: true }
                            )}
                            onMomentumScrollEnd={handleMomentumScrollEnd}
                        >
                            <TaskEditFormTab
                                t={t}
                                tc={tc}
                                styles={styles}
                                inputStyle={inputStyle}
                                editedTask={editedTask}
                                setEditedTask={setEditedTask}
                                aiEnabled={aiEnabled}
                                isAIWorking={isAIWorking}
                                handleAIClarify={formHandleAIClarify}
                                handleAIBreakdown={formHandleAIBreakdown}
                                copilotSuggestion={copilotSuggestion}
                                copilotApplied={copilotApplied}
                                applyCopilotSuggestion={formApplyCopilotSuggestion}
                                copilotContext={copilotContext}
                                copilotEstimate={copilotEstimate}
                                copilotTags={formCopilotTags}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                renderField={renderField}
                                basicFields={basicFields}
                                schedulingFields={schedulingFields}
                                organizationFields={organizationFields}
                                detailsFields={detailsFields}
                                sectionOpenDefaults={sectionOpenDefaults}
                                showDatePicker={showDatePicker}
                                pendingStartDate={pendingStartDate}
                                pendingDueDate={pendingDueDate}
                                getSafePickerDateValue={getSafePickerDateValue}
                                onDateChange={onDateChange}
                                containerWidth={containerWidth}
                                textDirectionStyle={textDirectionStyle}
                                titleDraft={titleDraft}
                                onTitleDraftChange={handleTitleDraftChange}
                                onInputFocusTracked={handleInputFocus}
                                onTitleInputFocusChange={setIsTitleInputFocused}
                                registerScrollToEnd={registerScrollTaskFormToEnd}
                                formResetKey={`${task.id}:${visible ? 'open' : 'closed'}`}
                                suspendKeyboardHandling={isMarkdownOverlayOpen}
                            />
                            <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
                                <TaskEditViewTab
                                    t={t}
                                    tc={tc}
                                    styles={styles}
                                    mergedTask={mergedTask}
                                    projects={projects}
                                    sections={projectSections}
                                    areas={areas}
                                    prioritiesEnabled={prioritiesEnabled}
                                    timeEstimatesEnabled={timeEstimatesEnabled}
                                    formatTimeEstimateLabel={formatTimeEstimateLabel}
                                    formatDate={formatDate}
                                    formatDueDate={formatDueDate}
                                    getRecurrenceRuleValue={getRecurrenceRuleValue}
                                    getRecurrenceStrategyValue={getRecurrenceStrategyValue}
                                    applyChecklistUpdate={applyChecklistUpdate}
                                    visibleAttachments={visibleAttachments}
                                    openAttachment={stableOpenAttachment}
                                    isImageAttachment={isImageAttachment}
                                    textDirectionStyle={textDirectionStyle}
                                    resolvedDirection={resolvedDirection}
                                    nestedScrollEnabled
                                    onProjectPress={onProjectNavigate ? handlePreviewProjectPress : undefined}
                                    onContextPress={onContextNavigate ? handlePreviewContextPress : undefined}
                                    onTagPress={onTagNavigate ? handlePreviewTagPress : undefined}
                                    onStatusUpdate={handleViewStatusUpdate}
                                    showStatusField={showStatusField}
                                />
                            </View>
                        </Animated.ScrollView>
                    </View>

                    <TaskEditOverlayStack
                        aiModal={aiModal}
                        addArea={addArea}
                        addProject={addProject}
                        addSection={addSection}
                        applyCustomRecurrence={applyCustomRecurrence}
                        areas={areas}
                        audioAttachment={audioAttachment}
                        audioLoading={audioLoading}
                        audioTranscribing={audioTranscribing}
                        audioTranscriptionError={audioTranscriptionError}
                        audioModalVisible={audioModalVisible}
                        audioStatus={audioStatus}
                        closeAIModal={closeAIModal}
                        closeAudioModal={closeAudioModal}
                        closeImagePreview={closeImagePreview}
                        closeLinkModal={closeLinkModal}
                        confirmAddLink={confirmAddLink}
                        customInterval={customInterval}
                        customMode={customMode}
                        customMonthDay={customMonthDay}
                        customOrdinal={customOrdinal}
                        customRecurrenceVisible={customRecurrenceVisible}
                        customWeekday={customWeekday}
                        filteredProjectsForPicker={filteredProjectsForPicker}
                        imagePreviewAttachment={imagePreviewAttachment}
                        linkInput={linkInput}
                        linkInputTouched={linkInputTouched}
                        linkModalVisible={linkModalVisible}
                        linkModalTitle={editingLinkAttachmentId ? t('common.edit') : t('attachments.addLink')}
                        projectFilterAreaId={projectFilterAreaId}
                        projects={projects}
                        recurrenceWeekdayButtons={recurrenceWeekdayButtons}
                        recurrenceWeekdayLabels={recurrenceWeekdayLabels}
                        sectionPickerProjectId={activeProjectId}
                        sectionPickerSections={projectSections}
                        setCustomInterval={setCustomInterval}
                        setCustomMode={setCustomMode}
                        setCustomMonthDay={setCustomMonthDay}
                        setCustomOrdinal={setCustomOrdinal}
                        setCustomRecurrenceVisible={setCustomRecurrenceVisible}
                        setCustomWeekday={setCustomWeekday}
                        setEditedTask={setEditedTask}
                        setLinkInput={setLinkInput}
                        setLinkInputTouched={setLinkInputTouched}
                        setShowAreaPicker={setShowAreaPicker}
                        setShowProjectPicker={setShowProjectPicker}
                        setShowSectionPicker={setShowSectionPicker}
                        showAreaPicker={showAreaPicker}
                        showProjectPicker={showProjectPicker}
                        showSectionPicker={showSectionPicker}
                        styles={styles}
                        task={task}
                        t={t}
                        tc={tc}
                        retryAudioTranscription={retryAudioTranscription}
                        toggleAudioPlayback={toggleAudioPlayback}
                        waitingAssignmentInput={waitingAssignmentInput}
                        waitingAssignmentModalVisible={waitingAssignmentModalVisible}
                        closeWaitingAssignmentModal={closeWaitingAssignmentModal}
                        confirmWaitingAssignment={confirmWaitingAssignment}
                        setWaitingAssignmentInput={setWaitingAssignmentInput}
                        DEFAULT_PROJECT_COLOR={DEFAULT_PROJECT_COLOR}
                    />
                    <MarkdownFormatToolbar
                        selection={descriptionEditor.descriptionSelection}
                        onSelectionChange={descriptionEditor.setDescriptionSelection}
                        inputRef={descriptionEditor.descriptionInputRef}
                        t={t}
                        tc={tc}
                        visible={
                            descriptionEditor.isDescriptionInputFocused
                            && editTab === 'task'
                            && !showDescriptionPreview
                            && !descriptionEditor.descriptionExpanded
                        }
                        canUndo={descriptionEditor.descriptionUndoDepth > 0}
                        onUndo={descriptionEditor.handleDescriptionUndo}
                        onApplyAction={descriptionEditor.handleDescriptionApplyAction}
                        onInteractionStart={() => {
                            descriptionToolbarInteractionUntilRef.current = Date.now() + 300;
                            descriptionEditor.setIsDescriptionInputFocused(true);
                        }}
                    />
                </SafeAreaView>
            </KeyboardAccessoryHost>
        </Modal>
        {visible ? (
            <ExpandedMarkdownEditor
                isOpen={descriptionEditor.descriptionExpanded}
                onClose={descriptionEditor.closeDescriptionExpandedEditor}
                value={descriptionDraft}
                onChange={descriptionEditor.handleDescriptionChange}
                title={t('taskEdit.descriptionLabel')}
                headerTitle={titleDraft.trim() || task?.title?.trim() || t('taskEdit.descriptionLabel')}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                t={t}
                initialMode="edit"
                direction={resolvedDirection}
                selection={descriptionEditor.descriptionSelection}
                onSelectionChange={descriptionEditor.setDescriptionSelection}
                canUndo={descriptionEditor.descriptionUndoDepth > 0}
                onUndo={descriptionEditor.handleDescriptionUndo}
                onApplyAction={descriptionEditor.handleDescriptionApplyAction}
                currentTaskId={task?.id}
            />
        ) : null}
        </>
    );
}

const areTaskEditModalPropsEqual = (prev: TaskEditModalProps, next: TaskEditModalProps): boolean => (
    prev.visible === next.visible && prev.task === next.task && prev.onClose === next.onClose && prev.onSave === next.onSave
    && prev.onFocusMode === next.onFocusMode && prev.defaultTab === next.defaultTab
    && prev.onProjectNavigate === next.onProjectNavigate && prev.onContextNavigate === next.onContextNavigate && prev.onTagNavigate === next.onTagNavigate
);

const TaskEditModalWithBoundary = (props: TaskEditModalProps) => {
    const { t } = useLanguage();
    const tc = useThemeColors();
    return <TaskEditModalErrorBoundary onClose={props.onClose} taskId={props.task?.id} t={t} tc={tc}><TaskEditModalInner {...props} /></TaskEditModalErrorBoundary>;
};

export const TaskEditModal = React.memo(TaskEditModalWithBoundary, areTaskEditModalPropsEqual);
