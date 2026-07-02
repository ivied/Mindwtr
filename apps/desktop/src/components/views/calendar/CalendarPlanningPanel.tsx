import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { safeFormatDate, safeParseDueDate, type Task } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import type { DesktopCalendarController } from './useDesktopCalendarController';

type CalendarPlanningPanelController = Pick<
    DesktopCalendarController,
    | 'locale'
    | 'planningTasks'
    | 'resolveText'
    | 'scheduleError'
    | 'schedulePlanningTask'
    | 'selectedDate'
>;

type CalendarPlanningPanelProps = {
    controller: CalendarPlanningPanelController;
    isCollapsed: boolean;
    onCollapsedChange: (collapsed: boolean) => void;
};

const getDueLabel = (task: Task, fallback: string): string | null => {
    if (!task.dueDate) return null;
    const due = safeParseDueDate(task.dueDate);
    if (!due) return null;
    const label = safeFormatDate(due, 'PP');
    return label ? `${fallback}: ${label}` : null;
};

export function CalendarPlanningPanel({
    controller,
    isCollapsed,
    onCollapsedChange,
}: CalendarPlanningPanelProps) {
    const {
        locale,
        planningTasks,
        resolveText,
        scheduleError,
        schedulePlanningTask,
        selectedDate,
    } = controller;
    const selectedDateLabel = selectedDate
        ? selectedDate.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
        : null;
    const targetLabel = selectedDateLabel
        ? resolveText('calendar.planningForDate', 'Plan for {date}').replace('{date}', selectedDateLabel)
        : resolveText('calendar.selectDayToPlan', 'Select a day to plan first.');
    const collapseLabel = resolveText('calendar.collapsePlanningPanel', 'Collapse planning panel');
    const expandLabel = resolveText('calendar.expandPlanningPanel', 'Expand planning panel');

    if (isCollapsed) {
        return (
            <aside className="rounded-lg border border-border bg-card p-2 shadow-sm">
                <button
                    type="button"
                    onClick={() => onCollapsedChange(false)}
                    className="inline-flex h-10 w-full items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    aria-label={expandLabel}
                    title={expandLabel}
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
            </aside>
        );
    }

    return (
        <aside className="space-y-3 rounded-lg border border-border bg-card p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                    <div className="text-sm font-semibold text-foreground">
                        {resolveText('calendar.planningTitle', 'Plan next actions')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {resolveText('calendar.planningHelp', 'Pick existing next actions and place them around your hard landscape.')}
                    </p>
                    <p className={cn("text-xs font-medium", selectedDate ? "text-primary" : "text-muted-foreground")}>
                        {targetLabel}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onCollapsedChange(true)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    aria-label={collapseLabel}
                    title={collapseLabel}
                >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>

            {scheduleError && (
                <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    {scheduleError}
                </div>
            )}

            <div className="space-y-2">
                {planningTasks.map((task) => {
                    const dueLabel = getDueLabel(task, resolveText('taskEdit.dueDateLabel', 'Due date'));
                    return (
                        <div
                            key={task.id}
                            className="rounded-md border border-border bg-background/70 p-2"
                        >
                            <div
                                data-task-id={task.id}
                                className="truncate text-sm font-medium text-foreground"
                                title={task.title}
                            >
                                {task.title}
                            </div>
                            {dueLabel && (
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                    {dueLabel}
                                </div>
                            )}
                            <span
                                className="mt-2 inline-flex"
                                title={selectedDate ? undefined : targetLabel}
                            >
                                <button
                                    type="button"
                                    disabled={!selectedDate}
                                    aria-describedby={!selectedDate ? `calendar-planning-schedule-hint-${task.id}` : undefined}
                                    onClick={() => schedulePlanningTask(task.id)}
                                    className={cn(
                                        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/40",
                                        selectedDate
                                            ? "bg-primary/10 text-primary hover:bg-primary/15"
                                            : "pointer-events-none cursor-not-allowed bg-muted text-muted-foreground"
                                    )}
                                >
                                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                    {resolveText('calendar.scheduleAction', 'Schedule')}
                                </button>
                            </span>
                            {!selectedDate && (
                                <span id={`calendar-planning-schedule-hint-${task.id}`} className="sr-only">
                                    {targetLabel}
                                </span>
                            )}
                        </div>
                    );
                })}
                {planningTasks.length === 0 && (
                    <div className="rounded-md bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                        {resolveText('calendar.planningEmpty', 'No unscheduled next actions.')}
                    </div>
                )}
            </div>
        </aside>
    );
}
