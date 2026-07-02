import { describe, expect, it } from 'vitest';
import { getAdvancedReviewDate, getStaleItems } from './review-utils';
import type { Project, Task } from './types';

const staleUpdatedAt = '2026-01-01T00:00:00.000Z';
const now = new Date('2026-03-01T00:00:00.000Z');

const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Future task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    ...overrides,
});

const createProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#3B82F6',
    order: 0,
    tagIds: [],
    createdAt: staleUpdatedAt,
    updatedAt: staleUpdatedAt,
    ...overrides,
});

describe('getStaleItems', () => {
    it('includes task and project scheduling dates in stale review snapshots', () => {
        const task = createTask({
            startTime: '2026-09-01T09:00:00.000Z',
            dueDate: '2026-09-05T17:00:00.000Z',
            reviewAt: '2026-08-15T09:00:00.000Z',
        });
        const project = createProject({
            dueDate: '2026-12-01',
            reviewAt: '2026-11-01T09:00:00.000Z',
        });

        const items = getStaleItems([task], [project], 14, now);

        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'task-1',
                startTime: task.startTime,
                dueDate: task.dueDate,
                reviewAt: task.reviewAt,
            }),
            expect.objectContaining({
                id: 'project:project-1',
                dueDate: project.dueDate,
                reviewAt: project.reviewAt,
            }),
        ]));
    });
});

describe('getAdvancedReviewDate', () => {
    const localNow = new Date(2026, 5, 10, 15, 30); // 2026-06-10 15:30 local

    it('returns a date-only value one week out for date-only review dates', () => {
        expect(getAdvancedReviewDate('2026-06-01', localNow)).toBe('2026-06-17');
    });

    it('keeps the original time of day for datetime review dates', () => {
        expect(getAdvancedReviewDate('2026-06-01T09:15', localNow)).toBe('2026-06-17T09:15');
    });

    it('falls back to date-only when the review date is missing or invalid', () => {
        expect(getAdvancedReviewDate(undefined, localNow)).toBe('2026-06-17');
        expect(getAdvancedReviewDate('not a date T00:00', localNow)).toBe('2026-06-17');
    });

    it('advances from now, not from an overdue review date', () => {
        expect(getAdvancedReviewDate('2025-01-01', localNow)).toBe('2026-06-17');
    });

    it('honors a custom day count', () => {
        expect(getAdvancedReviewDate('2026-06-01', localNow, 14)).toBe('2026-06-24');
    });
});
