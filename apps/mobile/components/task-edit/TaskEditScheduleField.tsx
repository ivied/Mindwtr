import React from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    buildRRuleString,
    computeRelativeStartTime,
    getProjectedRecurringTaskCalendarDate,
    getTaskDateCoherenceIssues,
    getRecurrenceUntilValue,
    hasTimeComponent,
    parseRRuleString,
    RECURRENCE_INTERVAL_MAX,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type RecurrenceByDay,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
} from '@mindwtr/core';

import { QuickDateChips } from '../QuickDateChips';
import { CompactText } from '@/components/compact-text';
import { buildRecurrenceValue } from './recurrence-utils';
import type {
    ShowDatePickerMode,
    TaskEditFieldRendererProps,
} from './TaskEditFieldRenderer.types';

type ScheduleFieldId = 'recurrence' | 'startTime' | 'dueDate' | 'reviewAt';

type TaskEditScheduleFieldProps = TaskEditFieldRendererProps & {
    fieldId: ScheduleFieldId;
};

const normalizeRecurrenceIntervalInput = (value: number): number => (
    Number.isFinite(value) && value > 0
        ? Math.min(Math.round(value), RECURRENCE_INTERVAL_MAX)
        : 1
);

const isSubDayRelativeStartUnit = (unit: NonNullable<Task['relativeStartOffset']>['unit']): boolean => (
    unit === 'minute' || unit === 'hour'
);

const normalizeRelativeStartUnitForDueDate = (
    dueDate: string | undefined,
    unit: NonNullable<Task['relativeStartOffset']>['unit'],
): NonNullable<Task['relativeStartOffset']>['unit'] => (
    dueDate && !hasTimeComponent(dueDate) && isSubDayRelativeStartUnit(unit) ? 'day' : unit
);

export function TaskEditScheduleField({
    applyQuickDate,
    customWeekdays,
    dailyInterval,
    editedTask,
    fieldId,
    formatDate,
    formatDueDate,
    getSafePickerDateValue,
    monthlyPattern,
    onDateChange,
    openCustomRecurrence,
    pendingDueDate,
    pendingStartDate,
    recurrenceOptions,
    recurrenceRRuleValue,
    recurrenceRuleValue,
    recurrenceStrategyValue,
    recurrenceWeekdayButtons,
    setCustomWeekdays,
    setEditedTask,
    setShowDatePicker,
    showDatePicker,
    styles,
    t,
    tc,
    task,
}: TaskEditScheduleFieldProps) {
    const [repeatReminderOptionsExpanded, setRepeatReminderOptionsExpanded] = React.useState(false);
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const parsedRecurrenceRRule = parseRRuleString(recurrenceRRuleValue);
    const monthlyInterval = recurrenceRuleValue === 'monthly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
        ? parsedRecurrenceRRule.interval
        : 1;
    const recurrenceEndMode: 'never' | 'until' | 'count' = parsedRecurrenceRRule.count
        ? 'count'
        : parsedRecurrenceRRule.until
            ? 'until'
            : 'never';
    const recurrenceDefaultEndDate = parsedRecurrenceRRule.until
        || safeFormatDate(
            safeParseDate(editedTask.dueDate ?? editedTask.startTime ?? task?.dueDate ?? task?.startTime) ?? new Date(),
            'yyyy-MM-dd'
        );
    const buildEditedRecurrence = (
        rule: RecurrenceRule,
        overrides: {
            strategy?: RecurrenceStrategy;
            byDay?: RecurrenceByDay[];
            interval?: number;
            byMonthDay?: number[];
            count?: number;
            until?: string;
            rrule?: string;
        } = {}
    ) => {
        const hasOverride = <TKey extends keyof typeof overrides>(key: TKey) =>
            Object.prototype.hasOwnProperty.call(overrides, key);
        const completedOccurrences = editedTask.recurrence && typeof editedTask.recurrence === 'object'
            ? editedTask.recurrence.completedOccurrences
            : undefined;
        const byDay = hasOverride('byDay')
            ? overrides.byDay
            : (editedTask.recurrence && typeof editedTask.recurrence === 'object' && editedTask.recurrence.byDay?.length
                ? editedTask.recurrence.byDay
                : parsedRecurrenceRRule.byDay);
        const interval = hasOverride('interval') ? overrides.interval : parsedRecurrenceRRule.interval;
        const byMonthDay = hasOverride('byMonthDay') ? overrides.byMonthDay : parsedRecurrenceRRule.byMonthDay;
        const count = hasOverride('count') ? overrides.count : parsedRecurrenceRRule.count;
        const until = hasOverride('until') ? overrides.until : parsedRecurrenceRRule.until;
        const rrule = hasOverride('rrule')
            ? overrides.rrule
            : buildRRuleString(rule, byDay, interval, { byMonthDay, count, until });
        return buildRecurrenceValue(rule, hasOverride('strategy') ? overrides.strategy ?? recurrenceStrategyValue : recurrenceStrategyValue, {
            byDay,
            byMonthDay,
            count,
            until,
            completedOccurrences,
            rrule,
        });
    };
    const openDatePicker = (mode: NonNullable<ShowDatePickerMode>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<ShowDatePickerMode>) => {
        if (mode === 'start') return getSafePickerDateValue(editedTask.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
        if (mode === 'review') return getSafePickerDateValue(editedTask.reviewAt);
        if (mode === 'recurrence-end') {
            return getSafePickerDateValue(getRecurrenceUntilValue(editedTask.recurrence) || recurrenceDefaultEndDate);
        }
        if (mode === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
        return getSafePickerDateValue(editedTask.dueDate);
    };
    const getDatePickerMode = (mode: NonNullable<ShowDatePickerMode>) =>
        mode === 'start-time' || mode === 'due-time' ? 'time' : 'date';
    const renderInlineIOSDatePicker = (targetModes: NonNullable<ShowDatePickerMode>[]) => {
        if (Platform.OS !== 'ios' || !showDatePicker || !targetModes.includes(showDatePicker)) {
            return null;
        }
        return (
            <View style={{ marginTop: 8 }}>
                <View style={styles.pickerToolbar}>
                    <View style={styles.pickerSpacer} />
                    <Pressable onPress={() => setShowDatePicker(null)} style={styles.pickerDone}>
                        <Text style={styles.pickerDoneText}>{t('common.done')}</Text>
                    </Pressable>
                </View>
                <DateTimePicker
                    key={showDatePicker}
                    value={getDatePickerValue(showDatePicker)}
                    mode={getDatePickerMode(showDatePicker)}
                    display="spinner"
                    textColor={tc.text}
                    onChange={onDateChange}
                />
            </View>
        );
    };
    const renderQuickDateChips = (
        mode: 'start' | 'due' | 'review',
        selectedDate: Date | null
    ) => {
        if (mode === 'due' && showDatePicker !== 'due') return null;
        return (
            <QuickDateChips
                t={t}
                tc={tc}
                selectedDate={selectedDate}
                onSelect={(date) => applyQuickDate(mode, date)}
            />
        );
    };
    const formatStartDateTime = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        return safeFormatDate(
            parsed,
            hasTimeComponent(dateStr) ? 'P p' : 'P',
            t('common.notSet')
        ) || t('common.notSet');
    };
    const dateOnlyLabel = t('taskEdit.dateOnly');
    const dateIssueLabel = getTaskDateCoherenceIssues({
        startTime: editedTask.startTime,
        dueDate: editedTask.dueDate,
    }).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : '';
    const renderDateIssue = () => (
        dateIssueLabel ? (
            <Text style={[styles.dateIssueText, { color: tc.warning }]}>
                {dateIssueLabel}
            </Text>
        ) : null
    );
    const clearTimePart = (value?: string): string | undefined => {
        const parsed = safeParseDate(value);
        return parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : undefined;
    };
    const projectedRecurrenceDateLabel = (() => {
        const recurrence = editedTask.recurrence ?? task?.recurrence;
        if (!recurrenceRuleValue || !recurrence) return '';
        const nowIso = new Date().toISOString();
        const previewTask = {
            ...(task ?? {}),
            ...editedTask,
            id: editedTask.id ?? task?.id ?? 'draft-recurrence-preview',
            title: String(editedTask.title ?? task?.title ?? ''),
            status: editedTask.status ?? task?.status ?? 'next',
            tags: editedTask.tags ?? task?.tags ?? [],
            contexts: editedTask.contexts ?? task?.contexts ?? [],
            createdAt: editedTask.createdAt ?? task?.createdAt ?? nowIso,
            updatedAt: editedTask.updatedAt ?? task?.updatedAt ?? nowIso,
            recurrence,
            showFutureRecurrence: true,
        } as Task;
        return safeFormatDate(getProjectedRecurringTaskCalendarDate(previewTask, nowIso), 'PP');
    })();
    const projectedRecurrenceDateHint = projectedRecurrenceDateLabel
        ? `${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${projectedRecurrenceDateLabel}.`
        : '';
    const hasReminderHandoffSchedule = hasTimeComponent(editedTask.startTime) || hasTimeComponent(editedTask.dueDate);
    const renderReminderHandoffControl = () => {
        if (fieldId !== 'dueDate' || !hasReminderHandoffSchedule) return null;
        const enabled = editedTask.suppressMindwtrReminders === true;
        return (
            <TouchableOpacity
                accessibilityRole="switch"
                accessibilityState={{ checked: enabled }}
                style={[
                    styles.dateBtn,
                    {
                        marginTop: 8,
                        backgroundColor: enabled ? tc.filterBg : tc.cardBg,
                        borderColor: enabled ? tc.tint : tc.border,
                    },
                ]}
                onPress={() => setEditedTask((prev) => ({
                    ...prev,
                    suppressMindwtrReminders: prev.suppressMindwtrReminders ? undefined : true,
                }))}
            >
                <Text style={[styles.modalLabel, { color: tc.text }]}>
                    {tFallback(t, 'taskEdit.suppressMindwtrReminders', 'Use calendar reminder')}
                </Text>
                <Text style={{ marginTop: 4, color: tc.secondaryText, fontSize: 12, lineHeight: 16 }}>
                    {tFallback(t, 'taskEdit.suppressMindwtrRemindersHint', 'Skip Mindwtr start/due reminders for this task when your device calendar already reminds you.')}
                </Text>
            </TouchableOpacity>
        );
    };
    const renderRepeatReminderControl = () => {
        if (fieldId !== 'dueDate' || !hasTimeComponent(editedTask.dueDate)) return null;
        if (editedTask.suppressMindwtrReminders === true) return null;
        const label = tFallback(t, 'taskEdit.repeatReminderLabel', 'Repeat reminder');
        const current = editedTask.repeatReminderMinutes ?? 0;
        const options = [0, ...REPEAT_REMINDER_INTERVAL_OPTIONS];
        const formatValue = (minutes: number) => (
            minutes === 0
                ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                : tFallback(t, 'taskEdit.repeatReminderEveryMinutes', 'Every {count} min').replace('{count}', String(minutes))
        );
        const formatOption = (minutes: number) => (
            minutes === 0
                ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                : tFallback(t, 'taskEdit.repeatReminderMinutesShort', '{count} min').replace('{count}', String(minutes))
        );
        return (
            <View style={{ marginTop: 8 }}>
                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${label}: ${formatValue(current)}`}
                    style={[
                        styles.dateBtn,
                        {
                            backgroundColor: current > 0 ? tc.filterBg : tc.cardBg,
                            borderColor: repeatReminderOptionsExpanded || current > 0 ? tc.tint : tc.border,
                        },
                    ]}
                    onPress={() => setRepeatReminderOptionsExpanded((expanded) => !expanded)}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={[styles.modalLabel, { color: tc.text, flexShrink: 1 }]} numberOfLines={1}>{label}</Text>
                        <Text style={{ color: current > 0 ? tc.tint : tc.secondaryText, fontSize: 13, flexShrink: 0 }} numberOfLines={1}>
                            {formatValue(current)}
                        </Text>
                    </View>
                </TouchableOpacity>
                {repeatReminderOptionsExpanded && (
                    <View style={[styles.statusContainer, { marginTop: 8 }]}>
                        {options.map((minutes) => (
                            <TouchableOpacity
                                key={minutes}
                                accessibilityRole="button"
                                accessibilityLabel={formatOption(minutes)}
                                style={getStatusChipStyle(current === minutes)}
                                onPress={() => {
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        repeatReminderMinutes: minutes > 0 ? minutes : undefined,
                                    }));
                                    setRepeatReminderOptionsExpanded(false);
                                }}
                            >
                                <Text style={getStatusTextStyle(current === minutes)}>
                                    {formatOption(minutes)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
        );
    };

    const applyRelativeStartOffset = (amountValue: number, unitValue: NonNullable<Task['relativeStartOffset']>['unit']) => {
        if (!editedTask.dueDate || !Number.isFinite(amountValue)) return;
        const unit = normalizeRelativeStartUnitForDueDate(editedTask.dueDate, unitValue);
        const offset = { amount: -Math.max(1, Math.floor(amountValue)), unit };
        const computedStart = computeRelativeStartTime(editedTask.dueDate, offset);
        if (!computedStart) {
            setEditedTask((prev) => ({ ...prev, relativeStartOffset: undefined }));
            return;
        }
        setEditedTask((prev) => ({
            ...prev,
            relativeStartOffset: offset,
            startTime: computedStart,
        }));
    };

    const updateDueDate = (dueDate: string | undefined) => {
        setEditedTask((prev) => {
            if (!dueDate) return { ...prev, dueDate: undefined, relativeStartOffset: undefined };
            const computedStart = computeRelativeStartTime(dueDate, prev.relativeStartOffset);
            return {
                ...prev,
                dueDate,
                ...(computedStart ? { startTime: computedStart } : {}),
                ...(prev.relativeStartOffset && !computedStart ? { relativeStartOffset: undefined } : {}),
            };
        });
    };

    switch (fieldId) {
        case 'recurrence':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.recurrenceLabel')}</Text>
                    <View style={styles.statusContainer}>
                        {recurrenceOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={getStatusChipStyle(
                                    recurrenceRuleValue === option.value || (!option.value && !recurrenceRuleValue)
                                )}
                                onPress={() => {
                                    if (option.value !== 'weekly') {
                                        setCustomWeekdays([]);
                                    }
                                    if (!option.value) {
                                        setEditedTask((prev) => ({ ...prev, recurrence: undefined }));
                                        return;
                                    }
                                    if (option.value === 'daily') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('daily', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: parsedRecurrenceRRule.rule === 'daily' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                    ? parsedRecurrenceRRule.interval
                                                    : 1,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'monthly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: parsedRecurrenceRRule.rule === 'monthly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                    ? parsedRecurrenceRRule.interval
                                                    : 1,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'weekly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('weekly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: undefined,
                                            }),
                                        }));
                                        return;
                                    }
                                    if (option.value === 'yearly') {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('yearly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                                interval: parsedRecurrenceRRule.rule === 'yearly' && parsedRecurrenceRRule.interval && parsedRecurrenceRRule.interval > 0
                                                    ? parsedRecurrenceRRule.interval
                                                    : 1,
                                            }),
                                        }));
                                        return;
                                    }
                                }}
                            >
                                <Text style={getStatusTextStyle(
                                    recurrenceRuleValue === option.value || (!option.value && !recurrenceRuleValue)
                                )}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {recurrenceRuleValue === 'weekly' && (
                        <>
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <TextInput
                                    value={String(Math.max(parsedRecurrenceRRule.interval ?? 1, 1))}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = normalizeRecurrenceIntervalInput(parsed);
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('weekly', {
                                                ...(customWeekdays.length > 0 ? { byDay: customWeekdays } : {}),
                                                byMonthDay: undefined,
                                                interval,
                                            }),
                                        }));
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.weekUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.weekUnit')}</Text>
                            </View>
                            <View style={[styles.weekdayRow, { marginTop: 10 }]}>
                                {recurrenceWeekdayButtons.map((day) => {
                                    const active = customWeekdays.includes(day.key);
                                    return (
                                        <TouchableOpacity
                                            key={day.key}
                                            style={[
                                                styles.weekdayButton,
                                                {
                                                    borderColor: active ? tc.tint : tc.border,
                                                    backgroundColor: active ? tc.tint : tc.cardBg,
                                                },
                                            ]}
                                            onPress={() => {
                                                const next = active
                                                    ? customWeekdays.filter((value) => value !== day.key)
                                                    : [...customWeekdays, day.key];
                                                setCustomWeekdays(next);
                                                setEditedTask((prev) => ({
                                                    ...prev,
                                                    recurrence: buildEditedRecurrence('weekly', {
                                                        byDay: next,
                                                        byMonthDay: undefined,
                                                    }),
                                                }));
                                            }}
                                        >
                                            <Text style={[styles.weekdayButtonText, { color: active ? tc.onTint : tc.text }]}>{day.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </>
                    )}
                    {recurrenceRuleValue === 'daily' && (
                        <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                            <TextInput
                                value={String(dailyInterval)}
                                onChangeText={(value) => {
                                    const parsed = Number.parseInt(value, 10);
                                    const interval = normalizeRecurrenceIntervalInput(parsed);
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        recurrence: buildEditedRecurrence('daily', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval,
                                        }),
                                    }));
                                }}
                                keyboardType="number-pad"
                                style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                accessibilityLabel={t('recurrence.repeatEvery')}
                                accessibilityHint={t('recurrence.dayUnit')}
                            />
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.dayUnit')}</Text>
                        </View>
                    )}
                    {recurrenceRuleValue === 'monthly' && (
                        <>
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <TextInput
                                    value={String(monthlyInterval)}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = normalizeRecurrenceIntervalInput(parsed);
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', { interval }),
                                        }));
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.monthUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.monthUnit')}</Text>
                            </View>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'date')}
                                    onPress={() => {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence('monthly', {
                                                byDay: undefined,
                                                byMonthDay: undefined,
                                            }),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'date')}>
                                        {t('recurrence.monthlyOnDay')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'custom')}
                                    onPress={openCustomRecurrence}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'custom')}>
                                        {t('recurrence.custom')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </>
                    )}
                    {recurrenceRuleValue === 'yearly' && (
                        <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                            <TextInput
                                value={String(Math.max(parsedRecurrenceRRule.interval ?? 1, 1))}
                                onChangeText={(value) => {
                                    const parsed = Number.parseInt(value, 10);
                                    const interval = normalizeRecurrenceIntervalInput(parsed);
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        recurrence: buildEditedRecurrence('yearly', {
                                            byDay: undefined,
                                            byMonthDay: undefined,
                                            interval,
                                        }),
                                    }));
                                }}
                                keyboardType="number-pad"
                                style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                accessibilityLabel={t('recurrence.repeatEvery')}
                                accessibilityHint={t('recurrence.yearUnit')}
                            />
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.yearUnit')}</Text>
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <View style={{ marginTop: 8 }}>
                            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.endsLabel')}</Text>
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'never')}
                                    onPress={() => {
                                        setShowDatePicker(null);
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: undefined,
                                                until: undefined,
                                            }),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'never')}>
                                        {t('recurrence.endsNever')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'until')}
                                    onPress={() => {
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: undefined,
                                                until: parsedRecurrenceRRule.until || recurrenceDefaultEndDate,
                                            }),
                                        }));
                                        openDatePicker('recurrence-end');
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'until')}>
                                        {t('recurrence.endsOnDate')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceEndMode === 'count')}
                                    onPress={() => {
                                        setShowDatePicker(null);
                                        setEditedTask((prev) => ({
                                            ...prev,
                                            recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                count: parsedRecurrenceRRule.count ?? 1,
                                                until: undefined,
                                            }),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceEndMode === 'count')}>
                                        {t('recurrence.endsAfterCount')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                            {recurrenceEndMode === 'until' && (
                                <View style={{ marginTop: 8 }}>
                                    <TouchableOpacity
                                        style={[styles.dateBtn, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                        onPress={() => openDatePicker('recurrence-end')}
                                    >
                                        <Text style={{ color: tc.text }}>
                                            {formatDate(parsedRecurrenceRRule.until || recurrenceDefaultEndDate)}
                                        </Text>
                                    </TouchableOpacity>
                                    {renderInlineIOSDatePicker(['recurrence-end'])}
                                </View>
                            )}
                            {recurrenceEndMode === 'count' && (
                                <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                    <TextInput
                                        value={String(Math.max(parsedRecurrenceRRule.count ?? 1, 1))}
                                        onChangeText={(value) => {
                                            const parsed = Number.parseInt(value, 10);
                                            const count = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 999) : 1;
                                            setEditedTask((prev) => ({
                                                ...prev,
                                                recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                                    count,
                                                    until: undefined,
                                                }),
                                            }));
                                        }}
                                        keyboardType="number-pad"
                                        style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                        accessibilityLabel={t('recurrence.endsAfterCount')}
                                        accessibilityHint={t('recurrence.occurrenceUnit')}
                                    />
                                    <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.occurrenceUnit')}</Text>
                                </View>
                            )}
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <View style={[styles.statusContainer, { marginTop: 8 }]}>
                            <TouchableOpacity
                                style={getStatusChipStyle(recurrenceStrategyValue === 'fluid')}
                                onPress={() => {
                                    const nextStrategy = recurrenceStrategyValue === 'fluid' ? 'strict' : 'fluid';
                                    setEditedTask((prev) => ({
                                        ...prev,
                                        recurrence: buildEditedRecurrence(recurrenceRuleValue, {
                                            strategy: nextStrategy,
                                            byDay: recurrenceRuleValue === 'weekly' && customWeekdays.length > 0
                                                ? customWeekdays
                                                : undefined,
                                        }),
                                    }));
                                }}
                            >
                                <Text style={getStatusTextStyle(recurrenceStrategyValue === 'fluid')}>
                                    {t('recurrence.afterCompletion')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    {!!recurrenceRuleValue && (
                        <TouchableOpacity
                            accessibilityRole="switch"
                            accessibilityState={{ checked: editedTask.showFutureRecurrence === true }}
                            style={[
                                styles.dateBtn,
                                {
                                    marginTop: 8,
                                    backgroundColor: editedTask.showFutureRecurrence ? tc.filterBg : tc.cardBg,
                                    borderColor: editedTask.showFutureRecurrence ? tc.tint : tc.border,
                                },
                            ]}
                            onPress={() => setEditedTask((prev) => ({
                                ...prev,
                                showFutureRecurrence: prev.showFutureRecurrence ? undefined : true,
                            }))}
                        >
                            <Text style={[styles.modalLabel, { color: tc.text }]}>
                                {tFallback(t, 'recurrence.showFutureInCalendar', 'Show next occurrence in Calendar')}
                            </Text>
                            <Text style={{ marginTop: 4, color: tc.secondaryText, fontSize: 12, lineHeight: 16 }}>
                                {tFallback(t, 'recurrence.showFutureInCalendarHint', 'Planning-only preview; the next task is still created when this one is completed.')}
                                {projectedRecurrenceDateHint ? ` ${projectedRecurrenceDateHint}` : ''}
                            </Text>
                        </TouchableOpacity>
                    )}
                </View>
            );
        case 'startTime': {
            const parsed = editedTask.startTime ? safeParseDate(editedTask.startTime) : null;
            const hasTime = hasTimeComponent(editedTask.startTime);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('start')}
                            >
                                <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.startTime)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.startTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => openDatePicker('start-time')}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                        {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                            {!!editedTask.startTime && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, startTime: clearTimePart(prev.startTime), relativeStartOffset: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!editedTask.startTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, startTime: undefined, relativeStartOffset: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('start', parsed)}
                        {renderDateIssue()}
                        {!!editedTask.dueDate && (() => {
                            const dueDateHasTime = hasTimeComponent(editedTask.dueDate);
                            const relativeUnit = normalizeRelativeStartUnitForDueDate(
                                editedTask.dueDate,
                                editedTask.relativeStartOffset?.unit ?? 'day'
                            );
                            const relativeAmount = editedTask.relativeStartOffset ? Math.abs(editedTask.relativeStartOffset.amount) : 3;
                            const modeOptions = [
                                { label: t('taskEdit.startModeAbsolute'), active: !editedTask.relativeStartOffset, onPress: () => setEditedTask((prev) => ({ ...prev, relativeStartOffset: undefined })) },
                                { label: t('taskEdit.startModeRelative'), active: Boolean(editedTask.relativeStartOffset), onPress: () => applyRelativeStartOffset(relativeAmount, relativeUnit) },
                            ];
                            const unitOptions: Array<{ value: NonNullable<Task['relativeStartOffset']>['unit']; label: string }> = dueDateHasTime
                                ? [
                                    { value: 'minute', label: t('taskEdit.relativeStartMinutesShort') },
                                    { value: 'hour', label: t('taskEdit.relativeStartHoursShort') },
                                    { value: 'day', label: t('taskEdit.relativeStartDaysShort') },
                                    { value: 'week', label: t('taskEdit.relativeStartWeeksShort') },
                                ]
                                : [
                                    { value: 'day', label: t('taskEdit.relativeStartDaysShort') },
                                    { value: 'week', label: t('taskEdit.relativeStartWeeksShort') },
                                ];
                            return (
                                <View style={{ marginTop: 10, gap: 8 }}>
                                    <View style={{ flexDirection: 'row', gap: 8 }}>
                                        {modeOptions.map((option) => (
                                            <TouchableOpacity
                                                key={option.label}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected: option.active }}
                                                style={[
                                                    styles.statusChip,
                                                    { backgroundColor: option.active ? tc.tint : tc.filterBg, borderColor: option.active ? tc.tint : tc.border },
                                                ]}
                                                onPress={option.onPress}
                                            >
                                                <Text style={[styles.statusText, { color: option.active ? '#fff' : tc.secondaryText }]}>{option.label}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                    {!!editedTask.relativeStartOffset && (
                                        <View style={{ gap: 8 }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                <TextInput
                                                    value={String(relativeAmount)}
                                                    keyboardType="number-pad"
                                                    onChangeText={(text) => applyRelativeStartOffset(Number(text), relativeUnit)}
                                                    style={[styles.input, { width: 74, color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                                    accessibilityLabel={t('taskEdit.relativeStartAmount')}
                                                />
                                                <Text style={{ color: tc.secondaryText }}>
                                                    {t('taskEdit.relativeStartBeforeDue')}
                                                </Text>
                                            </View>
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                                {unitOptions.map((option) => {
                                                    const active = relativeUnit === option.value;
                                                    return (
                                                        <TouchableOpacity
                                                            key={option.value}
                                                            accessibilityRole="button"
                                                            accessibilityState={{ selected: active }}
                                                            style={[
                                                                styles.statusChip,
                                                                { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
                                                            ]}
                                                            onPress={() => applyRelativeStartOffset(relativeAmount, option.value)}
                                                        >
                                                            <Text style={[styles.statusText, { color: active ? '#fff' : tc.secondaryText }]}>{option.label}</Text>
                                                        </TouchableOpacity>
                                                    );
                                                })}
                                            </View>
                                        </View>
                                    )}
                                </View>
                            );
                        })()}
                        {renderInlineIOSDatePicker(['start', 'start-time'])}
                    </View>
                </View>
            );
        }
        case 'dueDate': {
            const parsed = editedTask.dueDate ? safeParseDate(editedTask.dueDate) : null;
            const hasTime = hasTimeComponent(editedTask.dueDate);
            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
            if (!editedTask.dueDate) {
                const notSetLabel = t('common.notSet');
                return (
                    <View style={styles.formGroup}>
                        <TouchableOpacity
                            style={[styles.compactFieldRow, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                            onPress={() => openDatePicker('due')}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('taskEdit.dueDateLabel')}: ${notSetLabel}`}
                        >
                            <CompactText
                                style={[styles.compactFieldLabel, { color: tc.secondaryText }]}
                            >
                                {t('taskEdit.dueDateLabel')}
                            </CompactText>
                            <CompactText
                                style={[styles.compactFieldValue, { color: tc.tint }]}
                                numberOfLines={2}
                            >
                                {notSetLabel}
                            </CompactText>
                        </TouchableOpacity>
                        {renderQuickDateChips('due', parsed)}
                        {renderInlineIOSDatePicker(['due'])}
                        {renderReminderHandoffControl()}
                        {renderRepeatReminderControl()}
                    </View>
                );
            }
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('due')}
                            >
                                <Text style={{ color: tc.text }}>{formatDueDate(editedTask.dueDate)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.dueDate && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => openDatePicker('due-time')}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                        {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                            {!!editedTask.dueDate && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => updateDueDate(clearTimePart(editedTask.dueDate))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!editedTask.dueDate && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => updateDueDate(undefined)}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('due', parsed)}
                        {renderDateIssue()}
                        {renderInlineIOSDatePicker(['due', 'due-time'])}
                        {renderReminderHandoffControl()}
                        {renderRepeatReminderControl()}
                    </View>
                </View>
            );
        }
        case 'reviewAt': {
            const parsed = editedTask.reviewAt ? safeParseDate(editedTask.reviewAt) : null;
            const hasTime = hasTimeComponent(editedTask.reviewAt);
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                    <View>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => openDatePicker('review')}
                            >
                                <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.reviewAt)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.reviewAt && hasTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, reviewAt: clearTimePart(prev.reviewAt) }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{dateOnlyLabel}</Text>
                                </TouchableOpacity>
                            )}
                            {!!editedTask.reviewAt && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask((prev) => ({ ...prev, reviewAt: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                        {renderQuickDateChips('review', parsed)}
                        {renderInlineIOSDatePicker(['review'])}
                    </View>
                </View>
            );
        }
        default:
            return null;
    }
}
