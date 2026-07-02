import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { isSameDay, isToday } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import {
    getCalendarDayOfMonth,
    getCalendarMonthIndex,
    getTaskCalendarOccurrenceDate,
    hasTimeComponent,
    isProjectedRecurringTask,
    isSameCalendarMonth,
    safeFormatDate,
    type Task,
} from '@mindwtr/core';

import { ErrorBoundary } from '../ErrorBoundary';
import { cn } from '../../lib/utils';
import {
    getCalendarTaskDragItemKind,
    getCalendarTaskDragTaskId,
    hasCalendarTaskDragData,
    setCalendarTaskDragData,
} from '../../lib/calendar-task-drag';
import { CalendarOpenTaskModal, CalendarTaskComposerModal } from './calendar/CalendarModals';
import { CalendarPlanningPanel } from './calendar/CalendarPlanningPanel';
import { CalendarSelectedDayPanel } from './calendar/CalendarSelectedDayPanel';
import {
    DESKTOP_DAY_END_HOUR,
    DESKTOP_DAY_START_HOUR,
    DESKTOP_GRID_SNAP_MINUTES,
    DESKTOP_HOUR_HEIGHT,
    type CalendarViewMode,
    type CalendarCellItem,
    dayKey,
    useDesktopCalendarController,
} from './calendar/useDesktopCalendarController';

const PROJECTED_RECURRENCE_LABEL_DATE_FORMAT = 'MMM d';
const CALENDAR_PLANNING_PANEL_COLLAPSED_KEY = 'mindwtr.calendar.planningPanelCollapsed';

const readPlanningPanelCollapsedPreference = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(CALENDAR_PLANNING_PANEL_COLLAPSED_KEY) === 'true';
    } catch {
        return false;
    }
};

function getProjectedRecurrenceDisplayLabel(task: Task, projectedLabel: string): string {
    const occurrenceDateLabel = safeFormatDate(
        getTaskCalendarOccurrenceDate(task),
        PROJECTED_RECURRENCE_LABEL_DATE_FORMAT
    );
    return occurrenceDateLabel ? `${projectedLabel} · ${occurrenceDateLabel}` : projectedLabel;
}

export function CalendarView() {
    const timelineScrollRef = useRef<HTMLDivElement | null>(null);
    const [isPlanningPanelCollapsed, setIsPlanningPanelCollapsed] = useState(readPlanningPanelCollapsedPreference);
    const controller = useDesktopCalendarController();
    const {
        calendarBodyRef,
        calendarSystem,
        createTaskFromExternalEvent,
        currentMonth,
        currentMonthLabel,
        currentYear,
        days,
        externalCalendars,
        externalError,
        externalCalendarColor,
        getAllDayItemsForDay,
        getCalendarItemsForDate,
        handleMonthChange,
        handleNextMonth,
        handlePrevMonth,
        handleToday,
        handleViewModeChange,
        handleYearChange,
        hiddenExternalCalendarIds,
        isMonthPickerOpen,
        layoutTimedItems,
        locale,
        monthNames,
        openDayViewForDate,
        openQuickAddForStart,
        openTaskFromCalendar,
        resolveText,
        scheduleDays,
        selectCalendarDate,
        selectedDate,
        setIsMonthPickerOpen,
        setViewFilterQuery,
        timelineDays,
        t,
        toggleExternalCalendar,
        updateTaskDateFromDrop,
        updateTaskStartTimeFromDrop,
        viewFilterQuery,
        viewMode,
        visibleSearchMatchCount,
        weekdayHeaders,
        yearOptions,
    } = controller;
    const handleCalendarTaskDragStart = useCallback((event: DragEvent<HTMLElement>, task: Task, itemKind: CalendarCellItem['kind']) => {
        if (itemKind === 'event') return;
        if (isProjectedRecurringTask(task)) return;
        event.stopPropagation();
        setCalendarTaskDragData(event.dataTransfer, task.id, {
            itemKind,
            variant: 'calendar-block',
        });
    }, []);
    const handleCalendarTaskDragOver = useCallback((event: DragEvent<HTMLElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);
    const handleDropOnDueDate = useCallback((event: DragEvent<HTMLElement>, date: Date) => {
        const taskId = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!taskId) return;
        const itemKind = getCalendarTaskDragItemKind(event.dataTransfer);
        event.preventDefault();
        event.stopPropagation();
        void updateTaskDateFromDrop(taskId, date, itemKind);
    }, [updateTaskDateFromDrop]);
    const handleOpenDayKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, date: Date) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDayViewForDate(date);
    }, [openDayViewForDate]);
    const handleDropOnTimelineSlot = useCallback((event: DragEvent<HTMLElement>, date: Date) => {
        const taskId = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!taskId) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const rawMinutes = ((event.clientY - rect.top) / DESKTOP_HOUR_HEIGHT) * 60;
        const snapped = Math.round(rawMinutes / DESKTOP_GRID_SNAP_MINUTES) * DESKTOP_GRID_SNAP_MINUTES;
        const maxMinutes = (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60 - DESKTOP_GRID_SNAP_MINUTES;
        const clamped = Math.max(0, Math.min(maxMinutes, snapped));
        const start = new Date(date);
        start.setHours(DESKTOP_DAY_START_HOUR, clamped, 0, 0);

        event.preventDefault();
        event.stopPropagation();
        void updateTaskStartTimeFromDrop(taskId, start);
    }, [updateTaskStartTimeFromDrop]);
    const timelineScrollKey = viewMode === 'day' || viewMode === 'week'
        ? `${viewMode}:${timelineDays.map(dayKey).join('|')}`
        : '';
    const handlePlanningPanelCollapsedChange = useCallback((collapsed: boolean) => {
        setIsPlanningPanelCollapsed(collapsed);
        try {
            window.localStorage.setItem(CALENDAR_PLANNING_PANEL_COLLAPSED_KEY, collapsed ? 'true' : 'false');
        } catch {
            // Ignore storage failures; the in-memory state still updates.
        }
    }, []);

    useEffect(() => {
        if (!timelineScrollKey) return;
        const now = new Date();
        const minutes = (now.getHours() - DESKTOP_DAY_START_HOUR) * 60 + now.getMinutes();
        const clampedMinutes = Math.max(0, Math.min((DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60, minutes));
        const scrollTop = Math.max(0, (clampedMinutes / 60) * DESKTOP_HOUR_HEIGHT - 220);
        const frame = window.requestAnimationFrame(() => {
            timelineScrollRef.current?.scrollTo({ top: scrollTop });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [timelineScrollKey]);

    return (
        <ErrorBoundary>
            <div className="space-y-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-3xl font-bold tracking-tight">{t('nav.calendar')}</h2>
                    <p className="text-sm text-muted-foreground">
                        {resolveText('calendar.tasksAndEvents', 'Tasks and external events by date')}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={handleToday}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
                        {resolveText('calendar.today', 'Today')}
                    </button>
                    <div className="inline-flex rounded-md border border-border bg-card p-1">
                        {([
                            ['day', resolveText('calendar.day', 'Day')],
                            ['week', resolveText('calendar.week', 'Week')],
                            ['month', resolveText('calendar.month', 'Month')],
                            ['schedule', resolveText('calendar.schedule', 'Schedule')],
                        ] as Array<[CalendarViewMode, string]>).map(([mode, label]) => (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => handleViewModeChange(mode)}
                                className={cn(
                                    "h-7 rounded px-2.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                                    viewMode === mode
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
                        <button
                            type="button"
                            onClick={handlePrevMonth}
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            aria-label={resolveText('calendar.prevMonth', 'Previous month')}
                            title={resolveText('calendar.prevMonth', 'Previous month')}
                        >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setIsMonthPickerOpen((open) => !open)}
                                className="h-8 min-w-[11rem] rounded px-3 text-sm font-semibold hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                                aria-haspopup="dialog"
                                aria-expanded={isMonthPickerOpen}
                            >
                                {currentMonthLabel}
                            </button>
                            {isMonthPickerOpen && (
                                <div className="absolute right-0 top-10 z-20 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg">
                                    <div className="grid grid-cols-2 gap-2">
                                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                                            {resolveText('calendar.month', 'Month')}
                                            <select
                                                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                                                value={getCalendarMonthIndex(currentMonth, calendarSystem)}
                                                onChange={(event) => handleMonthChange(Number(event.target.value))}
                                                aria-label={resolveText('calendar.month', 'Month')}
                                            >
                                                {monthNames.map((label, index) => (
                                                    <option key={label} value={index}>{label}</option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                                            {resolveText('calendar.year', 'Year')}
                                            <select
                                                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                                                value={currentYear}
                                                onChange={(event) => handleYearChange(Number(event.target.value))}
                                                aria-label={resolveText('calendar.year', 'Year')}
                                            >
                                                {yearOptions.map((year) => (
                                                    <option key={year} value={year}>{year}</option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={handleNextMonth}
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                            aria-label={resolveText('calendar.nextMonth', 'Next month')}
                            title={resolveText('calendar.nextMonth', 'Next month')}
                        >
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </header>
            <div className="mb-4 space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={t('common.search')}
                            value={viewFilterQuery}
                            onChange={(event) => setViewFilterQuery(event.target.value)}
                            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                    </div>
                </div>
                {visibleSearchMatchCount !== null && (
                    <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                        {visibleSearchMatchCount > 0
                            ? resolveText('calendar.searchMatches', `${visibleSearchMatchCount} matches in this view`).replace('{count}', String(visibleSearchMatchCount))
                            : resolveText('calendar.noSearchMatches', 'No matching calendar items in this view')}
                    </div>
                )}
            </div>

            {externalError && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                    {externalError}
                </div>
            )}

            {externalCalendars.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/70 px-3 py-2">
                    <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                        {resolveText('calendar.visibleCalendars', 'Calendars')}
                    </span>
                    {externalCalendars.map((calendar) => {
                        const hidden = hiddenExternalCalendarIds.has(calendar.id);
                        return (
                            <button
                                key={calendar.id}
                                type="button"
                                onClick={() => toggleExternalCalendar(calendar.id)}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                                    hidden
                                        ? "border-border bg-muted/40 text-muted-foreground"
                                        : "border-border bg-background text-foreground"
                                )}
                            >
                                <span
                                    className="h-2.5 w-2.5 rounded-full"
                                    style={{ backgroundColor: hidden ? 'hsl(var(--muted-foreground))' : externalCalendarColor(calendar.id) }}
                                    aria-hidden="true"
                                />
                                {calendar.name}
                            </button>
                        );
                    })}
                </div>
            )}

            <div
                ref={calendarBodyRef}
                className={cn(
                    "grid gap-6",
                    isPlanningPanelCollapsed
                        ? "xl:grid-cols-[minmax(0,1fr)_3.5rem]"
                        : "xl:grid-cols-[minmax(0,1fr)_20rem]"
                )}
            >
                <div className="min-w-0 space-y-6">
                {viewMode === 'month' && (
                <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden shadow-sm">
                    {weekdayHeaders.map((day) => (
                        <div key={day} className="bg-card p-2 text-center text-sm font-medium text-muted-foreground">
                            {day}
                        </div>
                    ))}

                    {days.map((day, _dayIdx) => {
                        const cellItems = getCalendarItemsForDate(day);
                        const visibleItems = cellItems.slice(0, 3);
                        const overflowCount = Math.max(0, cellItems.length - visibleItems.length);
                        const isSelected = selectedDate && isSameDay(day, selectedDate);
                        const todayMarkerStyle = isToday(day)
                            ? {
                                backgroundColor: 'hsl(var(--primary))',
                                color: 'hsl(var(--primary-foreground))',
                            }
                            : undefined;

                        return (
                            <div
                                key={day.toString()}
                                className={cn(
                                    "group bg-card min-h-[128px] cursor-pointer p-2 transition-colors hover:bg-accent/50 relative",
                                    !isSameCalendarMonth(day, currentMonth, calendarSystem) && "bg-muted/50 text-muted-foreground",
                                    isSelected && "ring-2 ring-primary"
                                )}
                                data-calendar-drop-date={dayKey(day)}
                                role="button"
                                tabIndex={0}
                                aria-label={`${day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}, ${resolveText('calendar.openDayView', 'Open day view')}`}
                                onClick={() => openDayViewForDate(day)}
                                onKeyDown={(event) => handleOpenDayKeyDown(event, day)}
                                onDragOver={handleCalendarTaskDragOver}
                                onDrop={(event) => handleDropOnDueDate(event, day)}
                                title={resolveText('calendar.openDayView', 'Open day view')}
                            >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium" style={todayMarkerStyle}>
                                            <span className="tabular-nums leading-none">
                                                {getCalendarDayOfMonth(day, calendarSystem)}
                                            </span>
                                        </div>
                                        {isToday(day) && (
                                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-normal text-primary">
                                                {resolveText('calendar.today', 'Today')}
                                            </span>
                                        )}
                                    </div>
                                    {isSelected && <div className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
                                </div>

                                <div className="space-y-1">
                                    {visibleItems.map((item) => {
                                        const timeLabel = item.start && (item.kind === 'scheduled' || (item.kind === 'event' && !item.event.allDay))
                                            ? safeFormatDate(item.start, 'p')
                                            : item.kind === 'event' && item.event.allDay
                                                ? t('calendar.allDay')
                                                : '';

                                        if (item.kind === 'event') {
                                            const content = (
                                                <>
                                                    {timeLabel && <span className="mr-1 text-[10px] opacity-75">{timeLabel}</span>}
                                                    <span>{item.title}</span>
                                                </>
                                            );
                                            return (
                                                <div
                                                    key={item.id}
                                                    className="truncate rounded border-l-[3px] bg-muted/70 px-1.5 py-1 text-xs text-muted-foreground"
                                                    style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                    title={item.title}
                                                >
                                                    {content}
                                                </div>
                                            );
                                        }

                                        const task = item.task;
                                        const projected = isProjectedRecurringTask(task);
                                        const projectedLabel = projected
                                            ? getProjectedRecurrenceDisplayLabel(task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                            : '';
                                        const content = (
                                            <>
                                                {timeLabel && <span className="mr-1 text-[10px] opacity-75">{timeLabel}</span>}
                                                <span>{item.title}</span>
                                                {projected && <span className="ml-1 text-[10px] opacity-75">{projectedLabel}</span>}
                                            </>
                                        );
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                data-task-id={task.id}
                                                {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                draggable={!projected}
                                                disabled={projected}
                                                className={cn(
                                                    "block w-full truncate rounded px-1.5 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                    projected
                                                        ? "border border-dashed border-primary/50 bg-primary/5 text-primary/80"
                                                        : item.kind === 'scheduled'
                                                        ? "bg-primary/10 text-primary"
                                                        : "border-l-[3px] border-destructive/70 bg-background/60 text-foreground"
                                                )}
                                                title={projected ? `${task.title} (${projectedLabel})` : task.title}
                                                onDragStart={(event) => handleCalendarTaskDragStart(event, task, item.kind)}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (projected) return;
                                                    openTaskFromCalendar(task);
                                                }}
                                            >
                                                {content}
                                            </button>
                                        );
                                    })}
                                    {overflowCount > 0 && (
                                        <button
                                            type="button"
                                            className="w-full rounded px-1.5 pt-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                openDayViewForDate(day);
                                            }}
                                            aria-label={`${resolveText('calendar.openDayView', 'Open day view')}: ${day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`}
                                        >
                                            +{overflowCount} {resolveText('calendar.more', 'more')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                )}

                {(viewMode === 'day' || viewMode === 'week') && (
                    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                        <div
                            className="grid border-b border-border bg-muted/40"
                            style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}
                        >
                            <div className="border-r border-border p-2 text-xs font-medium text-muted-foreground">
                                {resolveText('calendar.time', 'Time')}
                            </div>
                            {timelineDays.map((day) => (
                                <button
                                    key={dayKey(day)}
                                    type="button"
                                    onClick={() => selectCalendarDate(day)}
                                    className={cn(
                                        "border-r border-border p-2 text-left last:border-r-0 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40",
                                        isToday(day) && "bg-primary/5"
                                    )}
                                >
                                    <div className="text-xs font-medium text-muted-foreground">
                                        {day.toLocaleDateString(locale, { weekday: 'short' })}
                                    </div>
                                    <div className={cn("mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-semibold", isToday(day) && "bg-primary text-primary-foreground")}>
                                        {getCalendarDayOfMonth(day, calendarSystem)}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <div
                            className="grid border-b border-border"
                            style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}
                        >
                            <div className="border-r border-border p-2 text-xs font-medium text-muted-foreground">
                                {t('calendar.allDay')}
                            </div>
                            {timelineDays.map((day) => {
                                const allDayItems = getAllDayItemsForDay(day).slice(0, 4);
                                return (
                                    <div
                                        key={dayKey(day)}
                                        data-calendar-all-day-drop-date={dayKey(day)}
                                        className="min-h-12 space-y-1 border-r border-border p-2 last:border-r-0"
                                        onDragOver={handleCalendarTaskDragOver}
                                        onDrop={(event) => handleDropOnDueDate(event, day)}
                                    >
                                        {allDayItems.map((item) => {
                                            if (item.kind === 'event') {
                                                return (
                                                    <div
                                                        key={item.id}
                                                        className="truncate rounded border-l-[3px] bg-muted/60 px-2 py-1 text-xs text-muted-foreground"
                                                        style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                        title={item.title}
                                                    >
                                                        {item.title}
                                                    </div>
                                                );
                                            }
                                            const projected = isProjectedRecurringTask(item.task);
                                            const projectedLabel = projected
                                                ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                : '';
                                            return (
                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    data-task-id={item.task.id}
                                                    {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                    draggable={!projected}
                                                    disabled={projected}
                                                    onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, item.kind)}
                                                    onClick={() => {
                                                        if (!projected) openTaskFromCalendar(item.task);
                                                    }}
                                                    className={cn(
                                                        "block w-full truncate rounded border-l-[3px] px-2 py-1 text-left text-xs hover:bg-muted",
                                                        projected
                                                            ? "border-primary/50 border-dashed bg-primary/5 text-primary/80"
                                                            : item.kind === 'scheduled'
                                                            ? "border-primary/70 bg-primary/5"
                                                            : "border-destructive/70 bg-background/70"
                                                    )}
                                                    title={projected ? `${item.title} (${projectedLabel})` : item.title}
                                                >
                                                    {projected ? `${item.title} · ${projectedLabel}` : item.title}
                                                </button>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>

                        <div
                            ref={timelineScrollRef}
                            className="overflow-y-auto"
                            style={{ height: 'clamp(28rem, calc(100vh - 20rem), 48rem)' }}
                        >
                            <div className="grid" style={{ gridTemplateColumns: `4rem repeat(${timelineDays.length}, minmax(0, 1fr))` }}>
                                <div className="relative border-r border-border bg-muted/20" style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}>
                                    {Array.from({ length: DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR + 1 }, (_, index) => {
                                        const hour = DESKTOP_DAY_START_HOUR + index;
                                        return (
                                            <div key={hour} className="absolute right-2 -translate-y-2 text-[11px] text-muted-foreground" style={{ top: index * DESKTOP_HOUR_HEIGHT }}>
                                                {safeFormatDate(new Date(0, 0, 1, hour), 'p')}
                                            </div>
                                        );
                                    })}
                                </div>
                                {timelineDays.map((day) => {
                                    const now = new Date();
                                    const nowMinutes = (now.getHours() - DESKTOP_DAY_START_HOUR) * 60 + now.getMinutes();
                                    const nowTop = nowMinutes / 60 * DESKTOP_HOUR_HEIGHT;
                                    const showNow = isToday(day) && nowMinutes >= 0 && nowMinutes <= (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60;
                                    return (
                                        <div
                                            key={dayKey(day)}
                                            data-calendar-timed-drop-date={dayKey(day)}
                                            className={cn("relative border-r border-border last:border-r-0", isToday(day) && "bg-primary/5")}
                                            style={{ height: (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * DESKTOP_HOUR_HEIGHT }}
                                            onDragOver={handleCalendarTaskDragOver}
                                            onDrop={(event) => handleDropOnTimelineSlot(event, day)}
                                            onClick={(event) => {
                                                const rect = event.currentTarget.getBoundingClientRect();
                                                const rawMinutes = ((event.clientY - rect.top) / DESKTOP_HOUR_HEIGHT) * 60;
                                                const snapped = Math.round(rawMinutes / DESKTOP_GRID_SNAP_MINUTES) * DESKTOP_GRID_SNAP_MINUTES;
                                                const maxMinutes = (DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR) * 60 - 30;
                                                const clamped = Math.max(0, Math.min(maxMinutes, snapped));
                                                const start = new Date(day);
                                                start.setHours(DESKTOP_DAY_START_HOUR, clamped, 0, 0);
                                                openQuickAddForStart(start);
                                            }}
                                        >
                                            {Array.from({ length: DESKTOP_DAY_END_HOUR - DESKTOP_DAY_START_HOUR + 1 }, (_, index) => (
                                                <div
                                                    key={index}
                                                    className="absolute left-0 right-0 border-t border-border/70"
                                                    style={{ top: index * DESKTOP_HOUR_HEIGHT }}
                                                />
                                            ))}
                                            {showNow && (
                                                <div className="absolute left-0 right-0 z-20 flex items-center" style={{ top: nowTop }}>
                                                    <span className="h-2 w-2 -translate-x-1 rounded-full bg-red-500" />
                                                    <span className="h-0.5 flex-1 bg-red-500" />
                                                </div>
                                            )}
                                            {layoutTimedItems(day).map((item) => {
                                                const timeLabel = `${safeFormatDate(item.start, 'p')}-${safeFormatDate(item.end, 'p')}`;
                                                const commonStyle = {
                                                    height: item.height,
                                                    left: `calc(${item.leftPercent}% + 3px)`,
                                                    top: item.top,
                                                    width: `calc(${item.widthPercent}% - 6px)`,
                                                };
                                                if (item.kind === 'event') {
                                                    return (
                                                        <div
                                                            key={item.id}
                                                            data-calendar-block
                                                            className="absolute z-10 overflow-hidden rounded border-l-[4px] bg-muted/80 px-2 py-1 text-xs text-muted-foreground shadow-sm"
                                                            style={{ ...commonStyle, borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                            title={`${item.title} ${timeLabel}`}
                                                            onClick={(event) => event.stopPropagation()}
                                                        >
                                                            <div className="truncate font-medium text-foreground">{item.title}</div>
                                                            <div className="truncate">{timeLabel}</div>
                                                        </div>
                                                    );
                                                }
                                                const projected = isProjectedRecurringTask(item.task);
                                                const projectedLabel = projected
                                                    ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                    : '';
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        data-calendar-block
                                                        data-task-id={item.task.id}
                                                        {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                        draggable={!projected}
                                                        disabled={projected}
                                                        className={cn(
                                                            "absolute z-10 overflow-hidden rounded px-2 py-1 text-left text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                            projected
                                                                ? "border border-dashed border-primary/50 bg-primary/10 text-primary"
                                                                : "bg-primary text-primary-foreground hover:bg-primary/90"
                                                        )}
                                                        style={commonStyle}
                                                        title={projected ? `${item.title} ${timeLabel} (${projectedLabel})` : `${item.title} ${timeLabel}`}
                                                        onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, 'scheduled')}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            if (projected) return;
                                                            openTaskFromCalendar(item.task);
                                                        }}
                                                    >
                                                        <div className="truncate font-semibold">{item.title}</div>
                                                        <div className="truncate opacity-90">
                                                            {projected ? `${timeLabel} · ${projectedLabel}` : timeLabel}
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                {viewMode === 'schedule' && (
                    <div className="rounded-lg border border-border bg-card">
                        <div className="border-b border-border px-4 py-3">
                            <div className="text-sm font-semibold">{resolveText('calendar.schedule', 'Schedule')}</div>
                            <div className="text-xs text-muted-foreground">{currentMonthLabel}</div>
                        </div>
                        <div className="divide-y divide-border">
                            {scheduleDays.map((day) => {
                                const items = getCalendarItemsForDate(day);
                                if (items.length === 0) return null;
                                return (
                                    <section
                                        key={dayKey(day)}
                                        data-calendar-schedule-drop-date={dayKey(day)}
                                        className="grid gap-3 px-4 py-3 md:grid-cols-[9rem_minmax(0,1fr)]"
                                        onDragOver={handleCalendarTaskDragOver}
                                        onDrop={(event) => handleDropOnDueDate(event, day)}
                                    >
                                        <div>
                                            <div className={cn("text-sm font-semibold", isToday(day) && "text-primary")}>
                                                {day.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}
                                            </div>
                                            {isToday(day) && <div className="mt-1 text-xs font-medium text-primary">{resolveText('calendar.today', 'Today')}</div>}
                                        </div>
                                        <div className="space-y-1">
                                            {items.map((item) => {
                                                const isAllDayScheduled = item.kind === 'scheduled' && !hasTimeComponent(item.task.startTime);
                                                const timeLabel = isAllDayScheduled
                                                    ? t('calendar.allDay')
                                                    : item.start && (item.kind === 'scheduled' || (item.kind === 'event' && !item.event.allDay))
                                                    ? safeFormatDate(item.start, 'p')
                                                    : item.kind === 'event' && item.event.allDay
                                                        ? t('calendar.allDay')
                                                        : t('calendar.deadline');
                                                if (item.kind === 'event') {
                                                    return (
                                                        <div
                                                            key={item.id}
                                                            className="flex items-center gap-3 rounded border-l-[3px] bg-muted/50 px-3 py-2 text-sm"
                                                            style={{ borderLeftColor: externalCalendarColor(item.event.sourceId) }}
                                                        >
                                                            <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                                            <button
                                                                type="button"
                                                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/15 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                                                onClick={() => void createTaskFromExternalEvent(item.event)}
                                                                aria-label={`${resolveText('calendar.createTaskFromEvent', 'Create task')}: ${item.title}`}
                                                                title={resolveText('calendar.createTaskFromEvent', 'Create task')}
                                                            >
                                                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                                                {resolveText('calendar.createTaskFromEvent', 'Create task')}
                                                            </button>
                                                        </div>
                                                    );
                                                }
                                                const projected = isProjectedRecurringTask(item.task);
                                                const projectedLabel = projected
                                                    ? getProjectedRecurrenceDisplayLabel(item.task, resolveText('calendar.projectedRecurrence', 'Projected'))
                                                    : '';
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        data-task-id={item.task.id}
                                                        {...(!projected ? { 'data-task-edit-trigger': true } : {})}
                                                        draggable={!projected}
                                                        disabled={projected}
                                                        onDragStart={(event) => handleCalendarTaskDragStart(event, item.task, item.kind)}
                                                        onClick={() => {
                                                            if (!projected) openTaskFromCalendar(item.task);
                                                        }}
                                                        className={cn(
                                                            "flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40",
                                                            projected
                                                                ? "border border-dashed border-primary/50 bg-primary/5 text-primary"
                                                                : item.kind === 'scheduled' ? "bg-primary/10 text-primary" : "border-l-[3px] border-destructive/70 bg-background"
                                                        )}
                                                    >
                                                        <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{timeLabel}</span>
                                                        <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                                                        {projected && (
                                                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                                                {projectedLabel}
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })}
                        </div>
                    </div>
                )}

                <CalendarSelectedDayPanel controller={controller} />
                </div>
                <CalendarPlanningPanel
                    controller={controller}
                    isCollapsed={isPlanningPanelCollapsed}
                    onCollapsedChange={handlePlanningPanelCollapsedChange}
                />
        </div>
            <CalendarOpenTaskModal controller={controller} />
            <CalendarTaskComposerModal controller={controller} />
        </div>
        </ErrorBoundary>
    );
}
