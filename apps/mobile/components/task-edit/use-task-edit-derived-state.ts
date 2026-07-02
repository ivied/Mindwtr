import { useCallback, useMemo } from 'react';
import {
    filterProjectsBySelectedArea,
    formatTimeEstimateLabel as formatCoreTimeEstimateLabel,
    isCustomTimeEstimate,
    parseRRuleString,
    safeParseDate,
    type AppData,
    type Project,
    type RecurrenceRule,
    type RecurrenceWeekday,
    type Section,
    type Task,
    type TaskEditorFieldId,
    type TaskPriority,
    type TimeEstimate,
} from '@mindwtr/core';
import {
    getRecurrenceRRuleValue,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    WEEKDAY_ORDER,
} from './recurrence-utils';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    DEFAULT_TASK_EDITOR_VISIBLE,
    getEditedTaskValue,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    STATUS_OPTIONS,
    TASK_EDITOR_FIXED_FIELDS,
} from './task-edit-modal.utils';
import type { PickerOption } from './TaskEditFieldRenderer.types';

const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['5min', '10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const ALL_TIME_ESTIMATES: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: Array<NonNullable<Task['energyLevel']>> = ['low', 'medium', 'high'];
const REFERENCE_HIDDEN_FIELDS = new Set<TaskEditorFieldId>([
    'startTime',
    'dueDate',
    'reviewAt',
    'recurrence',
    'priority',
    'energyLevel',
    'timeEstimate',
    'checklist',
]);

export const getMonthlyRecurrenceAnchorDate = (editedTask: Partial<Task>, task: Task | null): Date => (
    safeParseDate(editedTask.dueDate || editedTask.startTime || task?.dueDate || task?.startTime) ?? new Date()
);

type UseTaskEditDerivedStateArgs = {
    task: Task | null;
    editedTask: Partial<Task>;
    settings: AppData['settings'];
    projects: Project[];
    sections: Section[];
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    contextInputDraft: string;
    descriptionDraft: string;
    tagInputDraft: string;
    visibleAttachmentsLength: number;
    t: (key: string) => string;
};

export function useTaskEditDerivedState({
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
    visibleAttachmentsLength,
    t,
}: UseTaskEditDerivedStateArgs) {
    const activeProjectId = getEditedTaskValue(editedTask, task, 'projectId');
    const projectFilterAreaId =
        typeof editedTask.areaId === 'string' && editedTask.areaId.trim().length > 0
            ? editedTask.areaId
            : undefined;
    const filteredProjectsForPicker = useMemo(
        () => filterProjectsBySelectedArea(projects, projectFilterAreaId),
        [projectFilterAreaId, projects]
    );

    const recurrenceOptions: PickerOption<RecurrenceRule>[] = useMemo(
        () => [
            { value: '', label: t('recurrence.none') },
            { value: 'daily', label: t('recurrence.daily') },
            { value: 'weekly', label: t('recurrence.weekly') },
            { value: 'monthly', label: t('recurrence.monthly') },
            { value: 'yearly', label: t('recurrence.yearly') },
        ],
        [t]
    );
    const recurrenceRuleValue = getRecurrenceRuleValue(editedTask.recurrence);
    const recurrenceStrategyValue = getRecurrenceStrategyValue(editedTask.recurrence);
    const recurrenceRRuleValue = getRecurrenceRRuleValue(editedTask.recurrence);
    const dailyInterval = useMemo(() => {
        if (recurrenceRuleValue !== 'daily') return 1;
        const parsed = parseRRuleString(recurrenceRRuleValue);
        return parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
    }, [recurrenceRRuleValue, recurrenceRuleValue]);
    const monthlyAnchorDate = useMemo(
        () => getMonthlyRecurrenceAnchorDate(editedTask, task),
        [editedTask.dueDate, editedTask.startTime, task?.dueDate, task?.startTime]
    );
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()] as RecurrenceWeekday;
    const monthlyPattern = useMemo<'date' | 'custom'>(() => {
        if (recurrenceRuleValue !== 'monthly') return 'date';
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const hasLast = parsed.byDay?.some((day) => String(day).startsWith('-1'));
        const hasNth = parsed.byDay?.some((day) => /^[1-4]/.test(String(day)));
        const hasByMonthDay = parsed.byMonthDay && parsed.byMonthDay.length > 0;
        const isCustomDay = hasByMonthDay && parsed.byMonthDay?.[0] !== monthlyAnchorDate.getDate();
        return hasNth || hasLast || isCustomDay ? 'custom' : 'date';
    }, [monthlyAnchorDate, recurrenceRRuleValue, recurrenceRuleValue]);

    const formatTimeEstimateLabel = useCallback((value: TimeEstimate) => formatCoreTimeEstimateLabel(value), []);

    const savedPresetsKey = settings.gtd?.timeEstimatePresets?.join('|') ?? '';
    const currentEstimate = editedTask.timeEstimate as TimeEstimate | undefined;
    const timeEstimateOptions: { value: TimeEstimate | ''; label: string }[] = useMemo(
        () => {
            const savedPresets = settings.gtd?.timeEstimatePresets;
            const basePresets = savedPresets?.length ? savedPresets : DEFAULT_TIME_ESTIMATE_PRESETS;
            const normalizedPresets = ALL_TIME_ESTIMATES.filter((value) => basePresets.includes(value));
            const effectivePresets = currentEstimate && !isCustomTimeEstimate(currentEstimate) && !normalizedPresets.includes(currentEstimate)
                ? [...normalizedPresets, currentEstimate]
                : normalizedPresets;
            return [
                { value: '', label: t('common.none') },
                ...effectivePresets.map((value) => ({ value, label: formatTimeEstimateLabel(value) })),
            ];
        },
        [currentEstimate, formatTimeEstimateLabel, savedPresetsKey, settings.gtd?.timeEstimatePresets, t]
    );

    const savedOrder = useMemo(() => settings.gtd?.taskEditor?.order ?? [], [settings.gtd?.taskEditor?.order]);
    const savedHidden = useMemo(() => {
        const featureHiddenFields = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) featureHiddenFields.add('priority');
        if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');
        const defaultHidden = DEFAULT_TASK_EDITOR_ORDER.filter(
            (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId) || featureHiddenFields.has(fieldId)
        );
        return settings.gtd?.taskEditor?.hidden ?? defaultHidden;
    }, [prioritiesEnabled, settings.gtd?.taskEditor?.hidden, timeEstimatesEnabled]);
    const isReference = (editedTask.status ?? task?.status) === 'reference';
    const availableStatusOptions = useMemo(
        () => (isReference ? STATUS_OPTIONS : STATUS_OPTIONS.filter((status) => status !== 'reference')),
        [isReference]
    );
    const disabledFields = useMemo(() => {
        const next = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [prioritiesEnabled, timeEstimatesEnabled]);
    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing].filter((id) => !disabledFields.has(id));
    }, [disabledFields, savedOrder]);
    const sectionAssignments = useMemo(
        () => getTaskEditorSectionAssignments(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const sectionOpenDefaults = useMemo(
        () => getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        const next = new Set(savedHidden.filter((id) => known.has(id)));
        if (settings.features?.priorities === false) next.add('priority');
        if (settings.features?.timeEstimates === false) next.add('timeEstimate');
        return next;
    }, [savedHidden, settings.features?.priorities, settings.features?.timeEstimates, taskEditorOrder]);
    const orderFields = useCallback(
        (fields: TaskEditorFieldId[]) => {
            const ordered = taskEditorOrder.filter((id) => fields.includes(id));
            const missing = fields.filter((id) => !ordered.includes(id));
            return [...ordered, ...missing];
        },
        [taskEditorOrder]
    );
    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return false;
            case 'project':
                return Boolean(getEditedTaskValue(editedTask, task, 'projectId'));
            case 'section':
                return Boolean(getEditedTaskValue(editedTask, task, 'sectionId'));
            case 'area':
                return Boolean(getEditedTaskValue(editedTask, task, 'areaId'));
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(editedTask.priority ?? task?.priority);
            case 'energyLevel':
                return Boolean(editedTask.energyLevel ?? task?.energyLevel);
            case 'assignedTo':
                return Boolean(String(editedTask.assignedTo ?? task?.assignedTo ?? '').trim());
            case 'contexts':
                return Boolean(contextInputDraft.trim());
            case 'description':
                return Boolean(descriptionDraft.trim());
            case 'location':
                return Boolean(String(editedTask.location ?? task?.location ?? '').trim());
            case 'tags':
                return Boolean(tagInputDraft.trim());
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return false;
                return Boolean(editedTask.timeEstimate ?? task?.timeEstimate);
            case 'recurrence':
                return Boolean(editedTask.recurrence ?? task?.recurrence);
            case 'startTime':
                return Boolean(editedTask.startTime ?? task?.startTime);
            case 'dueDate':
                return Boolean(editedTask.dueDate ?? task?.dueDate);
            case 'reviewAt':
                return Boolean(editedTask.reviewAt ?? task?.reviewAt);
            case 'attachments':
                return visibleAttachmentsLength > 0;
            case 'checklist':
                return (editedTask.checklist ?? task?.checklist ?? []).length > 0;
            default:
                return false;
        }
    }, [
        contextInputDraft,
        descriptionDraft,
        editedTask.assignedTo,
        editedTask.areaId,
        editedTask.checklist,
        editedTask.dueDate,
        editedTask.energyLevel,
        editedTask.location,
        editedTask.priority,
        editedTask.projectId,
        editedTask.recurrence,
        editedTask.reviewAt,
        editedTask.sectionId,
        editedTask.startTime,
        editedTask.status,
        editedTask.timeEstimate,
        prioritiesEnabled,
        tagInputDraft,
        task?.assignedTo,
        task?.areaId,
        task?.checklist,
        task?.dueDate,
        task?.energyLevel,
        task?.location,
        task?.priority,
        task?.projectId,
        task?.recurrence,
        task?.reviewAt,
        task?.sectionId,
        task?.startTime,
        task?.status,
        task?.timeEstimate,
        timeEstimatesEnabled,
        visibleAttachmentsLength,
    ]);
    const isFieldVisible = useCallback(
        (fieldId: TaskEditorFieldId) => {
            if (isReference && REFERENCE_HIDDEN_FIELDS.has(fieldId)) return false;
            return !hiddenSet.has(fieldId) || hasValue(fieldId);
        },
        [hasValue, hiddenSet, isReference]
    );
    const filterVisibleFields = useCallback(
        (fields: TaskEditorFieldId[]) => fields.filter(isFieldVisible),
        [isFieldVisible]
    );
    const basicFields = useMemo(
        () => filterVisibleFields(orderFields(
            taskEditorOrder.filter((fieldId) => {
                if (TASK_EDITOR_FIXED_FIELDS.includes(fieldId)) return true;
                return sectionAssignments[fieldId] === 'basic';
            })
        )),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const schedulingFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'scheduling'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const organizationFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'organization'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const detailsFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'details'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const showStatusField = isFieldVisible('status');
    const projectSections = useMemo(() => {
        if (!activeProjectId) return [];
        return sections
            .filter((section) => section.projectId === activeProjectId && !section.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? a.order : 0;
                const bOrder = Number.isFinite(b.order) ? b.order : 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
    }, [activeProjectId, sections]);

    return {
        activeProjectId,
        availableStatusOptions,
        basicFields,
        dailyInterval,
        detailsFields,
        energyLevelOptions: ENERGY_LEVEL_OPTIONS,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields,
        priorityOptions: PRIORITY_OPTIONS,
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
    };
}
