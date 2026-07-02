import React from 'react';
import { Platform } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { buildRRuleString, computeRelativeStartTime, hasTimeComponent, parseRRuleString, safeFormatDate, safeParseDate, safeParseDueDate, type Task } from '@mindwtr/core';

import type { SetEditedTask } from './use-task-edit-state';
import { buildRecurrenceValue } from './recurrence-utils';

type TaskEditDatePickerMode = 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end';

type UseTaskEditDatesParams = {
    editedTask: Partial<Task>;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    setEditedTask: SetEditedTask;
    setPendingDueDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setPendingStartDate: React.Dispatch<React.SetStateAction<Date | null>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end' | null>>;
    showDatePicker: 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'recurrence-end' | null;
    defaultScheduleTime?: string;
    t: (key: string) => string;
};

const buildDateWithTimeValue = (date: Date, time: string): string => {
    const dateOnly = safeFormatDate(date, 'yyyy-MM-dd');
    return time ? `${dateOnly}T${time}` : dateOnly;
};

const applyClockTime = (date: Date, time: string): Date => {
    const combined = new Date(date);
    const [hour, minute] = time.split(':').map((part) => Number.parseInt(part, 10));
    combined.setHours(
        Number.isFinite(hour) ? hour : 0,
        Number.isFinite(minute) ? minute : 0,
        0,
        0
    );
    return combined;
};


const applyStartTimeUpdate = (setEditedTask: SetEditedTask, startTime: string | undefined) => {
    setEditedTask((prev) => ({ ...prev, startTime, relativeStartOffset: undefined }));
};

const applyDueDateUpdate = (setEditedTask: SetEditedTask, dueDate: string | undefined) => {
    setEditedTask((prev) => {
        if (!dueDate) return { ...prev, dueDate: undefined, relativeStartOffset: undefined };
        const computedStart = computeRelativeStartTime(dueDate, prev.relativeStartOffset);
        return {
            ...prev,
            dueDate,
            ...(computedStart ? { startTime: computedStart } : {}),
        };
    });
};

export function useTaskEditDates({
    editedTask,
    pendingDueDate,
    pendingStartDate,
    setEditedTask,
    setPendingDueDate,
    setPendingStartDate,
    setShowDatePicker,
    showDatePicker,
    defaultScheduleTime = '',
    t,
}: UseTaskEditDatesParams) {
    const updateRecurrenceEndDate = React.useCallback((until: string) => {
        setEditedTask((prev) => {
            const recurrence = prev.recurrence;
            if (!recurrence) return prev;
            const rule = typeof recurrence === 'string' ? recurrence : recurrence.rule;
            if (!rule) return prev;
            const strategy = typeof recurrence === 'object' && recurrence.strategy === 'fluid' ? 'fluid' : 'strict';
            const parsed = typeof recurrence === 'object' && recurrence.rrule
                ? parseRRuleString(recurrence.rrule)
                : {};
            const byDay = typeof recurrence === 'object' && recurrence.byDay?.length
                ? recurrence.byDay
                : parsed.byDay;
            const byMonthDay = typeof recurrence === 'object' && recurrence.byMonthDay?.length
                ? recurrence.byMonthDay
                : parsed.byMonthDay;
            const completedOccurrences = typeof recurrence === 'object'
                ? recurrence.completedOccurrences
                : undefined;
            const rrule = buildRRuleString(rule, byDay, parsed.interval, {
                byMonthDay,
                until,
            });
            return {
                ...prev,
                recurrence: buildRecurrenceValue(rule, strategy, {
                    byDay,
                    byMonthDay,
                    until,
                    completedOccurrences,
                    rrule,
                }),
            };
        });
    }, [setEditedTask]);

    const applySelectedDate = React.useCallback((
        currentMode: TaskEditDatePickerMode,
        selectedDate: Date,
        closePicker: boolean
    ) => {
        if (currentMode === 'start') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.startTime && hasTimeComponent(editedTask.startTime)
                ? safeParseDate(editedTask.startTime)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingStartDate(combined);
                applyStartTimeUpdate(setEditedTask, combined.toISOString());
            } else if (defaultScheduleTime) {
                const combined = applyClockTime(selectedDate, defaultScheduleTime);
                setPendingStartDate(combined);
                applyStartTimeUpdate(setEditedTask, buildDateWithTimeValue(selectedDate, defaultScheduleTime));
            } else {
                setPendingStartDate(new Date(selectedDate));
                applyStartTimeUpdate(setEditedTask, dateOnly);
            }
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'start-time') {
            const base = pendingStartDate ?? safeParseDate(editedTask.startTime) ?? new Date();
            const combined = new Date(base);
            combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
            applyStartTimeUpdate(setEditedTask, combined.toISOString());
            setPendingStartDate(null);
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'review') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.reviewAt && hasTimeComponent(editedTask.reviewAt)
                ? safeParseDate(editedTask.reviewAt)
                : null;
            if (existing) {
                const existingTime = safeFormatDate(existing, 'HH:mm');
                setEditedTask((prev) => ({ ...prev, reviewAt: buildDateWithTimeValue(selectedDate, existingTime) }));
            } else if (defaultScheduleTime) {
                setEditedTask((prev) => ({ ...prev, reviewAt: buildDateWithTimeValue(selectedDate, defaultScheduleTime) }));
            } else {
                setEditedTask((prev) => ({ ...prev, reviewAt: dateOnly }));
            }
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'recurrence-end') {
            updateRecurrenceEndDate(safeFormatDate(selectedDate, 'yyyy-MM-dd'));
            if (closePicker) setShowDatePicker(null);
            return;
        }

        if (currentMode === 'due') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.dueDate && hasTimeComponent(editedTask.dueDate)
                ? safeParseDate(editedTask.dueDate)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingDueDate(combined);
                applyDueDateUpdate(setEditedTask, combined.toISOString());
            } else if (defaultScheduleTime) {
                const combined = applyClockTime(selectedDate, defaultScheduleTime);
                setPendingDueDate(combined);
                applyDueDateUpdate(setEditedTask, buildDateWithTimeValue(selectedDate, defaultScheduleTime));
            } else {
                setPendingDueDate(new Date(selectedDate));
                applyDueDateUpdate(setEditedTask, dateOnly);
            }
            if (closePicker) setShowDatePicker(null);
            return;
        }

        const base = pendingDueDate ?? safeParseDate(editedTask.dueDate) ?? new Date();
        const combined = new Date(base);
        combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
        applyDueDateUpdate(setEditedTask, combined.toISOString());
        setPendingDueDate(null);
        if (closePicker) setShowDatePicker(null);
    }, [
        editedTask.dueDate,
        editedTask.reviewAt,
        editedTask.startTime,
        defaultScheduleTime,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        updateRecurrenceEndDate,
    ]);

    const applyQuickDate = React.useCallback((
        mode: Extract<TaskEditDatePickerMode, 'start' | 'due' | 'review'>,
        selectedDate: Date | null
    ) => {
        if (!selectedDate) {
            if (mode === 'start') {
                setPendingStartDate(null);
                applyStartTimeUpdate(setEditedTask, undefined);
            } else if (mode === 'due') {
                setPendingDueDate(null);
                applyDueDateUpdate(setEditedTask, undefined);
            } else {
                setEditedTask((prev) => ({ ...prev, reviewAt: undefined }));
            }
            setShowDatePicker(null);
            return;
        }

        applySelectedDate(mode, selectedDate, true);
    }, [
        applySelectedDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
    ]);

    const onDateChange = React.useCallback((event: DateTimePickerEvent, selectedDate?: Date) => {
        const currentMode = showDatePicker;
        if (!currentMode) return;

        if (event.type === 'dismissed') {
            if (currentMode === 'start-time') setPendingStartDate(null);
            if (currentMode === 'due-time') setPendingDueDate(null);
            setShowDatePicker(null);
            return;
        }

        if (!selectedDate) return;
        applySelectedDate(currentMode, selectedDate, Platform.OS === 'android');
    }, [
        applySelectedDate,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
    ]);

    const formatDate = React.useCallback((dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        const hasTime = hasTimeComponent(dateStr);
        return safeFormatDate(parsed, hasTime ? 'P p' : 'P', t('common.notSet')) || t('common.notSet');
    }, [t]);

    const formatDueDate = React.useCallback((dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDueDate(dateStr);
        if (!parsed) return t('common.notSet');
        const hasTime = hasTimeComponent(dateStr);
        return safeFormatDate(parsed, hasTime ? 'P p' : 'P', t('common.notSet')) || t('common.notSet');
    }, [t]);

    const getSafePickerDateValue = React.useCallback((dateStr?: string) => {
        if (!dateStr) return new Date();
        const parsed = safeParseDate(dateStr);
        if (!parsed) return new Date();
        return parsed;
    }, []);

    return {
        applyQuickDate,
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    };
}
