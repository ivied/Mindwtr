import { useCallback } from 'react';
import {
    extractChecklistFromMarkdown,
    getRecurrenceCompletedOccurrencesValue,
    parseRRuleString,
    type Recurrence,
    type StoreActionResult,
    type Task,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';

import { mergeMarkdownChecklist } from './task-item-checklist';

type UseTaskItemSubmitParams = {
    editAreaId: string;
    editAssignedTo: string;
    editAttachments: Task['attachments'] | undefined;
    editContexts: string;
    editDescription: string;
    editDueDate: string;
    editEnergyLevel: TaskEnergyLevel | '';
    editLocation: string;
    editPriority: TaskPriority | '';
    editProjectId: string;
    editRecurrence: Task['recurrence'] extends infer R ? R extends { rule?: infer Rule } ? Rule | '' : '' : '';
    editRecurrenceRRule: string;
    editRecurrenceStrategy: Task['recurrence'] extends infer R ? R extends { strategy?: infer Strategy } ? Strategy : never : never;
    editShowFutureRecurrence: boolean;
    editReviewAt: string;
    editRepeatReminderMinutes: number | undefined;
    editSectionId: string;
    editStartTime: string;
    editRelativeStartOffset: Task['relativeStartOffset'];
    editStatus: Task['status'];
    editTags: string;
    editTimeEstimate: TimeEstimate | '';
    editTitle: string;
    editingTaskId: string | null;
    setEditingTaskId: (id: string | null) => void;
    setIsEditing: (value: boolean) => void;
    showToast: (message: string, tone?: 'info' | 'error' | 'success') => void;
    task: Task;
    updateTask: (id: string, patch: Partial<Task>) => Promise<StoreActionResult>;
};

type TaskItemSubmitOptions = {
    statusOverride?: TaskStatus;
};

export function useTaskItemSubmit({
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
}: UseTaskItemSubmitParams) {
    return useCallback(async (event?: React.FormEvent, options?: TaskItemSubmitOptions) => {
        event?.preventDefault();
        const cleanedTitle = editTitle.trim() ? editTitle.trim() : task.title;
        if (!cleanedTitle.trim()) return;

        const resolvedProjectId = editProjectId || undefined;
        const recurrenceValue: Recurrence | undefined = editRecurrence
            ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
            : undefined;
        if (recurrenceValue && editRecurrenceRRule) {
            const parsed = parseRRuleString(editRecurrenceRRule);
            if (parsed.byDay && parsed.byDay.length > 0) {
                recurrenceValue.byDay = parsed.byDay;
            }
            if (parsed.byMonthDay && parsed.byMonthDay.length > 0) {
                recurrenceValue.byMonthDay = parsed.byMonthDay;
            }
            if (parsed.count) {
                recurrenceValue.count = parsed.count;
            }
            if (parsed.until) {
                recurrenceValue.until = parsed.until;
            }
            const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence);
            if (typeof completedOccurrences === 'number') {
                recurrenceValue.completedOccurrences = completedOccurrences;
            }
            recurrenceValue.rrule = editRecurrenceRRule;
        }
        const currentContexts = editContexts.split(',').map((context) => context.trim()).filter(Boolean);
        const currentTags = editTags.split(',').map((tag) => tag.trim()).filter(Boolean);
        const resolvedDescription = editDescription || undefined;
        const markdownChecklist = extractChecklistFromMarkdown(String(resolvedDescription ?? ''));
        const previousMarkdownChecklist = extractChecklistFromMarkdown(String(task.description ?? ''));
        const resolvedChecklist = markdownChecklist.length > 0
            ? mergeMarkdownChecklist(markdownChecklist, task.checklist)
            : previousMarkdownChecklist.length > 0
                ? []
                : undefined;
        const resolvedSectionId = resolvedProjectId ? (editSectionId || undefined) : undefined;
        const resolvedAreaId = resolvedProjectId ? undefined : (editAreaId || undefined);

        const result = await updateTask(task.id, {
            title: cleanedTitle,
            status: options?.statusOverride ?? editStatus,
            dueDate: editDueDate || undefined,
            startTime: editStartTime || undefined,
            relativeStartOffset: editRelativeStartOffset,
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: resolvedAreaId,
            contexts: currentContexts,
            tags: currentTags,
            description: resolvedDescription,
            ...(resolvedChecklist ? { checklist: resolvedChecklist } : {}),
            location: editLocation || undefined,
            recurrence: recurrenceValue,
            showFutureRecurrence: recurrenceValue && editShowFutureRecurrence ? true : undefined,
            timeEstimate: editTimeEstimate || undefined,
            priority: editPriority || undefined,
            energyLevel: editEnergyLevel || undefined,
            assignedTo: editAssignedTo.trim() || undefined,
            reviewAt: editReviewAt || undefined,
            repeatReminderMinutes: editRepeatReminderMinutes || undefined,
            attachments: (editAttachments?.length ?? 0) > 0 ? editAttachments : undefined,
        });
        if (!result.success) {
            showToast(result.error || 'Failed to update task', 'error');
            return result;
        }
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
        return result;
    }, [
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
    ]);
}
