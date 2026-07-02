import { addDays, format } from 'date-fns';

import type { ReviewSnapshotItem } from './ai/types';
import type { Project, Task } from './types';
import { hasTimeComponent, safeParseDate } from './date';
import { isTaskInActiveProject } from './project-utils';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_REVIEW_ADVANCE_DAYS = 7;

/**
 * Next review date after marking an item reviewed: `days` from now, preserving
 * the original value's date-only vs datetime shape (time-of-day carries over).
 */
export function getAdvancedReviewDate(
    reviewAt: string | undefined | null,
    now: Date = new Date(),
    days: number = DEFAULT_REVIEW_ADVANCE_DAYS,
): string {
    const target = addDays(now, days);
    if (reviewAt && hasTimeComponent(reviewAt)) {
        const parsed = safeParseDate(reviewAt);
        if (parsed) {
            const withTime = new Date(target);
            withTime.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0);
            return format(withTime, "yyyy-MM-dd'T'HH:mm");
        }
    }
    return format(target, 'yyyy-MM-dd');
}

export function getStaleItems(
    tasks: Task[],
    projects: Project[],
    staleThresholdDays = 14,
    now: Date = new Date(),
): ReviewSnapshotItem[] {
    const items: ReviewSnapshotItem[] = [];
    const projectMap = new Map(projects.map((project) => [project.id, project]));

    tasks.forEach((task) => {
        if (task.deletedAt) return;
        if (task.status !== 'next' && task.status !== 'waiting') return;
        if (!isTaskInActiveProject(task, projectMap)) return;
        const updated = new Date(task.updatedAt || task.createdAt);
        if (Number.isNaN(updated.getTime())) return;
        const daysStale = Math.ceil((now.getTime() - updated.getTime()) / DAY_MS);
        if (daysStale <= staleThresholdDays) return;
        items.push({
            id: task.id,
            title: task.title,
            daysStale,
            status: task.status === 'waiting' ? 'waiting' : 'next',
            startTime: task.startTime,
            dueDate: task.dueDate,
            reviewAt: task.reviewAt,
        });
    });

    projects.forEach((project) => {
        if (project.deletedAt) return;
        if (project.status !== 'active') return;
        const updated = new Date(project.updatedAt || project.createdAt);
        if (Number.isNaN(updated.getTime())) return;
        const daysStale = Math.ceil((now.getTime() - updated.getTime()) / DAY_MS);
        if (daysStale <= staleThresholdDays) return;
        items.push({
            id: `project:${project.id}`,
            title: project.title,
            daysStale,
            status: 'project',
            dueDate: project.dueDate,
            reviewAt: project.reviewAt,
        });
    });

    return items.sort((a, b) => b.daysStale - a.daysStale);
}
