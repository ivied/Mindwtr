import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
    applyMarkdownKeyboardShortcut,
    applyMarkdownPairInsertion,
    applyMarkdownToolbarAction,
    applyMarkdownUrlPaste,
    addCalendarMonths,
    buildRRuleString,
    continueMarkdownOnEnter,
    computeRelativeStartTime,
    formatCalendarInputDate,
    getCalendarDayOfMonth,
    getCalendarMonthIndex,
    getProjectedRecurringTaskCalendarDate,
    getRecurrenceCompletedOccurrencesValue,
    getTaskDateCoherenceIssues,
    hasTimeComponent,
    isJalaliCalendarLocale,
    isMarkdownEditorAssistEnabled,
    normalizeClockTimeInput,
    normalizeDateFormatSetting,
    parseCalendarInputDate,
    parseRRuleString,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
    resolveAutoTextDirection,
    safeFormatDate,
    safeParseDate,
    startOfCalendarMonth,
    tFallback,
    useTaskStore,
    type Attachment,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type RecurrenceByDay,
    type Recurrence,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
    type TaskEditorFieldId,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';
import { BaseDirectory, readFile, remove } from '@tauri-apps/plugin-fs';

import { useMarkdownReferenceAutocomplete } from '../MarkdownReferenceAutocomplete';
import { AttachmentsField } from './TaskForm/AttachmentsField';
import { ChecklistField } from './TaskForm/ChecklistField';
import { normalizeDateInputValue } from './task-item-helpers';
import { taskEditorLabelClassName } from './task-editor-label';
import { DescriptionField } from './fields/DescriptionField';
import { RecurrenceField } from './fields/RecurrenceField';
import {
    AssignedToField,
    ContextsField,
    EnergyLevelField,
    PriorityField,
    StatusField,
    TagsField,
    TimeEstimateField,
} from './fields/TaskMetadataFields';
import { QuickDateChips } from '../QuickDateChips';
import {
    captureScrollSnapshot,
    focusElementWithoutScroll,
    keepTextareaSelectionVisible,
    restoreScrollSnapshotSoon,
} from '../../lib/scroll-preservation';
import { loadAIKey } from '../../lib/ai-config';
import { logWarn } from '../../lib/app-log';
import { isTauriRuntime } from '../../lib/runtime';
import { processAudioCapture } from '../../lib/speech-to-text';
import { DEFAULT_PARAKEET_MODEL, DEFAULT_WHISPER_MODEL } from '../../lib/speech-models';

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_POPOVER_WIDTH = 288;
const DATE_POPOVER_APPROX_HEIGHT = 340;
const DATE_POPOVER_MARGIN = 8;

type DescriptionAudioState = 'idle' | 'recording' | 'transcribing';

type NativeAudioCaptureResult = {
    path: string;
    relativePath: string;
    sampleRate: number;
    channels: number;
    size: number;
};

const isRangeSelection = (selection: MarkdownSelection | null | undefined): selection is MarkdownSelection => (
    selection != null && selection.start !== selection.end
);

const getPairInsertionSelection = (
    currentValue: string,
    eventSelection: MarkdownSelection,
    pairSnapshot: { value: string; selection: MarkdownSelection } | null | undefined,
    fallbackSelection: MarkdownSelection | null | undefined,
): MarkdownSelection => {
    if (eventSelection.start !== eventSelection.end) {
        return eventSelection;
    }
    if (pairSnapshot?.value === currentValue && isRangeSelection(pairSnapshot.selection)) {
        return pairSnapshot.selection;
    }
    if (isRangeSelection(fallbackSelection)) {
        return fallbackSelection;
    }
    return eventSelection;
};

type DateInputOrder = 'dmy' | 'mdy' | 'ymd';

function parseDateInputDate(value: string): Date | null {
    if (!DATE_INPUT_PATTERN.test(value)) return safeParseDate(value);
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return null;
    const parsed = new Date(year, month - 1, day);
    if (
        parsed.getFullYear() !== year
        || parsed.getMonth() !== month - 1
        || parsed.getDate() !== day
    ) {
        return null;
    }
    return parsed;
}

function getCalendarLocale(locale: string): string | undefined {
    const normalized = locale.trim();
    if (!normalized) return undefined;
    return normalized.split('-u-')[0] || normalized;
}

function getWeekStartIndex(locale: string): number {
    const normalized = locale.toLowerCase();
    if (normalized.includes('fw-mon')) return 1;
    if (normalized.includes('fw-sat')) return 6;
    return 0;
}

function getCalendarGridDays(monthDate: Date, weekStartIndex: number, calendarSystem: string): Date[] {
    const firstOfMonth = startOfCalendarMonth(monthDate, calendarSystem);
    const offset = (firstOfMonth.getDay() - weekStartIndex + 7) % 7;
    const start = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, index) =>
        new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    );
}

function getWeekdayLabels(locale: string, weekStartIndex: number): string[] {
    const formatter = new Intl.DateTimeFormat(getCalendarLocale(locale), { weekday: 'short' });
    const sunday = new Date(2026, 0, 4);
    return Array.from({ length: 7 }, (_, index) => {
        const dayIndex = (weekStartIndex + index) % 7;
        const date = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + dayIndex);
        return formatter.format(date);
    });
}

function getDateInputOrder(dateFormatSetting: string | null | undefined, locale: string): DateInputOrder {
    const dateFormat = normalizeDateFormatSetting(dateFormatSetting);
    if (dateFormat === 'dmy') return 'dmy';
    if (dateFormat === 'mdy') return 'mdy';
    if (dateFormat === 'ymd') return 'ymd';

    const formatter = new Intl.DateTimeFormat(getCalendarLocale(locale), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const order = formatter
        .formatToParts(new Date(2026, 10, 22))
        .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
        .map((part) => part.type[0])
        .join('');
    if (order === 'dmy' || order === 'mdy' || order === 'ymd') return order;
    return 'mdy';
}

function getDateInputPlaceholder(order: DateInputOrder): string {
    if (order === 'dmy') return 'DD/MM/YYYY';
    if (order === 'mdy') return 'MM/DD/YYYY';
    return 'YYYY-MM-DD';
}

function formatDateInputDisplay(value: string, order: DateInputOrder, calendarSystem: string): string {
    if (!value) return '';
    if (calendarSystem === 'jalali') {
        return formatCalendarInputDate(value, calendarSystem);
    }
    const parsed = parseDateInputDate(value);
    if (!parsed) return value;

    const year = String(parsed.getFullYear()).padStart(4, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    if (order === 'dmy') return `${day}/${month}/${year}`;
    if (order === 'mdy') return `${month}/${day}/${year}`;
    return `${year}-${month}-${day}`;
}

function parseDateInputDisplay(value: string, order: DateInputOrder, calendarSystem: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return '';

    if (calendarSystem === 'jalali') {
        if (DATE_INPUT_PATTERN.test(trimmed)) {
            return parseCalendarInputDate(trimmed, calendarSystem);
        }
        const parts = trimmed.match(/\d{1,4}/g);
        if (!parts || parts.length !== 3 || parts[0].length !== 4) return null;
        const [year, month, day] = parts;
        return parseCalendarInputDate(
            `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
            calendarSystem
        );
    }

    if (DATE_INPUT_PATTERN.test(trimmed)) {
        const normalized = normalizeDateInputValue(trimmed);
        return parseDateInputDate(normalized) ? normalized : null;
    }

    const parts = trimmed.match(/\d{1,4}/g);
    if (!parts || parts.length !== 3) return null;

    let year: string;
    let month: string;
    let day: string;
    if (parts[0].length === 4) {
        [year, month, day] = parts;
    } else if (order === 'dmy') {
        [day, month, year] = parts;
    } else if (order === 'mdy') {
        [month, day, year] = parts;
    } else {
        [year, month, day] = parts;
    }

    if (year.length !== 4) return null;
    const normalized = normalizeDateInputValue(
        `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    );
    return parseDateInputDate(normalized) ? normalized : null;
}

type DateFieldProps = {
    t: (key: string) => string;
    label: string;
    dateAriaLabel: string;
    dateValue: string;
    selectedDate: Date | null;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    dateInputClassName: string;
    timeInput: ReactNode;
    onDateChange: (value: string) => void;
    onCalendarSelect?: (value: string) => void;
    onClear: () => void;
    onDateOnly?: () => void;
    hasValue: boolean;
};

export function DateField({
    t,
    label,
    dateAriaLabel,
    dateValue,
    selectedDate,
    dateFormatSetting,
    nativeDateInputLocale,
    dateInputClassName,
    timeInput,
    onDateChange,
    onCalendarSelect,
    onClear,
    onDateOnly,
    hasValue,
}: DateFieldProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const calendarRef = useRef<HTMLDivElement | null>(null);
    const [isCalendarOpen, setIsCalendarOpen] = useState(false);
    const [isFieldActive, setIsFieldActive] = useState(false);
    const [calendarPosition, setCalendarPosition] = useState({ top: 0, left: 0 });
    const calendarSystem = isJalaliCalendarLocale(nativeDateInputLocale) ? 'jalali' : 'gregorian';
    const [calendarMonth, setCalendarMonth] = useState(() =>
        startOfCalendarMonth(selectedDate ?? parseDateInputDate(dateValue) ?? new Date(), calendarSystem)
    );
    const clearText = tFallback(t, 'common.clear', 'Clear');
    const dateOnlyText = t('taskEdit.dateOnly');
    const dateInputOrder = calendarSystem === 'jalali'
        ? 'ymd'
        : getDateInputOrder(dateFormatSetting, nativeDateInputLocale);
    const [draftDateValue, setDraftDateValue] = useState(() => (
        formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem)
    ));
    const weekStartIndex = getWeekStartIndex(nativeDateInputLocale);
    const calendarLocale = getCalendarLocale(nativeDateInputLocale);
    const monthLabel = new Intl.DateTimeFormat(calendarLocale, { month: 'long', year: 'numeric' }).format(calendarMonth);
    const fullDateFormatter = new Intl.DateTimeFormat(calendarLocale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    const weekdayLabels = getWeekdayLabels(nativeDateInputLocale, weekStartIndex);
    const days = getCalendarGridDays(calendarMonth, weekStartIndex, calendarSystem);
    const todayValue = safeFormatDate(new Date(), 'yyyy-MM-dd');
    const showQuickDateChips = isFieldActive && !isCalendarOpen;

    const updateCalendarPosition = useCallback(() => {
        const anchor = inputRef.current?.parentElement ?? inputRef.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const maxLeft = Math.max(DATE_POPOVER_MARGIN, window.innerWidth - DATE_POPOVER_WIDTH - DATE_POPOVER_MARGIN);
        const left = Math.min(Math.max(rect.left, DATE_POPOVER_MARGIN), maxLeft);
        const wouldOverflowBottom = rect.bottom + DATE_POPOVER_APPROX_HEIGHT + DATE_POPOVER_MARGIN > window.innerHeight;
        const top = wouldOverflowBottom
            ? Math.max(DATE_POPOVER_MARGIN, rect.top - DATE_POPOVER_APPROX_HEIGHT - 4)
            : rect.bottom + 4;
        setCalendarPosition({ top, left });
    }, []);
    const openCalendar = useCallback(() => {
        setIsFieldActive(true);
        updateCalendarPosition();
        setIsCalendarOpen(true);
    }, [updateCalendarPosition]);

    const resetFieldState = useCallback(() => {
        setIsFieldActive(false);
        setIsCalendarOpen(false);
        setDraftDateValue(formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem));
    }, [calendarSystem, dateInputOrder, dateValue]);

    useEffect(() => {
        setDraftDateValue(formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem));
    }, [calendarSystem, dateInputOrder, dateValue]);

    useEffect(() => {
        if (!isCalendarOpen) return;
        const nextDate = selectedDate ?? parseDateInputDate(dateValue) ?? new Date();
        setCalendarMonth(startOfCalendarMonth(nextDate, calendarSystem));
    }, [calendarSystem, dateValue, isCalendarOpen, selectedDate]);

    useEffect(() => {
        if (!isCalendarOpen) return;
        updateCalendarPosition();

        const handlePointerDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
            const target = event.target;
            if (target instanceof Node && rootRef.current?.contains(target)) return;
            resetFieldState();
        };
        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsCalendarOpen(false);
            }
        };
        const handleViewportChange = () => updateCalendarPosition();

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('mousedown', handlePointerDown, true);
        document.addEventListener('touchstart', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('mousedown', handlePointerDown, true);
            document.removeEventListener('touchstart', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [isCalendarOpen, resetFieldState, updateCalendarPosition]);

    const handleDateInputChange = (value: string) => {
        setDraftDateValue(value);
        const parsed = parseDateInputDisplay(value, dateInputOrder, calendarSystem);
        if (parsed === null) return;
        if (!parsed) {
            onClear();
            return;
        }
        onDateChange(parsed);
    };
    const applyCalendarDate = (date: Date, closeAfterSelect: boolean) => {
        const nextDateValue = safeFormatDate(date, 'yyyy-MM-dd');
        setDraftDateValue(formatDateInputDisplay(nextDateValue, dateInputOrder, calendarSystem));
        onDateChange(nextDateValue);
        onCalendarSelect?.(nextDateValue);
        if (!closeAfterSelect) return;
        setIsCalendarOpen(false);
    };

    return (
        <div
            className="relative flex flex-col gap-1"
            ref={rootRef}
            onFocusCapture={() => setIsFieldActive(true)}
            onBlurCapture={() => {
                window.setTimeout(() => {
                    const activeElement = document.activeElement;
                    if (activeElement instanceof Node && rootRef.current?.contains(activeElement)) return;
                    resetFieldState();
                }, 0);
            }}
        >
            <label className={taskEditorLabelClassName}>{label}</label>
            <div className="flex w-full max-w-[min(22rem,100%)] items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <input
                        ref={inputRef}
                        type="text"
                        inputMode="numeric"
                        placeholder={getDateInputPlaceholder(dateInputOrder)}
                        lang={nativeDateInputLocale}
                        aria-label={dateAriaLabel}
                        aria-haspopup="dialog"
                        aria-expanded={isCalendarOpen}
                        value={draftDateValue}
                        onChange={(event) => handleDateInputChange(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                setIsCalendarOpen(false);
                                setIsFieldActive(false);
                                event.stopPropagation();
                            } else if (event.key === 'ArrowDown') {
                                openCalendar();
                                event.preventDefault();
                            }
                        }}
                        className={`${dateInputClassName} w-full pr-8`}
                    />
                    <button
                        type="button"
                        aria-label={`${label} calendar`}
                        aria-haspopup="dialog"
                        aria-expanded={isCalendarOpen}
                        onClick={openCalendar}
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
                {timeInput}
                {onDateOnly ? (
                    <button
                        type="button"
                        onClick={onDateOnly}
                        className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`${dateOnlyText}: ${label}`}
                    >
                        {dateOnlyText}
                    </button>
                ) : null}
                {hasValue ? (
                    <button
                        type="button"
                        onClick={() => {
                            setDraftDateValue('');
                            onClear();
                            setIsCalendarOpen(false);
                        }}
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`${clearText} ${label}`}
                    >
                        <X className="h-4 w-4" />
                    </button>
                ) : (
                    <span aria-hidden="true" className="h-7 w-7 shrink-0" />
                )}
            </div>
            {isCalendarOpen && (
                <div
                    ref={calendarRef}
                    role="dialog"
                    aria-label={`${label} calendar`}
                    className="fixed z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
                    style={{ top: calendarPosition.top, left: calendarPosition.left }}
                >
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <button
                            type="button"
                            aria-label="Previous month"
                            onClick={() => setCalendarMonth((current) => addCalendarMonths(current, -1, calendarSystem))}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <div className="min-w-0 flex-1 text-center text-sm font-medium text-foreground">
                            {monthLabel}
                        </div>
                        <button
                            type="button"
                            aria-label="Next month"
                            onClick={() => setCalendarMonth((current) => addCalendarMonths(current, 1, calendarSystem))}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
                        {weekdayLabels.map((weekday, index) => (
                            <div key={`${weekday}-${index}`} className="py-1">
                                {weekday}
                            </div>
                        ))}
                    </div>
                    <div className="mt-1 grid grid-cols-7 gap-1">
                        {days.map((day) => {
                            const value = safeFormatDate(day, 'yyyy-MM-dd');
                            const isSelected = value === dateValue;
                            const isToday = value === todayValue;
                            const isOutsideMonth = getCalendarMonthIndex(day, calendarSystem) !== getCalendarMonthIndex(calendarMonth, calendarSystem);
                            return (
                                <button
                                    key={value}
                                    type="button"
                                    aria-label={fullDateFormatter.format(day)}
                                    aria-pressed={isSelected}
                                    onPointerDown={(event) => {
                                        event.preventDefault();
                                        applyCalendarDate(day, true);
                                    }}
                                    onClick={() => applyCalendarDate(day, true)}
                                    onDoubleClick={() => applyCalendarDate(day, true)}
                                    className={[
                                        'h-8 rounded text-xs transition-colors',
                                        isSelected
                                            ? 'bg-primary text-primary-foreground'
                                            : isToday
                                                ? 'border border-primary/60 text-primary hover:bg-primary/10'
                                                : 'text-foreground hover:bg-muted',
                                        isOutsideMonth && !isSelected ? 'text-muted-foreground/50' : '',
                                    ].filter(Boolean).join(' ')}
                                >
                                    {getCalendarDayOfMonth(day, calendarSystem)}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            {showQuickDateChips && (
                <div className="w-full" onMouseDown={(event) => event.preventDefault()}>
                    <QuickDateChips
                        t={t}
                        selectedDate={selectedDate}
                        wrap
                        onSelect={(date) => {
                            if (!date) {
                                setDraftDateValue('');
                                onClear();
                                setIsCalendarOpen(false);
                                return;
                            }
                            const nextDateValue = safeFormatDate(date, 'yyyy-MM-dd');
                            setDraftDateValue(formatDateInputDisplay(nextDateValue, dateInputOrder, calendarSystem));
                            onDateChange(nextDateValue);
                        }}
                        className="w-full"
                    />
                </div>
            )}
        </div>
    );
}

export type MonthlyRecurrenceInfo = {
    pattern: 'date' | 'custom';
    interval: number;
};

export type TaskItemFieldRendererData = {
    t: (key: string) => string;
    task: Task;
    taskId: string;
    showDescriptionPreview: boolean;
    editDescription: string;
    attachmentError: string | null;
    visibleEditAttachments: Attachment[];
    editStartTime: string;
    editRelativeStartOffset: Task['relativeStartOffset'];
    editDueDate: string;
    editReviewAt: string;
    editRepeatReminderMinutes: number | undefined;
    editStatus: TaskStatus;
    editPriority: TaskPriority | '';
    editEnergyLevel: NonNullable<TaskEnergyLevel> | '';
    editAssignedTo: string;
    editRecurrence: RecurrenceRule | '';
    editRecurrenceStrategy: RecurrenceStrategy;
    editRecurrenceRRule: string;
    editShowFutureRecurrence: boolean;
    monthlyRecurrence: MonthlyRecurrenceInfo;
    editTimeEstimate: TimeEstimate | '';
    editContexts: string;
    editTags: string;
    editLocation: string;
    language: string;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    defaultScheduleTime: string;
    allContextOptions: string[];
    allTagOptions: string[];
    popularContextOptions: string[];
    popularTagOptions: string[];
    assignedToOptions: string[];
    showObsidianNoteAttachment: boolean;
};

export type TaskItemFieldRendererHandlers = {
    toggleDescriptionPreview: () => void;
    editDescriptionFromPreview: () => void;
    setEditDescription: (value: string) => void;
    addFileAttachment: () => void;
    addLinkAttachment: () => void;
    addObsidianNoteAttachment: () => void;
    editLinkAttachment: (attachment: Attachment) => void;
    openAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
    setEditStartTime: (value: string) => void;
    setEditRelativeStartOffset: (value: Task['relativeStartOffset']) => void;
    setEditDueDate: (value: string) => void;
    setEditReviewAt: (value: string) => void;
    setEditRepeatReminderMinutes: (value: number | undefined) => void;
    setEditStatus: (value: TaskStatus) => void;
    setEditPriority: (value: TaskPriority | '') => void;
    setEditEnergyLevel: (value: NonNullable<TaskEnergyLevel> | '') => void;
    setEditAssignedTo: (value: string) => void;
    createAssignedToPerson: (name: string) => void | Promise<void>;
    setEditRecurrence: (value: RecurrenceRule | '') => void;
    setEditRecurrenceStrategy: (value: RecurrenceStrategy) => void;
    setEditRecurrenceRRule: (value: string) => void;
    setEditShowFutureRecurrence: (value: boolean) => void;
    openCustomRecurrence: () => void;
    setEditTimeEstimate: (value: TimeEstimate | '') => void;
    setEditContexts: (value: string) => void;
    setEditTags: (value: string) => void;
    setEditLocation: (value: string) => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    resetTaskChecklist: (taskId: string) => void;
};

type TaskItemFieldRendererProps = {
    fieldId: TaskEditorFieldId;
    data: TaskItemFieldRendererData;
    handlers: TaskItemFieldRendererHandlers;
};

export function TaskItemFieldRenderer({
    fieldId,
    data,
    handlers,
}: TaskItemFieldRendererProps) {
    const {
        t,
        task,
        taskId,
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
        dateFormatSetting,
        nativeDateInputLocale,
        defaultScheduleTime,
        allContextOptions,
        allTagOptions,
        popularContextOptions,
        popularTagOptions,
        assignedToOptions,
        showObsidianNoteAttachment,
    } = data;

    const markdownEditorAssist = useTaskStore((state) => isMarkdownEditorAssistEnabled(state.settings));

    const [reviewTimeDraft, setReviewTimeDraft] = useState('');
    const [repeatReminderOptionsExpanded, setRepeatReminderOptionsExpanded] = useState(false);
    const [descriptionExpanded, setDescriptionExpanded] = useState(false);
    const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const lastDescriptionPairSelectionRef = useRef<{ value: string; selection: MarkdownSelection } | null>(null);
    const descriptionSelectionRef = useRef<MarkdownSelection>({
        start: editDescription.length,
        end: editDescription.length,
    });
    const descriptionUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [descriptionUndoDepth, setDescriptionUndoDepth] = useState(0);
    const [descriptionAudioState, setDescriptionAudioState] = useState<DescriptionAudioState>('idle');
    const [descriptionAudioError, setDescriptionAudioError] = useState<string | null>(null);
    const descriptionAudioStateRef = useRef<DescriptionAudioState>('idle');
    useEffect(() => {
        const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
        const hasTime = hasTimeComponent(editReviewAt);
        const next = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
        setReviewTimeDraft(next);
    }, [editReviewAt]);
    useEffect(() => {
        descriptionAudioStateRef.current = descriptionAudioState;
    }, [descriptionAudioState]);
    useEffect(() => () => {
        if (descriptionAudioStateRef.current !== 'recording' || !isTauriRuntime()) return;
        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke<NativeAudioCaptureResult>('stop_audio_recording'))
            .then((result) => {
                if (!result.relativePath) return;
                return remove(result.relativePath, { baseDir: BaseDirectory.Data });
            })
            .catch((error) => {
                void logWarn('Description audio cleanup failed', {
                    scope: 'audio',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
            });
    }, []);
    useEffect(() => {
        descriptionSelectionRef.current = {
            start: editDescription.length,
            end: editDescription.length,
        };
        lastDescriptionPairSelectionRef.current = null;
        descriptionUndoRef.current = [];
        setDescriptionUndoDepth(0);
        setDescriptionAudioError(null);
    }, [taskId]);
    const {
        toggleDescriptionPreview,
        editDescriptionFromPreview,
        setEditDescription,
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
    } = handlers;
    const parsedRecurrenceRRule = parseRRuleString(editRecurrenceRRule);
    const recurrenceEndMode: 'never' | 'until' | 'count' = parsedRecurrenceRRule.count
        ? 'count'
        : parsedRecurrenceRRule.until
            ? 'until'
            : 'never';
    const recurrenceDefaultEndDate = parsedRecurrenceRRule.until
        || safeFormatDate(
            safeParseDate(editDueDate || editStartTime || task.dueDate || task.startTime) ?? new Date(),
            'yyyy-MM-dd'
        );
    const buildRecurrenceRRule = (
        rule: RecurrenceRule,
        overrides: {
            byDay?: RecurrenceByDay[];
            interval?: number;
            byMonthDay?: number[];
            count?: number;
            until?: string;
        } = {}
    ) => {
        const hasOverride = <TKey extends keyof typeof overrides>(key: TKey) =>
            Object.prototype.hasOwnProperty.call(overrides, key);
        return buildRRuleString(
            rule,
            hasOverride('byDay') ? overrides.byDay : parsedRecurrenceRRule.byDay,
            hasOverride('interval') ? overrides.interval : parsedRecurrenceRRule.interval,
            {
                byMonthDay: hasOverride('byMonthDay') ? overrides.byMonthDay : parsedRecurrenceRRule.byMonthDay,
                count: hasOverride('count') ? overrides.count : parsedRecurrenceRRule.count,
                until: hasOverride('until') ? overrides.until : parsedRecurrenceRRule.until,
            }
        );
    };
    const recurrencePreviewValue: Recurrence | undefined = editRecurrence
        ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
        : undefined;
    if (recurrencePreviewValue && editRecurrenceRRule) {
        if (parsedRecurrenceRRule.byDay && parsedRecurrenceRRule.byDay.length > 0) {
            recurrencePreviewValue.byDay = parsedRecurrenceRRule.byDay;
        }
        if (parsedRecurrenceRRule.byMonthDay && parsedRecurrenceRRule.byMonthDay.length > 0) {
            recurrencePreviewValue.byMonthDay = parsedRecurrenceRRule.byMonthDay;
        }
        if (parsedRecurrenceRRule.count) {
            recurrencePreviewValue.count = parsedRecurrenceRRule.count;
        }
        if (parsedRecurrenceRRule.until) {
            recurrencePreviewValue.until = parsedRecurrenceRRule.until;
        }
        const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence);
        if (typeof completedOccurrences === 'number') {
            recurrencePreviewValue.completedOccurrences = completedOccurrences;
        }
        recurrencePreviewValue.rrule = editRecurrenceRRule;
    }
    const projectedRecurrenceDateLabel = recurrencePreviewValue
        ? safeFormatDate(getProjectedRecurringTaskCalendarDate({
            ...task,
            startTime: editStartTime || undefined,
            dueDate: editDueDate || undefined,
            recurrence: recurrencePreviewValue,
            showFutureRecurrence: true,
        }), 'PP')
        : '';

    const resolvedDirection = resolveAutoTextDirection([task.title, editDescription].filter(Boolean).join(' '), language);
    const isRtl = resolvedDirection === 'rtl';
    const pushDescriptionUndoEntry = (value: string, selection: MarkdownSelection) => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (
            previousEntry
            && previousEntry.value === value
            && previousEntry.selection.start === selection.start
            && previousEntry.selection.end === selection.end
        ) {
            return;
        }
        const nextUndoEntries = [...descriptionUndoRef.current, { value, selection }];
        descriptionUndoRef.current = nextUndoEntries.length > 100
            ? nextUndoEntries.slice(nextUndoEntries.length - 100)
            : nextUndoEntries;
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
    };
    const applyDescriptionValue = (
        value: string,
        options?: {
            nextSelection?: MarkdownSelection;
            recordUndo?: boolean;
            baseSelection?: MarkdownSelection;
        },
    ) => {
        if ((options?.recordUndo ?? true) && value !== editDescription) {
            pushDescriptionUndoEntry(editDescription, options?.baseSelection ?? descriptionSelectionRef.current);
        }
        setEditDescription(value);
        if (options?.nextSelection) {
            descriptionSelectionRef.current = options.nextSelection;
        } else {
            lastDescriptionPairSelectionRef.current = null;
        }
    };
    const restoreDescriptionTextareaSelection = (
        textarea: HTMLTextAreaElement,
        selection: MarkdownSelection,
    ) => {
        requestAnimationFrame(() => {
            const target = textarea.isConnected ? textarea : descriptionTextareaRef.current;
            if (!target) return;
            const scrollSnapshot = captureScrollSnapshot(target);
            const surroundingScrollSnapshot = scrollSnapshot.filter(
                (snapshot) => snapshot.kind === 'window' || snapshot.target !== target,
            );
            focusElementWithoutScroll(target, scrollSnapshot);
            target.setSelectionRange(selection.start, selection.end);
            keepTextareaSelectionVisible(target);
            restoreScrollSnapshotSoon(surroundingScrollSnapshot);
        });
    };
    const handleDescriptionUndo = () => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (!previousEntry) return undefined;
        descriptionUndoRef.current = descriptionUndoRef.current.slice(0, -1);
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
        applyDescriptionValue(previousEntry.value, {
            nextSelection: previousEntry.selection,
            recordUndo: false,
        });
        return previousEntry.selection;
    };
    const handleDescriptionApplyAction = (actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
        const next = applyMarkdownToolbarAction(editDescription, selection, actionId);
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        return next;
    };
    const descriptionAutocomplete = useMarkdownReferenceAutocomplete({
        currentTaskId: taskId,
        value: editDescription,
        selection: descriptionSelectionRef.current,
        textareaRef: descriptionTextareaRef,
        onApplyResult: (next) => {
            lastDescriptionPairSelectionRef.current = null;
            applyDescriptionValue(next.value, {
                baseSelection: descriptionSelectionRef.current,
                nextSelection: next.selection,
            });
            descriptionSelectionRef.current = next.selection;
        },
    });
    const handleDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (descriptionAutocomplete.handleKeyDown(event)) {
            return;
        }
        const eventTextarea = event.currentTarget;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const applyDescriptionKeyboardResult = (
            next: MarkdownToolbarResult,
            baseSelection = selection,
            rememberPairRange = false,
        ) => {
            applyDescriptionValue(next.value, {
                baseSelection,
                nextSelection: next.selection,
            });
            descriptionSelectionRef.current = next.selection;
            lastDescriptionPairSelectionRef.current = rememberPairRange && isRangeSelection(next.selection)
                ? { value: next.value, selection: next.selection }
                : null;
            restoreDescriptionTextareaSelection(eventTextarea, next.selection);
        };
        const lowerKey = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
            if (lowerKey === 'b' || lowerKey === 'i') {
                const next = applyMarkdownKeyboardShortcut(currentValue, selection, {
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                });
                if (!next) return;
                event.preventDefault();
                applyDescriptionKeyboardResult(next);
                return;
            }
            if (lowerKey !== 'z') return;
            if (descriptionUndoRef.current.length === 0) return;
            event.preventDefault();
            const restoredSelection = handleDescriptionUndo();
            if (restoredSelection) {
                restoreDescriptionTextareaSelection(eventTextarea, restoredSelection);
            }
            return;
        }

        const isPairInsertionKey = !event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1;
        if (!isPairInsertionKey && event.key !== 'Tab') {
            lastDescriptionPairSelectionRef.current = null;
        }
        if (event.key === 'Tab' || isPairInsertionKey) {
            const pairSelection = isPairInsertionKey
                ? getPairInsertionSelection(currentValue, selection, lastDescriptionPairSelectionRef.current, descriptionSelectionRef.current)
                : selection;
            const next = event.key === 'Tab'
                ? applyMarkdownKeyboardShortcut(currentValue, selection, {
                    key: event.key,
                    shiftKey: event.shiftKey,
                })
                : applyMarkdownPairInsertion(
                    currentValue,
                    `${currentValue.slice(0, pairSelection.start)}${event.key}${currentValue.slice(pairSelection.end)}`,
                    pairSelection,
                    { assist: markdownEditorAssist },
                );
            if (!next) return;
            event.preventDefault();
            applyDescriptionKeyboardResult(next, pairSelection, isPairInsertionKey);
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        const next = continueMarkdownOnEnter(currentValue, selection, { assist: markdownEditorAssist });
        if (!next) return;

        event.preventDefault();
        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionKeyboardResult(next);
    };
    const handleDescriptionPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const pastedText = event.clipboardData.getData('text/plain');
        if (!pastedText) return;
        const eventTextarea = event.currentTarget;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const next = applyMarkdownUrlPaste(
            currentValue,
            `${currentValue.slice(0, selection.start)}${pastedText}${currentValue.slice(selection.end)}`,
            selection,
            { assist: markdownEditorAssist },
        );
        if (!next) return;
        event.preventDefault();
        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        descriptionSelectionRef.current = next.selection;
        restoreDescriptionTextareaSelection(eventTextarea, next.selection);
    };
    const handleDescriptionInput = (
        value: string,
        selection: MarkdownSelection,
        source: HTMLTextAreaElement,
    ) => {
        const previousSelection = descriptionSelectionRef.current;
        const pairedInsertion = applyMarkdownPairInsertion(editDescription, value, previousSelection, { assist: markdownEditorAssist });
        if (pairedInsertion) {
            applyDescriptionValue(pairedInsertion.value, {
                baseSelection: previousSelection,
                nextSelection: pairedInsertion.selection,
            });
            descriptionSelectionRef.current = pairedInsertion.selection;
            lastDescriptionPairSelectionRef.current = isRangeSelection(pairedInsertion.selection)
                ? { value: pairedInsertion.value, selection: pairedInsertion.selection }
                : null;
            restoreDescriptionTextareaSelection(source, pairedInsertion.selection);
            return;
        }

        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(value);
        descriptionSelectionRef.current = selection;
    };
    const insertDescriptionTranscript = useCallback((transcript: string) => {
        const trimmedTranscript = transcript.trim();
        if (!trimmedTranscript) return;

        const currentValue = editDescription;
        const rawSelection = descriptionSelectionRef.current;
        const start = Math.max(0, Math.min(rawSelection.start, currentValue.length));
        const end = Math.max(start, Math.min(rawSelection.end, currentValue.length));
        const before = currentValue.slice(0, start);
        const after = currentValue.slice(end);
        const prefix = before.length > 0 && !/\s$/.test(before) ? '\n' : '';
        const suffix = after.length > 0 && !/^\s/.test(after) ? '\n' : '';
        const insertion = `${prefix}${trimmedTranscript}${suffix}`;
        const nextValue = `${before}${insertion}${after}`;
        const nextCursor = before.length + insertion.length;
        const nextSelection = { start: nextCursor, end: nextCursor };

        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(nextValue, {
            baseSelection: rawSelection,
            nextSelection,
        });
        descriptionSelectionRef.current = nextSelection;

        const textarea = descriptionTextareaRef.current;
        if (textarea) restoreDescriptionTextareaSelection(textarea, nextSelection);
    }, [editDescription]);
    const handleDescriptionAudioInput = useCallback(async () => {
        if (descriptionAudioState === 'transcribing') return;
        if (!isTauriRuntime()) {
            setDescriptionAudioError(tFallback(t, 'attachments.fileNotSupported', 'File not supported.'));
            return;
        }

        const { invoke } = await import('@tauri-apps/api/core');

        if (descriptionAudioState !== 'recording') {
            setDescriptionAudioError(null);
            try {
                await invoke('start_audio_recording');
                setDescriptionAudioState('recording');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setDescriptionAudioError(message || tFallback(t, 'quickAdd.audioErrorBody', 'Could not start audio recording.'));
            }
            return;
        }

        let capture: NativeAudioCaptureResult | null = null;
        setDescriptionAudioError(null);
        try {
            capture = await invoke<NativeAudioCaptureResult>('stop_audio_recording');
            setDescriptionAudioState('transcribing');

            const currentSettings = useTaskStore.getState().settings;
            const speech = currentSettings.ai?.speechToText;
            if (!speech?.enabled) {
                throw new Error(tFallback(t, 'attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const provider = speech.provider ?? 'gemini';
            const model = speech.model ?? (
                provider === 'openai' ? 'gpt-4o-transcribe'
                    : provider === 'gemini' ? 'gemini-2.5-flash'
                        : provider === 'parakeet' ? DEFAULT_PARAKEET_MODEL
                            : DEFAULT_WHISPER_MODEL
            );
            const apiSpeechProvider = provider === 'openai' || provider === 'gemini' ? provider : null;
            const apiKey = apiSpeechProvider ? await loadAIKey(apiSpeechProvider).catch(() => '') : '';
            const modelPath = apiSpeechProvider ? undefined : speech.offlineModelPath;
            const speechReady = apiSpeechProvider ? Boolean(apiKey) : Boolean(modelPath);
            if (!speechReady) {
                throw new Error(tFallback(t, 'attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const bytes = await readFile(capture.relativePath, { baseDir: BaseDirectory.Data });
            const audioBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : undefined;
            const result = await processAudioCapture(
                {
                    bytes: audioBytes,
                    mimeType: 'audio/wav',
                    name: 'description-audio.wav',
                    path: capture.path,
                },
                {
                    provider,
                    apiKey,
                    model,
                    modelPath,
                    language: speech.language,
                    mode: 'transcribe_only',
                    fieldStrategy: 'description_only',
                    parseModel: provider === 'openai' && currentSettings.ai?.provider === 'openai' ? currentSettings.ai?.model : undefined,
                    now: new Date(),
                    timeZone,
                },
            );
            const transcript = (result.description || result.transcript || '').trim();
            if (!transcript) {
                throw new Error(tFallback(t, 'attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
            }
            insertDescriptionTranscript(transcript);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setDescriptionAudioError(message || tFallback(t, 'attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
        } finally {
            if (capture?.relativePath) {
                remove(capture.relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                    void logWarn('Description audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
            }
            setDescriptionAudioState('idle');
        }
    }, [descriptionAudioState, insertDescriptionTranscript, t]);
    const handleEditDescriptionFromPreview = (source?: HTMLElement) => {
        const scrollSnapshot = captureScrollSnapshot(source);
        editDescriptionFromPreview();
        restoreScrollSnapshotSoon(scrollSnapshot);
        requestAnimationFrame(() => {
            const textarea = descriptionTextareaRef.current;
            if (!textarea) return;
            focusElementWithoutScroll(textarea, scrollSnapshot);
            restoreScrollSnapshotSoon(scrollSnapshot);
        });
    };
    const dateInputClassName = 'min-w-0 flex-1 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const timeInputClassName = 'w-24 shrink-0 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const dateIssueLabel = getTaskDateCoherenceIssues({
        startTime: editStartTime || undefined,
        dueDate: editDueDate || undefined,
    }).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : '';
    const renderDateField = ({
        label,
        dateAriaLabel,
        dateValue,
        selectedDate,
        onDateChange,
        timeInput,
        onClear,
        onDateOnly,
        hasValue,
        warning,
    }: {
        label: string;
        dateAriaLabel: string;
        dateValue: string;
        selectedDate: Date | null;
        onDateChange: (value: string) => void;
        timeInput: ReactNode;
        onClear: () => void;
        onDateOnly?: () => void;
        hasValue: boolean;
        warning?: string;
    }) => (
        <div className="space-y-1">
            <DateField
                t={t}
                label={label}
                dateAriaLabel={dateAriaLabel}
                dateValue={dateValue}
                selectedDate={selectedDate}
                dateFormatSetting={dateFormatSetting}
                nativeDateInputLocale={nativeDateInputLocale}
                dateInputClassName={dateInputClassName}
                timeInput={timeInput}
                onDateChange={onDateChange}
                onClear={onClear}
                onDateOnly={onDateOnly}
                hasValue={hasValue}
            />
            {warning && (
                <p className="text-xs text-amber-500 dark:text-amber-300" role="note">
                    {warning}
                </p>
            )}
        </div>
    );

    switch (fieldId) {
        case 'description':
            return (
                <DescriptionField
                    t={t}
                    taskTitle={task.title}
                    taskId={taskId}
                    showDescriptionPreview={showDescriptionPreview}
                    editDescription={editDescription}
                    isRtl={isRtl}
                    resolvedDirection={resolvedDirection}
                    descriptionExpanded={descriptionExpanded}
                    descriptionUndoDepth={descriptionUndoDepth}
                    descriptionTextareaRef={descriptionTextareaRef}
                    descriptionSelection={descriptionSelectionRef.current}
                    descriptionAutocomplete={descriptionAutocomplete}
                    descriptionAudioState={descriptionAudioState}
                    descriptionAudioError={descriptionAudioError}
                    onTogglePreview={toggleDescriptionPreview}
                    onEditFromPreview={handleEditDescriptionFromPreview}
                    onExpand={() => setDescriptionExpanded(true)}
                    onCloseExpanded={() => setDescriptionExpanded(false)}
                    onDescriptionInput={handleDescriptionInput}
                    onDescriptionChange={applyDescriptionValue}
                    onSelectionChange={(selection) => {
                        descriptionSelectionRef.current = selection;
                        if (isRangeSelection(selection)) {
                            lastDescriptionPairSelectionRef.current = null;
                        }
                    }}
                    onUndo={handleDescriptionUndo}
                    onApplyAction={handleDescriptionApplyAction}
                    onKeyDown={handleDescriptionKeyDown}
                    onPaste={handleDescriptionPaste}
                    onDescriptionAudioInput={handleDescriptionAudioInput}
                />
            );
        case 'attachments':
            return (
                <AttachmentsField
                    t={t}
                    attachmentError={attachmentError}
                    visibleEditAttachments={visibleEditAttachments}
                    addFileAttachment={addFileAttachment}
                    addLinkAttachment={addLinkAttachment}
                    addObsidianNoteAttachment={addObsidianNoteAttachment}
                    showObsidianNoteAttachment={showObsidianNoteAttachment}
                    editLinkAttachment={editLinkAttachment}
                    openAttachment={openAttachment}
                    removeAttachment={removeAttachment}
                />
            );
        case 'startTime':
            {
                const hasTime = hasTimeComponent(editStartTime);
                const parsed = editStartTime ? safeParseDate(editStartTime) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    setEditRelativeStartOffset(undefined);
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        setEditStartTime('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditStartTime(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        setEditStartTime(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    setEditStartTime(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    setEditRelativeStartOffset(undefined);
                    if (!value) {
                        if (dateValue) setEditStartTime(dateValue);
                        else setEditStartTime('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    setEditStartTime(`${datePart}T${value}`);
                };
                const dueDateHasTime = hasTimeComponent(editDueDate);
                const relativeUnit = editRelativeStartOffset?.unit ?? 'day';
                const relativeUnitForDueDate = !dueDateHasTime && (relativeUnit === 'minute' || relativeUnit === 'hour')
                    ? 'day'
                    : relativeUnit;
                const relativeAmount = editRelativeStartOffset ? Math.abs(editRelativeStartOffset.amount) : 3;
                const relativeUnitOptions: Array<{ value: NonNullable<Task['relativeStartOffset']>['unit']; label: string }> = dueDateHasTime
                    ? [
                        { value: 'minute', label: t('taskEdit.relativeStartMinutes') },
                        { value: 'hour', label: t('taskEdit.relativeStartHours') },
                        { value: 'day', label: t('taskEdit.relativeStartDays') },
                        { value: 'week', label: t('taskEdit.relativeStartWeeks') },
                    ]
                    : [
                        { value: 'day', label: t('taskEdit.relativeStartDays') },
                        { value: 'week', label: t('taskEdit.relativeStartWeeks') },
                    ];
                const applyRelativeStartOffset = (amountValue: number, unitValue: NonNullable<Task['relativeStartOffset']>['unit']) => {
                    if (!editDueDate || !Number.isFinite(amountValue)) return;
                    const offset = { amount: -Math.max(1, Math.floor(amountValue)), unit: unitValue };
                    const computedStart = computeRelativeStartTime(editDueDate, offset);
                    if (!computedStart) {
                        setEditRelativeStartOffset(undefined);
                        return;
                    }
                    setEditRelativeStartOffset(offset);
                    setEditStartTime(computedStart);
                };
                return (
                    <>
                        {renderDateField({
                            label: t('taskEdit.startDateLabel'),
                            dateAriaLabel: t('task.aria.startDate'),
                            dateValue,
                            selectedDate: parsed,
                            onDateChange: handleDateChange,
                            timeInput: (
                                <input
                                    type="time"
                                    lang={nativeDateInputLocale}
                                    aria-label={t('task.aria.startTime')}
                                    value={timeValue}
                                    onChange={(event) => handleTimeChange(event.target.value)}
                                    className={timeInputClassName}
                                />
                            ),
                            onClear: () => {
                                setEditRelativeStartOffset(undefined);
                                setEditStartTime('');
                            },
                            onDateOnly: hasTime ? () => handleTimeChange('') : undefined,
                            hasValue: Boolean(editStartTime),
                            warning: dateIssueLabel,
                        })}
                        {editDueDate && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" aria-label={t('taskEdit.startModeLabel')}>
                                    <button
                                        type="button"
                                        aria-pressed={!editRelativeStartOffset}
                                        onClick={() => setEditRelativeStartOffset(undefined)}
                                        className={`rounded px-2 py-1 ${!editRelativeStartOffset ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        {t('taskEdit.startModeAbsolute')}
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={Boolean(editRelativeStartOffset)}
                                        onClick={() => applyRelativeStartOffset(relativeAmount, relativeUnitForDueDate)}
                                        className={`rounded px-2 py-1 ${editRelativeStartOffset ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        {t('taskEdit.startModeRelative')}
                                    </button>
                                </div>
                                {editRelativeStartOffset && (
                                    <>
                                        <input
                                            type="number"
                                            min={1}
                                            max={10000}
                                            value={relativeAmount}
                                            onChange={(event) => applyRelativeStartOffset(Number(event.target.value), relativeUnitForDueDate)}
                                            className="h-8 w-16 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                                            aria-label={t('taskEdit.relativeStartAmount')}
                                        />
                                        <select
                                            value={relativeUnitForDueDate}
                                            onChange={(event) => applyRelativeStartOffset(relativeAmount, event.target.value as NonNullable<Task['relativeStartOffset']>['unit'])}
                                            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                                            aria-label={t('taskEdit.relativeStartUnit')}
                                        >
                                            {relativeUnitOptions.map((option) => (
                                                <option key={option.value} value={option.value}>{option.label}</option>
                                            ))}
                                        </select>
                                    </>
                                )}
                            </div>
                        )}
                    </>
                );
            }
        case 'dueDate':
            {
                const hasTime = hasTimeComponent(editDueDate);
                const parsed = editDueDate ? safeParseDate(editDueDate) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const updateDueDate = (nextDueDate: string) => {
                    setEditDueDate(nextDueDate);
                    if (!editRelativeStartOffset) return;
                    if (!nextDueDate) {
                        setEditRelativeStartOffset(undefined);
                        return;
                    }
                    const computedStart = computeRelativeStartTime(nextDueDate, editRelativeStartOffset);
                    if (computedStart) {
                        setEditStartTime(computedStart);
                    } else {
                        setEditRelativeStartOffset(undefined);
                    }
                };
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        updateDueDate('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        updateDueDate(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        updateDueDate(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    updateDueDate(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    if (!value) {
                        if (dateValue) updateDueDate(dateValue);
                        else updateDueDate('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    updateDueDate(`${datePart}T${value}`);
                };
                return (
                    <>
                        {renderDateField({
                            label: t('taskEdit.dueDateLabel'),
                            dateAriaLabel: t('task.aria.dueDate'),
                            dateValue,
                            selectedDate: parsed,
                            onDateChange: handleDateChange,
                            timeInput: (
                                <input
                                    type="time"
                                    lang={nativeDateInputLocale}
                                    aria-label={t('task.aria.dueTime')}
                                    value={timeValue}
                                    onChange={(event) => handleTimeChange(event.target.value)}
                                    className={timeInputClassName}
                                />
                            ),
                            onClear: () => updateDueDate(''),
                            onDateOnly: hasTime ? () => handleTimeChange('') : undefined,
                            hasValue: Boolean(editDueDate),
                            warning: dateIssueLabel,
                        })}
                        {hasTime && !task.suppressMindwtrReminders && (() => {
                            const label = tFallback(t, 'taskEdit.repeatReminderLabel', 'Repeat reminder');
                            const current = editRepeatReminderMinutes ?? 0;
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
                                <div className="mt-1 space-y-1.5">
                                    <button
                                        type="button"
                                        aria-label={`${label}: ${formatValue(current)}`}
                                        aria-expanded={repeatReminderOptionsExpanded}
                                        className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${repeatReminderOptionsExpanded || current > 0
                                            ? 'border-primary/60 bg-primary/10'
                                            : 'border-border bg-muted/30 hover:bg-muted/50'
                                            }`}
                                        onClick={() => setRepeatReminderOptionsExpanded((expanded) => !expanded)}
                                    >
                                        <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
                                        <span className={current > 0 ? 'shrink-0 text-primary' : 'shrink-0 text-muted-foreground'}>
                                            {formatValue(current)}
                                        </span>
                                    </button>
                                    {repeatReminderOptionsExpanded && (
                                        <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
                                            {[0, ...REPEAT_REMINDER_INTERVAL_OPTIONS].map((minutes) => {
                                                const active = current === minutes;
                                                return (
                                                    <button
                                                        key={minutes}
                                                        type="button"
                                                        aria-pressed={active}
                                                        className={`rounded border px-2 py-1 text-xs transition-colors ${active
                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                            : 'border-border bg-muted/40 text-foreground hover:bg-muted'
                                                            }`}
                                                        onClick={() => {
                                                            setEditRepeatReminderMinutes(minutes > 0 ? minutes : undefined);
                                                            setRepeatReminderOptionsExpanded(false);
                                                        }}
                                                    >
                                                        {formatOption(minutes)}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })()}
                    </>
                );
            }
        case 'reviewAt':
            {
                const hasTime = hasTimeComponent(editReviewAt);
                const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        setEditReviewAt('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditReviewAt(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        setEditReviewAt(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    setEditReviewAt(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    if (!value) {
                        if (dateValue) setEditReviewAt(dateValue);
                        else setEditReviewAt('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    setEditReviewAt(`${datePart}T${value}`);
                };
                return renderDateField({
                    label: t('taskEdit.reviewDateLabel'),
                    dateAriaLabel: t('task.aria.reviewDate'),
                    dateValue,
                    selectedDate: parsed,
                    onDateChange: handleDateChange,
                    timeInput: (
                        <input
                            type="text"
                            aria-label={t('task.aria.reviewTime')}
                            value={reviewTimeDraft}
                            inputMode="numeric"
                            placeholder="HH:MM"
                            onChange={(event) => setReviewTimeDraft(event.target.value)}
                            onBlur={() => {
                                const normalized = normalizeClockTimeInput(reviewTimeDraft);
                                if (normalized === null) {
                                    setReviewTimeDraft(timeValue);
                                    return;
                                }
                                setReviewTimeDraft(normalized);
                                handleTimeChange(normalized);
                            }}
                            className={timeInputClassName}
                        />
                    ),
                    onClear: () => setEditReviewAt(''),
                    onDateOnly: hasTime
                        ? () => {
                            setReviewTimeDraft('');
                            handleTimeChange('');
                        }
                        : undefined,
                    hasValue: Boolean(editReviewAt),
                });
            }
        case 'status':
            return <StatusField t={t} value={editStatus} onChange={setEditStatus} />;
        case 'priority':
            return <PriorityField t={t} value={editPriority} onChange={setEditPriority} />;
        case 'energyLevel':
            return <EnergyLevelField t={t} value={editEnergyLevel} onChange={setEditEnergyLevel} />;
        case 'assignedTo':
            return <AssignedToField t={t} value={editAssignedTo} options={assignedToOptions} onChange={setEditAssignedTo} onCreatePerson={createAssignedToPerson} />;
        case 'recurrence':
            return (
                <RecurrenceField
                    t={t}
                    editRecurrence={editRecurrence}
                    editRecurrenceStrategy={editRecurrenceStrategy}
                    editRecurrenceRRule={editRecurrenceRRule}
                    editShowFutureRecurrence={editShowFutureRecurrence}
                    monthlyRecurrence={monthlyRecurrence}
                    parsedRecurrenceRRule={parsedRecurrenceRRule}
                    recurrenceEndMode={recurrenceEndMode}
                    recurrenceDefaultEndDate={recurrenceDefaultEndDate}
                    projectedRecurrenceDateLabel={projectedRecurrenceDateLabel}
                    onRecurrenceChange={setEditRecurrence}
                    onRecurrenceStrategyChange={setEditRecurrenceStrategy}
                    onRecurrenceRRuleChange={setEditRecurrenceRRule}
                    onShowFutureRecurrenceChange={setEditShowFutureRecurrence}
                    openCustomRecurrence={openCustomRecurrence}
                    buildRecurrenceRRule={buildRecurrenceRRule}
                />
            );
        case 'timeEstimate':
            return <TimeEstimateField t={t} value={editTimeEstimate} onChange={setEditTimeEstimate} />;
        case 'contexts':
            return (
                <ContextsField
                    t={t}
                    value={editContexts}
                    options={popularContextOptions}
                    suggestions={allContextOptions}
                    onChange={setEditContexts}
                />
            );
        case 'tags':
            return (
                <TagsField
                    t={t}
                    value={editTags}
                    options={popularTagOptions}
                    suggestions={allTagOptions}
                    onChange={setEditTags}
                />
            );
        case 'location':
            return (
                <div className="flex flex-col gap-1">
                    <label className={taskEditorLabelClassName}>{t('taskEdit.locationLabel')}</label>
                    <input
                        type="text"
                        aria-label={t('task.aria.location')}
                        value={editLocation}
                        onChange={(event) => setEditLocation(event.target.value)}
                        placeholder={t('taskEdit.locationPlaceholder')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground"
                    />
                </div>
            );
        case 'checklist':
            return (
                <ChecklistField
                    t={t}
                    taskId={taskId}
                    checklist={task.checklist}
                    description={editDescription}
                    onDescriptionSync={setEditDescription}
                    updateTask={updateTask}
                    resetTaskChecklist={resetTaskChecklist}
                />
            );
        default:
            return null;
    }
}
