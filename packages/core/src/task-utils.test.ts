import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
    buildTasksByProjectId,
    getCalendarPlanningCandidates,
    sortTasks,
    sortFocusNextActions,
    sortTasksBySavedPreference,
    getProjectDeadlineBoosts,
    getStatusColor,
    getTaskAgeLabel,
    rescheduleTask,
    extractWaitingPerson,
    getFocusSequentialFirstTaskIds,
    getSequentialFirstTaskIds,
    getTaskFocusEligibility,
    getWaitingPerson,
    groupCompletedTasksLast,
    isTaskFutureStart,
    shouldShowTaskForStart,
    sortDoneTasksForListView,
    sortTasksByBoardOrder,
    splitCompletedTasks,
} from './task-utils';
import { Project, Task } from './types';

describe('task-utils', () => {
    describe('sortDoneTasksForListView', () => {
        const createDoneTask = (id: string, title: string, completedAt?: string): Task => ({
            id,
            title,
            status: 'done',
            tags: [],
            contexts: [],
            completedAt,
            createdAt: '2026-02-01T00:00:00.000Z',
            updatedAt: completedAt ?? '2026-02-01T00:00:00.000Z',
        });

        it('sorts done tasks by most recent completion first', () => {
            const sorted = sortDoneTasksForListView([
                createDoneTask('old', 'Old', '2026-02-20T10:00:00.000Z'),
                createDoneTask('newest', 'Newest', '2026-02-22T10:00:00.000Z'),
                createDoneTask('middle', 'Middle', '2026-02-21T10:00:00.000Z'),
            ]);

            expect(sorted.map((task) => task.id)).toEqual(['newest', 'middle', 'old']);
        });

        it('falls back to updatedAt when completedAt is missing', () => {
            const sorted = sortDoneTasksForListView([
                {
                    ...createDoneTask('alpha', 'Alpha'),
                    updatedAt: '2026-02-20T10:00:00.000Z',
                },
                {
                    ...createDoneTask('beta', 'Beta'),
                    updatedAt: '2026-02-22T10:00:00.000Z',
                },
            ]);

            expect(sorted.map((task) => task.id)).toEqual(['beta', 'alpha']);
        });
    });

    describe('buildTasksByProjectId', () => {
        it('profiles large project task lookup without repeated full-store scans', () => {
            const projectCount = 250;
            const tasksPerProject = 80;
            const selectedProjectId = 'project-137';
            const tasks: Task[] = [];

            for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
                const projectId = `project-${projectIndex}`;
                for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex += 1) {
                    tasks.push({
                        id: `task-${projectIndex}-${taskIndex}`,
                        title: `Task ${projectIndex}-${taskIndex}`,
                        status: taskIndex % 7 === 0 ? 'done' : 'next',
                        projectId,
                        createdAt: '2026-06-01T00:00:00.000Z',
                        updatedAt: '2026-06-01T00:00:00.000Z',
                    } as Task);
                }
            }

            tasks.push(
                {
                    id: 'inbox-task',
                    title: 'Inbox task',
                    status: 'inbox',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    updatedAt: '2026-06-01T00:00:00.000Z',
                } as Task,
                {
                    id: 'deleted-selected-task',
                    title: 'Deleted selected task',
                    status: 'next',
                    projectId: selectedProjectId,
                    deletedAt: '2026-06-02T00:00:00.000Z',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    updatedAt: '2026-06-02T00:00:00.000Z',
                } as Task,
            );

            const tasksByProjectId = buildTasksByProjectId(tasks);
            const selectedProjectTasks = tasksByProjectId.get(selectedProjectId) ?? [];

            expect(tasksByProjectId.size).toBe(projectCount);
            expect(selectedProjectTasks).toHaveLength(tasksPerProject);
            expect(selectedProjectTasks.every((task) => task.projectId === selectedProjectId && !task.deletedAt)).toBe(true);
            expect(tasksByProjectId.has('')).toBe(false);

            const lookupIterations = 5_000;
            const indexedLookupStartedAt = performance.now();
            let indexedLookupCount = 0;
            for (let index = 0; index < lookupIterations; index += 1) {
                indexedLookupCount += tasksByProjectId.get(selectedProjectId)?.length ?? 0;
            }
            const indexedLookupMs = performance.now() - indexedLookupStartedAt;

            const repeatedScanIterations = 100;
            const repeatedScanStartedAt = performance.now();
            let repeatedScanCount = 0;
            for (let index = 0; index < repeatedScanIterations; index += 1) {
                repeatedScanCount += tasks.filter((task) => task.projectId === selectedProjectId && !task.deletedAt).length;
            }
            const repeatedScanMs = performance.now() - repeatedScanStartedAt;

            expect(indexedLookupCount).toBe(tasksPerProject * lookupIterations);
            expect(repeatedScanCount).toBe(tasksPerProject * repeatedScanIterations);
            expect(indexedLookupMs).toBeLessThan(repeatedScanMs);
        });
    });

    describe('getCalendarPlanningCandidates', () => {
        it('returns visible unscheduled next actions without sequentially blocked tasks', () => {
            const projects = [
                {
                    id: 'sequential-project',
                    title: 'Sequential project',
                    status: 'active',
                    isSequential: true,
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ] as Project[];
            const tasks = [
                {
                    id: 'deadline-only',
                    title: 'Deadline only',
                    status: 'next',
                    dueDate: '2026-01-05T17:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'scheduled',
                    title: 'Already scheduled',
                    status: 'next',
                    startTime: '2026-01-03T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'focused',
                    title: 'Focused today',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'sequential-first',
                    title: 'Sequential first',
                    status: 'next',
                    projectId: 'sequential-project',
                    order: 0,
                    orderNum: 0,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'sequential-second',
                    title: 'Sequential second',
                    status: 'next',
                    projectId: 'sequential-project',
                    order: 1,
                    orderNum: 1,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ] as Task[];

            const candidates = getCalendarPlanningCandidates(tasks, {
                now: new Date('2026-01-01T12:00:00.000Z'),
                projects,
            });

            expect(candidates.map((task) => task.id)).toEqual([
                'deadline-only',
                'sequential-first',
            ]);
        });
    });

    describe('sortTasks', () => {
        it('should sort by status order', () => {
            const tasks: Partial<Task>[] = [
                { id: '1', status: 'next', title: 'Next', createdAt: '2023-01-01' },
                { id: '2', status: 'inbox', title: 'Inbox', createdAt: '2023-01-01' },
                { id: '3', status: 'done', title: 'Done', createdAt: '2023-01-01' },
            ];

            const sorted = sortTasks(tasks as Task[]);
            expect(sorted.map(t => t.status)).toEqual(['inbox', 'next', 'done']);
        });

        it('should sort by due date within status', () => {
            const tasks: Partial<Task>[] = [
                { id: '1', status: 'next', title: 'Later', dueDate: '2023-01-02', createdAt: '2023-01-01' },
                { id: '2', status: 'next', title: 'Soon', dueDate: '2023-01-01', createdAt: '2023-01-01' },
                { id: '3', status: 'next', title: 'No Date', createdAt: '2023-01-01' },
            ];

            const sorted = sortTasks(tasks as Task[]);
            expect(sorted.map(t => t.title)).toEqual(['Soon', 'Later', 'No Date']);
        });
    });

    describe('sortFocusNextActions', () => {
        it('puts due-soon tasks ahead of undated tasks and sinks far-future due tasks', () => {
            const sorted = sortFocusNextActions([
                {
                    id: 'future',
                    title: 'Future due',
                    status: 'next',
                    dueDate: '2027-04-01T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T08:00:00.000Z',
                    updatedAt: '2026-01-01T08:00:00.000Z',
                },
                {
                    id: 'undated',
                    title: 'Undated task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T07:00:00.000Z',
                    updatedAt: '2026-01-01T07:00:00.000Z',
                },
                {
                    id: 'soon',
                    title: 'Soon due',
                    status: 'next',
                    dueDate: '2026-01-10T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T06:00:00.000Z',
                    updatedAt: '2026-01-01T06:00:00.000Z',
                },
            ] as Task[], {
                now: new Date('2026-01-01T00:00:00.000Z'),
            });

            expect(sorted.map((task) => task.id)).toEqual(['soon', 'undated', 'future']);
        });

        it('orders due-soon tasks by earliest due date', () => {
            const sorted = sortFocusNextActions([
                {
                    id: 'later',
                    title: 'Later this month',
                    status: 'next',
                    dueDate: '2026-01-20T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T08:00:00.000Z',
                    updatedAt: '2026-01-01T08:00:00.000Z',
                },
                {
                    id: 'overdue',
                    title: 'Overdue task',
                    status: 'next',
                    dueDate: '2025-12-31T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T07:00:00.000Z',
                    updatedAt: '2026-01-01T07:00:00.000Z',
                },
                {
                    id: 'near',
                    title: 'Near due',
                    status: 'next',
                    dueDate: '2026-01-05T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T06:00:00.000Z',
                    updatedAt: '2026-01-01T06:00:00.000Z',
                },
            ] as Task[], {
                now: new Date('2026-01-01T00:00:00.000Z'),
            });

            expect(sorted.map((task) => task.id)).toEqual(['overdue', 'near', 'later']);
        });

        it('surfaces one date-less next action from each overdue or due-today project', () => {
            const now = new Date('2026-01-10T12:00:00.000Z');
            const projects = [
                {
                    id: 'today-project',
                    title: 'Today project',
                    status: 'active',
                    dueDate: '2026-01-10T17:00:00.000Z',
                    color: '#123456',
                    order: 1,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'overdue-project',
                    title: 'Overdue project',
                    status: 'active',
                    dueDate: '2026-01-08T17:00:00.000Z',
                    color: '#654321',
                    order: 2,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ] as Project[];
            const tasks = [
                {
                    id: 'normal-undated',
                    title: 'Normal undated',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'today-project-second',
                    title: 'Second project action',
                    status: 'next',
                    projectId: 'today-project',
                    order: 1,
                    orderNum: 1,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-07T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'today-project-first',
                    title: 'First project action',
                    status: 'next',
                    projectId: 'today-project',
                    order: 0,
                    orderNum: 0,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-05T00:00:00.000Z',
                    updatedAt: '2026-01-05T00:00:00.000Z',
                },
                {
                    id: 'overdue-project-first',
                    title: 'Overdue project action',
                    status: 'next',
                    projectId: 'overdue-project',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-06T00:00:00.000Z',
                    updatedAt: '2026-01-06T00:00:00.000Z',
                },
            ] as Task[];

            const boosts = getProjectDeadlineBoosts(tasks, projects, { now });
            const sorted = sortFocusNextActions(tasks, {
                now,
                projectDeadlineBoosts: boosts,
            });

            expect([...boosts.keys()]).toEqual(['today-project-first', 'overdue-project-first']);
            expect(sorted.map((task) => task.id)).toEqual([
                'overdue-project-first',
                'today-project-first',
                'normal-undated',
                'today-project-second',
            ]);
            expect(tasks.find((task) => task.id === 'today-project-first')?.dueDate).toBeUndefined();
        });

        it('does not boost dated tasks, future-start tasks, inactive projects, or projects due after today', () => {
            const now = new Date('2026-01-10T12:00:00.000Z');
            const projects = [
                {
                    id: 'due-project',
                    title: 'Due project',
                    status: 'active',
                    dueDate: '2026-01-10T17:00:00.000Z',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'future-project',
                    title: 'Future project',
                    status: 'active',
                    dueDate: '2026-01-11T17:00:00.000Z',
                    color: '#654321',
                    order: 1,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'someday-project',
                    title: 'Someday project',
                    status: 'someday',
                    dueDate: '2026-01-10T17:00:00.000Z',
                    color: '#abcdef',
                    order: 2,
                    tagIds: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ] as Project[];
            const tasks = [
                {
                    id: 'dated-task',
                    title: 'Dated task',
                    status: 'next',
                    projectId: 'due-project',
                    dueDate: '2026-01-20T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'future-start-task',
                    title: 'Future start task',
                    status: 'next',
                    projectId: 'due-project',
                    startTime: '2026-01-12T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
                {
                    id: 'future-project-task',
                    title: 'Future project task',
                    status: 'next',
                    projectId: 'future-project',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-03T00:00:00.000Z',
                    updatedAt: '2026-01-03T00:00:00.000Z',
                },
                {
                    id: 'someday-project-task',
                    title: 'Someday project task',
                    status: 'next',
                    projectId: 'someday-project',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-04T00:00:00.000Z',
                    updatedAt: '2026-01-04T00:00:00.000Z',
                },
            ] as Task[];

            expect([...getProjectDeadlineBoosts(tasks, projects, { now }).keys()]).toEqual([]);
        });
    });

    describe('sortTasksBySavedPreference', () => {
        it('sorts start-date perspectives before priority and creation fallbacks', () => {
            const sorted = sortTasksBySavedPreference([
                {
                    id: 'high-later',
                    title: 'High later',
                    status: 'next',
                    priority: 'urgent',
                    startTime: '2026-02-03T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T08:00:00.000Z',
                    updatedAt: '2026-02-01T08:00:00.000Z',
                },
                {
                    id: 'low-earlier',
                    title: 'Low earlier',
                    status: 'next',
                    priority: 'low',
                    startTime: '2026-02-02T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T07:00:00.000Z',
                    updatedAt: '2026-02-01T07:00:00.000Z',
                },
                {
                    id: 'high-same-start',
                    title: 'High same start',
                    status: 'next',
                    priority: 'high',
                    startTime: '2026-02-02T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T09:00:00.000Z',
                    updatedAt: '2026-02-01T09:00:00.000Z',
                },
            ] as Task[], 'start', { prioritizeByPriority: true });

            expect(sorted.map((task) => task.id)).toEqual(['high-same-start', 'low-earlier', 'high-later']);
        });

        it('sorts custom time estimates by exact minutes', () => {
            const sorted = sortTasksBySavedPreference([
                {
                    id: 'custom-150',
                    title: 'Custom 150',
                    status: 'next',
                    timeEstimate: 'custom:150',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T08:00:00.000Z',
                    updatedAt: '2026-02-01T08:00:00.000Z',
                },
                {
                    id: 'preset-2h',
                    title: 'Preset 2h',
                    status: 'next',
                    timeEstimate: '2hr',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T07:00:00.000Z',
                    updatedAt: '2026-02-01T07:00:00.000Z',
                },
                {
                    id: 'preset-3h',
                    title: 'Preset 3h',
                    status: 'next',
                    timeEstimate: '3hr',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T09:00:00.000Z',
                    updatedAt: '2026-02-01T09:00:00.000Z',
                },
            ] as Task[], 'timeEstimate');

            expect(sorted.map((task) => task.id)).toEqual(['preset-2h', 'custom-150', 'preset-3h']);
        });
    });

    describe('completed task grouping', () => {
        it('splits done tasks from active tasks without changing order inside either group', () => {
            const tasks = [
                { id: 'done-1', status: 'done', title: 'Done first', createdAt: '2026-01-01' },
                { id: 'next-1', status: 'next', title: 'Next', createdAt: '2026-01-02' },
                { id: 'waiting-1', status: 'waiting', title: 'Waiting', createdAt: '2026-01-03' },
                { id: 'done-2', status: 'done', title: 'Done second', createdAt: '2026-01-04' },
            ] as Task[];

            expect(splitCompletedTasks(tasks)).toEqual({
                activeTasks: [tasks[1], tasks[2]],
                completedTasks: [tasks[0], tasks[3]],
            });
        });

        it('moves completed tasks after active tasks', () => {
            const tasks = [
                { id: 'done-1', status: 'done', title: 'Done first', createdAt: '2026-01-01' },
                { id: 'next-1', status: 'next', title: 'Next', createdAt: '2026-01-02' },
                { id: 'done-2', status: 'done', title: 'Done second', createdAt: '2026-01-03' },
            ] as Task[];

            expect(groupCompletedTasksLast(tasks).map((task) => task.id)).toEqual(['next-1', 'done-1', 'done-2']);
        });
    });

    describe('getStatusColor', () => {
        it('should return valid color object', () => {
            const color = getStatusColor('next');
            expect(color).toHaveProperty('bg');
            expect(color).toHaveProperty('text');
            expect(color).toHaveProperty('border');
        });

        it('should default to inbox color for unknown', () => {
            // @ts-ignore
            const color = getStatusColor('unknown');
            const inboxColor = getStatusColor('inbox');
            expect(color).toEqual(inboxColor);
        });

        it('uses distinct default colors for next and done', () => {
            expect(getStatusColor('next')).not.toEqual(getStatusColor('done'));
            expect(getStatusColor('next').text).toBe('#2563EB');
        });
    });

    describe('getTaskAgeLabel', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2025-02-15T12:00:00.000Z'));
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should return null for new tasks', () => {
            expect(getTaskAgeLabel('2025-02-15T12:00:00.000Z')).toBeNull();
        });

        it('should return correct label for old tasks', () => {
            expect(getTaskAgeLabel('2025-02-01T12:00:00.000Z')).toBe('2 weeks old');
        });
    });

    describe('rescheduleTask', () => {
        it('increments pushCount when dueDate moves later', () => {
            const task: Task = {
                id: '1',
                title: 'Reschedule',
                status: 'next',
                tags: [],
                contexts: [],
                dueDate: '2025-01-01T09:00:00.000Z',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };
            const updated = rescheduleTask(task, '2025-01-02T09:00:00.000Z');
            expect(updated.pushCount).toBe(1);
        });

        it('does not increment pushCount when dueDate moves earlier', () => {
            const task: Task = {
                id: '2',
                title: 'Reschedule earlier',
                status: 'next',
                tags: [],
                contexts: [],
                dueDate: '2025-01-03T09:00:00.000Z',
                pushCount: 2,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };
            const updated = rescheduleTask(task, '2025-01-02T09:00:00.000Z');
            expect(updated.pushCount).toBe(2);
        });
    });

    describe('extractWaitingPerson', () => {
        it('extracts the waiting person from a dedicated line', () => {
            const description = 'Need follow-up\nWaiting for: Alex\nContext details';
            expect(extractWaitingPerson(description)).toBe('Alex');
        });

        it('supports case-insensitive matching and full-width colon', () => {
            const description = 'waiting FOR：Jordan';
            expect(extractWaitingPerson(description)).toBe('Jordan');
        });

        it('returns null when no waiting person line exists', () => {
            expect(extractWaitingPerson('No delegation info here')).toBeNull();
        });
    });

    describe('getWaitingPerson', () => {
        it('prefers assignedTo when present', () => {
            expect(getWaitingPerson({
                assignedTo: 'Alex',
                description: 'Waiting for: Jordan',
            })).toBe('Alex');
        });

        it('falls back to the legacy description line', () => {
            expect(getWaitingPerson({
                description: 'Need follow-up\nWaiting for: Jordan',
            })).toBe('Jordan');
        });

        it('returns null when no waiting person is available', () => {
            expect(getWaitingPerson({ description: 'No delegation info here' })).toBeNull();
        });
    });

    describe('task start visibility', () => {
        const now = new Date(2026, 4, 2, 10, 0, 0, 0);

        it('does not treat tasks starting later today as future-start tasks', () => {
            expect(isTaskFutureStart({ startTime: new Date(2026, 4, 2, 22, 0, 0, 0).toISOString() }, now)).toBe(false);
        });

        it('treats tasks starting after today as future-start tasks', () => {
            expect(isTaskFutureStart({ startTime: new Date(2026, 4, 3, 0, 0, 0, 0).toISOString() }, now)).toBe(true);
        });

        it('hides future-start tasks unless the view opts into showing them', () => {
            const task = { startTime: new Date(2026, 4, 3, 0, 0, 0, 0).toISOString() };

            expect(shouldShowTaskForStart(task, { now })).toBe(false);
            expect(shouldShowTaskForStart(task, { now, showFutureStarts: true })).toBe(true);
        });
    });

    describe('getTaskFocusEligibility', () => {
        const now = new Date('2026-04-05T12:00:00.000Z');
        const makeTask = (overrides: Partial<Task>): Task => ({
            id: overrides.id ?? 'task',
            title: overrides.title ?? 'Task',
            status: overrides.status ?? 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
            ...overrides,
        });

        it('does not promote an elapsed-start someday task into Focus as next', () => {
            const task = makeTask({
                id: 'someday-started',
                status: 'someday',
                startTime: '2026-04-04T09:00:00.000Z',
            });

            expect(getTaskFocusEligibility(task, { tasks: [task], projects: [], now })).toEqual({
                eligible: false,
                reason: 'clarify',
            });
            expect(task.status).toBe('someday');
        });

        it('does not make inbox tasks Focus-eligible through review dates', () => {
            const task = makeTask({
                id: 'inbox-review',
                status: 'inbox',
                reviewAt: '2026-04-04T09:00:00.000Z',
            });

            expect(getTaskFocusEligibility(task, { tasks: [task], projects: [], now })).toEqual({
                eligible: false,
                reason: 'clarify',
            });
            expect(task.status).toBe('inbox');
        });

        it('can surface review-due waiting tasks without changing status', () => {
            const task = makeTask({
                id: 'waiting-review',
                status: 'waiting',
                reviewAt: '2026-04-04T09:00:00.000Z',
            });

            expect(getTaskFocusEligibility(task, { tasks: [task], projects: [], now })).toEqual({
                eligible: true,
                reason: 'eligible',
            });
            expect(task.status).toBe('waiting');
        });
    });

    describe('getSequentialFirstTaskIds', () => {
        it('returns the first active task per sequential project by order', () => {
            const firstTaskIds = getSequentialFirstTaskIds([
                { id: 'p1-second', projectId: 'p1', order: 2, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'p1-first', projectId: 'p1', order: 1, orderNum: undefined, createdAt: '2026-04-03T00:00:00.000Z' },
                { id: 'p2-first', projectId: 'p2', order: undefined, orderNum: undefined, createdAt: '2026-04-04T00:00:00.000Z' },
            ], new Set(['p1']));

            expect([...firstTaskIds]).toEqual(['p1-first']);
        });

        it('falls back to created time when a sequential project has no order values', () => {
            const firstTaskIds = getSequentialFirstTaskIds([
                { id: 'newer', projectId: 'p1', order: undefined, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'older', projectId: 'p1', order: undefined, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
            ], new Set(['p1']));

            expect([...firstTaskIds]).toEqual(['older']);
        });

        it('returns the first active task per section for section-scoped sequential projects', () => {
            const firstTaskIds = getSequentialFirstTaskIds([
                { id: 'phase-a-second', projectId: 'p1', sectionId: 'section-a', order: 2, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'phase-a-first', projectId: 'p1', sectionId: 'section-a', order: 1, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                { id: 'phase-b-first', projectId: 'p1', sectionId: 'section-b', order: 3, orderNum: undefined, createdAt: '2026-04-03T00:00:00.000Z' },
                { id: 'phase-b-second', projectId: 'p1', sectionId: 'section-b', order: 4, orderNum: undefined, createdAt: '2026-04-04T00:00:00.000Z' },
            ], new Set(['p1']), { sectionScopedProjectIds: new Set(['p1']) });

            expect([...firstTaskIds]).toEqual(['phase-a-first', 'phase-b-first']);
        });
    });

    describe('getFocusSequentialFirstTaskIds', () => {
        const now = new Date('2026-04-05T12:00:00.000Z');

        it('skips earlier non-Focus tasks when picking the first sequential candidate', () => {
            const firstTaskIds = getFocusSequentialFirstTaskIds([
                { id: 'inbox-before', projectId: 'p1', status: 'inbox', order: 0, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                { id: 'waiting-before', projectId: 'p1', status: 'waiting', order: 1, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'next-visible', projectId: 'p1', status: 'next', order: 2, orderNum: undefined, createdAt: '2026-04-03T00:00:00.000Z' },
            ], new Set(['p1']), { now });

            expect([...firstTaskIds]).toEqual(['next-visible']);
        });

        it('keeps review-due and today-focus tasks in the sequential candidate set', () => {
            const reviewFirstIds = getFocusSequentialFirstTaskIds([
                { id: 'waiting-review', projectId: 'p1', status: 'waiting', reviewAt: '2026-04-04T00:00:00.000Z', order: 0, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                { id: 'next-after-review', projectId: 'p1', status: 'next', order: 1, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
            ], new Set(['p1']), { now });

            const focusedFirstIds = getFocusSequentialFirstTaskIds([
                { id: 'focused-waiting', projectId: 'p2', status: 'waiting', isFocusedToday: true, order: 0, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                { id: 'next-after-focused', projectId: 'p2', status: 'next', order: 1, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
            ], new Set(['p2']), { now });

            expect([...reviewFirstIds]).toEqual(['waiting-review']);
            expect([...focusedFirstIds]).toEqual(['focused-waiting']);
        });

        it('prioritizes scheduled candidates due today over older undated next actions', () => {
            const firstTaskIds = getFocusSequentialFirstTaskIds([
                { id: 'normal-next', projectId: 'p1', status: 'next', order: 1, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                {
                    id: 'duplicated-scheduled',
                    projectId: 'p1',
                    status: 'next',
                    dueDate: '2026-04-05T15:00:00.000Z',
                    order: 2,
                    orderNum: undefined,
                    createdAt: '2026-04-05T13:00:00.000Z',
                },
            ], new Set(['p1']), { now });

            expect([...firstTaskIds]).toEqual(['duplicated-scheduled']);
        });

        it('keeps future-start tasks in sequence order instead of exposing later actions', () => {
            const firstTaskIds = getFocusSequentialFirstTaskIds([
                {
                    id: 'future-start',
                    projectId: 'p1',
                    status: 'next',
                    startTime: '2026-04-06T09:00:00.000Z',
                    order: 0,
                    orderNum: undefined,
                    createdAt: '2026-04-01T00:00:00.000Z',
                },
                { id: 'following-next', projectId: 'p1', status: 'next', order: 1, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
            ], new Set(['p1']), { now });

            expect([...firstTaskIds]).toEqual(['future-start']);
        });

        it('returns the first Focus candidate from each section when the sequential project is section-scoped', () => {
            const firstTaskIds = getFocusSequentialFirstTaskIds([
                { id: 'section-a-first', projectId: 'p1', sectionId: 'section-a', status: 'next', order: 1, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
                { id: 'section-a-second', projectId: 'p1', sectionId: 'section-a', status: 'next', order: 2, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'section-b-first', projectId: 'p1', sectionId: 'section-b', status: 'next', order: 3, orderNum: undefined, createdAt: '2026-04-03T00:00:00.000Z' },
            ], new Set(['p1']), { now, sectionScopedProjectIds: new Set(['p1']) });

            expect([...firstTaskIds]).toEqual(['section-a-first', 'section-b-first']);
        });
    });

    describe('sortTasksByBoardOrder', () => {
        const boardTask = (id: string, boardOrder?: number) => ({ id, boardOrder });

        it('sorts tasks with boardOrder ascending ahead of tasks without one', () => {
            const sorted = sortTasksByBoardOrder([
                boardTask('no-order-1'),
                boardTask('third', 2),
                boardTask('first', 0),
                boardTask('no-order-2'),
                boardTask('second', 1),
            ]);

            expect(sorted.map((task) => task.id)).toEqual(['first', 'second', 'third', 'no-order-1', 'no-order-2']);
        });

        it('keeps the incoming order when no task has a boardOrder', () => {
            const input = [boardTask('a'), boardTask('b'), boardTask('c')];

            const sorted = sortTasksByBoardOrder(input);

            expect(sorted.map((task) => task.id)).toEqual(['a', 'b', 'c']);
        });
    });
});
