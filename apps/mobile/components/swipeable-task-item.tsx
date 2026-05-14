import { Text, Pressable, Alert } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import {
    formatFocusTaskLimitText,
    getProjectNextActionPromptData,
    getStatusColor,
    hasTimeComponent,
    normalizeFocusTaskLimit,
    safeFormatDate,
    safeParseDueDate,
    shallow,
    tFallback,
    useTaskStore,
} from '@mindwtr/core';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import React, { useCallback, useRef, useState } from 'react';
import { ArrowRight, Check, RotateCcw, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ThemeColors } from '../hooks/use-theme-colors';
import { useToast } from '../contexts/toast-context';
import { SwipeableTaskItemContent } from './swipeable-task-item/SwipeableTaskItemContent';
import { ProjectNextActionPromptModal } from './swipeable-task-item/ProjectNextActionPromptModal';
import { SwipeableTaskItemStatusMenu } from './swipeable-task-item/SwipeableTaskItemStatusMenu';
import { styles } from './swipeable-task-item/swipeable-task-item.styles';
import { useSwipeableChecklist } from './swipeable-task-item/useSwipeableChecklist';

export interface SwipeableTaskItemProps {
    task: Task;
    isDark: boolean;
    /** Theme colors object from useThemeColors hook */
    tc: ThemeColors;
    onPress: () => void;
    onStatusChange: (status: TaskStatus) => void | Promise<unknown>;
    onDelete: () => void | Promise<void>;
    onLongPressAction?: () => void;
    /** Hide context tags (useful when viewing a specific context) */
    hideContexts?: boolean;
    /** Multi-select mode for bulk actions */
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
    isHighlighted?: boolean;
    showFocusToggle?: boolean;
    hideStatusBadge?: boolean;
    disableSwipe?: boolean;
    interactionDisabled?: boolean;
    hideChecklistProgress?: boolean;
    onProjectPress?: (projectId: string) => void;
    onContextPress?: (context: string) => void;
    onTagPress?: (tag: string) => void;
}

type ProjectNextActionPromptState = {
    candidates: Task[];
    projectId: string;
    projectTitle: string;
    sectionId?: string;
};

/**
 * A swipeable task item with context-aware left swipe actions:
 * - Inbox: swipe to Next
 * - Next: swipe to Done
 * - Waiting/Someday: swipe to Next
 * - Done: swipe to restore to Inbox
 * 
 * Right swipe always shows Delete action.
 */
export function SwipeableTaskItem({
    task,
    isDark,
    tc,
    onPress,
    onStatusChange,
    onDelete,
    onLongPressAction,
    hideContexts = false,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    isHighlighted = false,
    showFocusToggle = false,
    hideStatusBadge = false,
    disableSwipe = false,
    interactionDisabled = false,
    hideChecklistProgress = false,
    onProjectPress,
    onContextPress,
    onTagPress,
}: SwipeableTaskItemProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const ignorePressUntil = useRef<number>(0);
    const { t, language } = useLanguage();
    const { showToast } = useToast();
    const {
        addTask,
        updateTask,
        restoreTask,
        projects,
        areas,
        focusedCount,
        focusTaskLimit,
        timeEstimatesEnabled,
        showTaskAge,
        undoNotificationsEnabled,
    } = useTaskStore((state) => ({
        addTask: state.addTask,
        updateTask: state.updateTask,
        restoreTask: state.restoreTask,
        projects: state.projects,
        areas: state.areas,
        focusedCount: state.getDerivedState().focusedCount,
        focusTaskLimit: normalizeFocusTaskLimit(state.settings?.gtd?.focusTaskLimit),
        timeEstimatesEnabled: state.settings?.features?.timeEstimates !== false,
        showTaskAge: state.settings?.appearance?.showTaskAge === true,
        undoNotificationsEnabled: state.settings?.undoNotificationsEnabled !== false,
    }), shallow);
    const canShowFocusToggle = showFocusToggle
        && task.status !== 'done'
        && task.status !== 'reference'
        && task.status !== 'archived';
    const {
        cancelPendingChecklist,
        checklistProgress,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    } = useSwipeableChecklist(task, updateTask);
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [projectNextActionPrompt, setProjectNextActionPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const [projectNextActionTitle, setProjectNextActionTitle] = useState('');

    const closeProjectNextActionPrompt = useCallback(() => {
        setProjectNextActionPrompt(null);
        setProjectNextActionTitle('');
    }, []);

    const openProjectNextActionPromptIfNeeded = useCallback((completedTaskId: string) => {
        const storeState = useTaskStore.getState();
        const taskLookup = storeState._tasksById instanceof Map ? storeState._tasksById : null;
        const allTasks = Array.isArray(storeState._allTasks) ? storeState._allTasks : storeState.tasks;
        const allProjects = Array.isArray(storeState._allProjects) ? storeState._allProjects : storeState.projects;
        const completedTask = taskLookup?.get(completedTaskId)
            ?? allTasks.find((candidate) => candidate.id === completedTaskId)
            ?? { ...task, status: 'done' as TaskStatus };
        const promptData = getProjectNextActionPromptData(completedTask, allTasks, allProjects);
        if (!promptData) return;
        setProjectNextActionTitle('');
        setProjectNextActionPrompt({
            candidates: promptData.candidates,
            projectId: promptData.project.id,
            projectTitle: promptData.project.title,
            sectionId: completedTask.sectionId,
        });
    }, [task]);

    const handleStatusChange = useCallback((status: TaskStatus) => {
        let result: void | Promise<unknown>;
        try {
            result = onStatusChange(status);
        } catch {
            return;
        }
        if (status !== 'done' || task.status === 'done') return;
        void Promise.resolve(result)
            .then(() => openProjectNextActionPromptIfNeeded(task.id))
            .catch(() => undefined);
    }, [onStatusChange, openProjectNextActionPromptIfNeeded, task.id, task.status]);

    const handlePromoteProjectNextAction = useCallback((nextTaskId: string) => {
        void Promise.resolve(updateTask(nextTaskId, { status: 'next' }))
            .then((result) => {
                if (result && !result.success) {
                    throw new Error(result.error || 'Failed to choose next action');
                }
                closeProjectNextActionPrompt();
            })
            .catch(() => undefined);
    }, [closeProjectNextActionPrompt, updateTask]);

    const handleAddProjectNextAction = useCallback(() => {
        if (!projectNextActionPrompt) return;
        const title = projectNextActionTitle.trim();
        if (!title) return;
        void Promise.resolve(addTask(title, {
            status: 'next',
            projectId: projectNextActionPrompt.projectId,
            sectionId: projectNextActionPrompt.sectionId,
        }))
            .then((result) => {
                if (result && !result.success) {
                    throw new Error(result.error || 'Failed to add next action');
                }
                closeProjectNextActionPrompt();
            })
            .catch(() => undefined);
    }, [addTask, closeProjectNextActionPrompt, projectNextActionPrompt, projectNextActionTitle]);

    const toggleFocus = () => {
        if (selectionMode) return;
        if (task.isFocusedToday) {
            updateTask(task.id, { isFocusedToday: false });
            return;
        }
        if (focusedCount >= focusTaskLimit) {
            showToast({
                title: t('digest.focus') || 'Focus',
                message: formatFocusTaskLimitText(
                    tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items.'),
                    focusTaskLimit
                ),
                tone: 'warning',
            });
            return;
        }
        const updates: Partial<Task> = {
            isFocusedToday: true,
            ...(task.status !== 'next' ? { status: 'next' } : {}),
        };
        updateTask(task.id, updates);
    };

    // Status-aware left swipe action
    const getLeftAction = (): { label: string; color: string; action: TaskStatus } => {
        if (task.status === 'done') {
            return { label: t('archived.restoreToInbox') || 'Restore', color: getStatusColor('inbox').text, action: 'inbox' };
        } else if (task.status === 'next') {
            return { label: t('common.done') || 'Done', color: getStatusColor('done').text, action: 'done' };
        } else if (task.status === 'waiting' || task.status === 'someday' || task.status === 'reference') {
            return { label: t('status.next') || 'Next', color: getStatusColor('next').text, action: 'next' };
        } else if (task.status === 'inbox') {
            return { label: t('status.next') || 'Next', color: getStatusColor('next').text, action: 'next' };
        } else {
            return { label: t('common.done') || 'Done', color: getStatusColor('done').text, action: 'done' };
        }
    };

    const leftAction = getLeftAction();
    const swipeAccessibilityHint = interactionDisabled
        ? tFallback(t, 'projects.taskOrder', 'Task order')
        : selectionMode || disableSwipe
        ? 'Double tap to edit task details. Additional actions are available in the accessibility actions menu.'
        : `Double tap to edit task details. Swipe right to ${leftAction.label.toLowerCase()} and swipe left to delete. Additional actions are available in the accessibility actions menu.`;

    const renderLeftActions = () => {
        const LeftIcon = leftAction.action === 'inbox' ? RotateCcw : leftAction.action === 'done' ? Check : ArrowRight;
        return (
            <Pressable
                style={[styles.swipeActionLeft, { backgroundColor: leftAction.color }]}
                onPress={() => {
                    swipeableRef.current?.close();
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                    handleStatusChange(leftAction.action);
                }}
                accessibilityLabel={`${leftAction.label} action`}
                accessibilityRole="button"
            >
                <LeftIcon size={20} color="#FFFFFF" />
                <Text style={styles.swipeActionText}>{leftAction.label}</Text>
            </Pressable>
        );
    };

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionRight}
            onPress={() => {
                swipeableRef.current?.close();
                confirmDelete();
            }}
            accessibilityLabel={t('task.aria.delete') || 'Delete task'}
            accessibilityRole="button"
        >
            <Trash2 size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText}>{t('common.delete')}</Text>
        </Pressable>
    );

    const accessibilityLabel = [
        task.title,
        `Status: ${t(`status.${task.status}`)}`,
        (() => {
            const due = safeParseDueDate(task.dueDate);
            if (!due) return null;
            const hasTime = hasTimeComponent(task.dueDate);
            return `Due: ${safeFormatDate(due, hasTime ? 'Pp' : 'P')}`;
        })(),
    ].filter(Boolean).join('. ');

    const handlePress = () => {
        if (interactionDisabled) return;
        if (Date.now() < ignorePressUntil.current) return;
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
    };

    const confirmDelete = () => {
        Alert.alert(
            task.title,
            t('task.deleteConfirmBody') || 'Move this task to Trash?',
            [
                { text: t('common.cancel') || 'Cancel', style: 'cancel' },
                {
                    text: t('common.delete') || 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
                        cancelPendingChecklist();
                        let deletePromise: Promise<unknown>;
                        try {
                            deletePromise = Promise.resolve(onDelete());
                        } catch (error) {
                            deletePromise = Promise.reject(error);
                        }
                        void deletePromise
                            .then(() => {
                                if (!undoNotificationsEnabled) return;
                                showToast({
                                    title: t('common.notice') || 'Notice',
                                    message: t('list.taskDeleted') || 'Task deleted',
                                    tone: 'info',
                                    actionLabel: t('common.undo') || 'Undo',
                                    onAction: () => { void restoreTask(task.id); },
                                    durationMs: 5200,
                                });
                            })
                            .catch(() => undefined);
                    },
                },
            ],
            { cancelable: true }
        );
    };

    const handleLongPress = () => {
        if (interactionDisabled) return;
        ignorePressUntil.current = Date.now() + 500;
        // Note: onDragStart is handled by the drag handle directly, not here
        if (onLongPressAction) {
            onLongPressAction();
            return;
        }
        if (onToggleSelect) onToggleSelect();
    };

    const accessibilityActions = interactionDisabled ? [] : [
        { name: 'activate', label: t('common.edit') || 'Edit' },
        ...(!selectionMode
            ? [
                { name: 'changeStatus', label: leftAction.label },
                { name: 'delete', label: t('common.delete') || 'Delete' },
            ]
            : []),
    ];

    const handleAccessibilityAction = (event: { nativeEvent: { actionName: string } }) => {
        const { actionName } = event.nativeEvent;
        if (actionName === 'activate') {
            handlePress();
            return;
        }
        if (selectionMode) return;
        if (actionName === 'changeStatus') {
            handleStatusChange(leftAction.action);
            return;
        }
        if (actionName === 'delete') {
            confirmDelete();
        }
    };

    const content = (
        <SwipeableTaskItemContent
            accessibilityActions={accessibilityActions}
            accessibilityHint={swipeAccessibilityHint}
            accessibilityLabel={accessibilityLabel}
            areas={areas}
            canShowFocusToggle={canShowFocusToggle}
            checklistProgress={checklistProgress}
            hideChecklistProgress={hideChecklistProgress}
            hideContexts={hideContexts}
            hideStatusBadge={hideStatusBadge}
            isDark={isDark}
            isHighlighted={isHighlighted}
            isMultiSelected={isMultiSelected}
            interactionDisabled={interactionDisabled}
            language={language}
            localChecklist={localChecklist}
            onAccessibilityAction={handleAccessibilityAction}
            onContextPress={onContextPress}
            onLongPress={handleLongPress}
            onOpenStatusMenu={() => setShowStatusMenu(true)}
            onPress={handlePress}
            onProjectPress={onProjectPress}
            onTagPress={onTagPress}
            onToggleChecklist={toggleChecklist}
            onToggleChecklistItem={toggleChecklistItem}
            onToggleFocus={toggleFocus}
            projects={projects}
            selectionMode={selectionMode}
            showChecklist={showChecklist}
            showTaskAge={showTaskAge}
            t={t}
            task={{
                ...task,
                timeEstimate: timeEstimatesEnabled ? task.timeEstimate : undefined,
            }}
            tc={tc}
        />
    );

    return (
        <>
            {disableSwipe || interactionDisabled ? (
                content
            ) : (
                <Swipeable
                    ref={swipeableRef}
                    renderLeftActions={renderLeftActions}
                    renderRightActions={renderRightActions}
                    overshootLeft={false}
                    overshootRight={false}
                    enabled={!selectionMode && !disableSwipe}
                >
                    {content}
                </Swipeable>
            )}

            <SwipeableTaskItemStatusMenu
                visible={showStatusMenu}
                onClose={() => setShowStatusMenu(false)}
                onStatusChange={handleStatusChange}
                taskStatus={task.status}
                tc={tc}
                t={t}
            />
            {projectNextActionPrompt ? (
                <ProjectNextActionPromptModal
                    visible={Boolean(projectNextActionPrompt)}
                    candidates={projectNextActionPrompt.candidates}
                    projectTitle={projectNextActionPrompt.projectTitle}
                    newTitle={projectNextActionTitle}
                    tc={tc}
                    t={t}
                    onAddTask={handleAddProjectNextAction}
                    onCancel={closeProjectNextActionPrompt}
                    onChooseTask={handlePromoteProjectNextAction}
                    onNewTitleChange={setProjectNextActionTitle}
                />
            ) : null}
        </>
    );
}
