import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
    buildTasksByProjectId,
    getProjectDeadlineBoosts,
    sortFocusNextActions,
    sortTasksBy,
} from './task-utils';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { buildEntityMap } from './store-helpers';
import type {
    Project,
    Section,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

type LargeStoreSize = 1_000 | 10_000 | 50_000;

type ProjectTaskSummary = {
    activeTaskCount: number;
    nextAction?: Task;
};

type LargeStoreFixture = {
    projectCount: number;
    projects: Project[];
    sections: Section[];
    selectedProjectId: string;
    targetTaskId: string;
    taskIndexById: Map<string, number>;
    tasks: Task[];
    tasksById: Map<string, Task>;
};

type BudgetedOperationId =
    | 'projectDetailLookupAndSort'
    | 'projectSummaryAggregation'
    | 'focusDerivation'
    | 'searchFilterSort'
    | 'oneTaskNormalizedUpdate';

type BudgetedOperation = {
    id: BudgetedOperationId;
    label: string;
    maxGrowthFrom10kTo50k: number;
    run: (fixture: LargeStoreFixture) => number;
};

const DATASET_SIZES: LargeStoreSize[] = [1_000, 10_000, 50_000];
const BASE_ISO = '2026-06-01T09:00:00.000Z';
const NOW = new Date('2026-06-06T12:00:00.000Z');
const SECTIONS_PER_PROJECT = 2;
const SEARCH_QUERY = 'alpha';

const CONTEXTS = ['@home', '@work', '@errands', '@calls', '@computer', '@deep-work'];
const TAGS = ['#admin', '#writing', '#health', '#finance', '#planning', '#follow-up'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVELS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const TIME_ESTIMATES: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

const GROWTH_BASELINE_FLOOR_MS = 5;

const LARGE_STORE_PERFORMANCE_BUDGETS_MS: Record<LargeStoreSize, Record<BudgetedOperationId, number>> = {
    1_000: {
        projectDetailLookupAndSort: 25,
        projectSummaryAggregation: 20,
        focusDerivation: 40,
        searchFilterSort: 30,
        oneTaskNormalizedUpdate: 20,
    },
    10_000: {
        projectDetailLookupAndSort: 90,
        projectSummaryAggregation: 70,
        focusDerivation: 500,
        searchFilterSort: 130,
        oneTaskNormalizedUpdate: 80,
    },
    50_000: {
        projectDetailLookupAndSort: 450,
        projectSummaryAggregation: 300,
        focusDerivation: 2_500,
        searchFilterSort: 650,
        oneTaskNormalizedUpdate: 350,
    },
};

function createProject(index: number, selectedProjectId: string): Project {
    const id = index === 0 ? selectedProjectId : `project-${index}`;
    return {
        id,
        title: index === 0 ? 'Selected Project' : `Project ${index}`,
        status: index % 19 === 0 ? 'waiting' : index % 23 === 0 ? 'someday' : 'active',
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5],
        order: index,
        tagIds: [TAGS[index % TAGS.length]],
        dueDate: index % 5 === 0 ? `2026-06-${String((index % 6) + 1).padStart(2, '0')}T17:00:00.000Z` : undefined,
        isFocused: index % 13 === 0,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    };
}

function createSection(project: Project, index: number): Section {
    return {
        id: `section-${project.id}-${index}`,
        projectId: project.id,
        title: `Section ${index + 1}`,
        order: index,
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    };
}

function getSyntheticTaskStatus(index: number): TaskStatus {
    if (index % 29 === 0) return 'archived';
    if (index % 23 === 0) return 'reference';
    if (index % 11 === 0) return 'done';
    if (index % 7 === 0) return 'waiting';
    if (index % 5 === 0) return 'inbox';
    return 'next';
}

function createLargeStoreFixture(taskCount: LargeStoreSize): LargeStoreFixture {
    const selectedProjectId = 'project-selected';
    const projectCount = Math.max(40, Math.min(500, Math.floor(taskCount / 40)));
    const selectedProjectTaskCount = Math.min(2_000, Math.max(150, Math.floor(taskCount / 4)));
    const projects = Array.from({ length: projectCount }, (_, index) => createProject(index, selectedProjectId));
    const sections = projects.flatMap((project) => (
        Array.from({ length: SECTIONS_PER_PROJECT }, (_, index) => createSection(project, index))
    ));
    const tasks: Task[] = [];

    for (let index = 0; index < taskCount; index += 1) {
        const projectIndex = index < selectedProjectTaskCount
            ? 0
            : 1 + ((index - selectedProjectTaskCount) % Math.max(1, projectCount - 1));
        const project = projects[projectIndex];
        const section = sections[projectIndex * SECTIONS_PER_PROJECT + (index % SECTIONS_PER_PROJECT)];
        const status = getSyntheticTaskStatus(index);
        const titleToken = index % 17 === 0 ? ` ${SEARCH_QUERY}` : '';

        tasks.push({
            id: `task-${index}`,
            title: `Synthetic${titleToken} task ${index}`,
            status,
            priority: PRIORITIES[index % PRIORITIES.length],
            energyLevel: ENERGY_LEVELS[index % ENERGY_LEVELS.length],
            taskMode: index % 31 === 0 ? 'list' : 'task',
            startTime: index % 37 === 0 ? `2026-06-${String((index % 9) + 1).padStart(2, '0')}T08:00:00.000Z` : undefined,
            dueDate: index % 3 === 0 ? `2026-06-${String((index % 12) + 1).padStart(2, '0')}T17:00:00.000Z` : undefined,
            tags: [
                TAGS[index % TAGS.length],
                TAGS[(index + 3) % TAGS.length],
            ],
            contexts: [CONTEXTS[index % CONTEXTS.length]],
            checklist: index % 41 === 0
                ? [
                    { id: `check-${index}-1`, title: 'First step', isCompleted: index % 2 === 0 },
                    { id: `check-${index}-2`, title: 'Second step', isCompleted: false },
                ]
                : undefined,
            projectId: project.id,
            sectionId: section.id,
            areaId: `area-${index % 5}`,
            isFocusedToday: index % 97 === 0,
            timeEstimate: TIME_ESTIMATES[index % TIME_ESTIMATES.length],
            completedAt: status === 'done' || status === 'archived' ? '2026-06-02T09:00:00.000Z' : undefined,
            deletedAt: index % 503 === 0 ? '2026-06-03T09:00:00.000Z' : undefined,
            order: index,
            orderNum: index,
            createdAt: BASE_ISO,
            updatedAt: `2026-06-${String((index % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
            rev: 1,
            revBy: 'perf-suite',
        });
    }

    const taskIndexById = new Map<string, number>();
    const tasksById = new Map<string, Task>();
    tasks.forEach((task, index) => {
        taskIndexById.set(task.id, index);
        tasksById.set(task.id, task);
    });

    return {
        projectCount,
        projects,
        sections,
        selectedProjectId,
        targetTaskId: tasks[Math.floor(taskCount * 0.73)].id,
        taskIndexById,
        tasks,
        tasksById,
    };
}

function buildProjectTaskSummaryById(tasks: readonly Task[]): Map<string, ProjectTaskSummary> {
    const summaries = new Map<string, ProjectTaskSummary>();

    tasks.forEach((task) => {
        if (
            !task.projectId ||
            task.deletedAt ||
            task.status === 'done' ||
            task.status === 'reference' ||
            task.status === 'archived'
        ) {
            return;
        }

        const existing = summaries.get(task.projectId);
        if (existing) {
            existing.activeTaskCount += 1;
            if (!existing.nextAction && task.status === 'next') existing.nextAction = task;
        } else {
            summaries.set(task.projectId, {
                activeTaskCount: 1,
                nextAction: task.status === 'next' ? task : undefined,
            });
        }
    });

    return summaries;
}

function measureBest(operation: () => number, attempts = 3): { durationMs: number; value: number } {
    let bestDurationMs = Number.POSITIVE_INFINITY;
    let bestValue = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const startedAt = performance.now();
        const value = operation();
        const durationMs = performance.now() - startedAt;
        if (durationMs < bestDurationMs) {
            bestDurationMs = durationMs;
            bestValue = value;
        }
    }

    return { durationMs: bestDurationMs, value: bestValue };
}

function expectWithinBudget(label: string, size: LargeStoreSize, actualMs: number, budgetMs: number) {
    expect(
        actualMs,
        `${label} took ${actualMs.toFixed(2)}ms with ${size.toLocaleString()} tasks; budget is ${budgetMs}ms`,
    ).toBeLessThanOrEqual(budgetMs);
}

const operations: BudgetedOperation[] = [
    {
        id: 'projectDetailLookupAndSort',
        label: 'Project detail lookup and sort',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const tasksByProjectId = buildTasksByProjectId(fixture.tasks);
            const selectedProjectTasks = tasksByProjectId.get(fixture.selectedProjectId) ?? [];
            return sortTasksBy(selectedProjectTasks, 'due').slice(0, 100).length;
        },
    },
    {
        id: 'projectSummaryAggregation',
        label: 'Project summary aggregation',
        maxGrowthFrom10kTo50k: 10,
        run: (fixture) => buildProjectTaskSummaryById(fixture.tasks).size,
    },
    {
        id: 'focusDerivation',
        label: 'Focus derivation',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const projectDeadlineBoosts = getProjectDeadlineBoosts(fixture.tasks, fixture.projects, { now: NOW });
            const candidateTasks = fixture.tasks.filter((task) => !task.deletedAt && task.status === 'next');
            return sortFocusNextActions(candidateTasks, {
                now: NOW,
                projectDeadlineBoosts,
                projects: fixture.projects,
            }).slice(0, 100).length;
        },
    },
    {
        id: 'searchFilterSort',
        label: 'Search/filter/sort derivation',
        maxGrowthFrom10kTo50k: 12,
        run: (fixture) => {
            const filteredTasks = fixture.tasks.filter((task) => (
                !task.deletedAt &&
                task.status !== 'archived' &&
                task.title.toLowerCase().includes(SEARCH_QUERY)
            ));
            return sortTasksBy(filteredTasks, 'updated').slice(0, 100).length;
        },
    },
    {
        id: 'oneTaskNormalizedUpdate',
        label: 'One-task normalized update',
        maxGrowthFrom10kTo50k: 10,
        run: (fixture) => {
            const targetIndex = fixture.taskIndexById.get(fixture.targetTaskId);
            if (targetIndex === undefined) throw new Error(`Missing target task ${fixture.targetTaskId}`);

            const oldTask = fixture.tasks[targetIndex];
            const updatedTask = {
                ...oldTask,
                title: `${oldTask.title} updated`,
                updatedAt: '2026-06-06T12:30:00.000Z',
            };
            const nextTasks = fixture.tasks.slice();
            nextTasks[targetIndex] = updatedTask;
            const nextTasksById = new Map(fixture.tasksById);
            nextTasksById.set(updatedTask.id, updatedTask);

            return nextTasks[targetIndex] === nextTasksById.get(updatedTask.id) ? 1 : 0;
        },
    },
];

const describePerf = process.env.MINDWTR_PERF_TEST === '1' ? describe : describe.skip;

describePerf('large-store performance budgets', () => {
    it('keeps generated core hot paths within explicit budgets', () => {
        const measurements = new Map<BudgetedOperationId, Map<LargeStoreSize, number>>();

        DATASET_SIZES.forEach((size) => {
            const fixture = createLargeStoreFixture(size);

            expect(fixture.tasks).toHaveLength(size);
            expect(fixture.projects).toHaveLength(fixture.projectCount);

            operations.forEach((operation) => {
                const result = measureBest(() => operation.run(fixture));
                expect(result.value, `${operation.label} should produce a non-empty result`).toBeGreaterThan(0);
                expectWithinBudget(
                    operation.label,
                    size,
                    result.durationMs,
                    LARGE_STORE_PERFORMANCE_BUDGETS_MS[size][operation.id],
                );

                const operationMeasurements = measurements.get(operation.id) ?? new Map<LargeStoreSize, number>();
                operationMeasurements.set(size, result.durationMs);
                measurements.set(operation.id, operationMeasurements);
            });
        });

        operations.forEach((operation) => {
            const operationMeasurements = measurements.get(operation.id);
            const tenKDuration = operationMeasurements?.get(10_000);
            const fiftyKDuration = operationMeasurements?.get(50_000);
            if (tenKDuration === undefined || fiftyKDuration === undefined) {
                throw new Error(`Missing measurements for ${operation.label}`);
            }

            const growth = fiftyKDuration / Math.max(tenKDuration, GROWTH_BASELINE_FLOOR_MS);
            expect(
                growth,
                `${operation.label} grew ${growth.toFixed(2)}x from 10k to 50k tasks; max allowed is ${operation.maxGrowthFrom10kTo50k}x`,
            ).toBeLessThanOrEqual(operation.maxGrowthFrom10kTo50k);
        });
    });

    it('persists one task through the incremental path on a 50k-task store', async () => {
        const fixture = createLargeStoreFixture(50_000);
        let saveDataCalls = 0;
        let savedTask: Task | null = null;
        setStorageAdapter({
            getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData: async () => {
                saveDataCalls += 1;
            },
            saveTask: async (task) => {
                savedTask = task;
            },
        });
        useTaskStore.setState({
            tasks: fixture.tasks,
            projects: fixture.projects,
            sections: fixture.sections,
            areas: [],
            settings: {},
            isLoading: false,
            error: null,
            _allTasks: fixture.tasks,
            _allProjects: fixture.projects,
            _allSections: fixture.sections,
            _allAreas: [],
            _tasksById: buildEntityMap(fixture.tasks),
            _projectsById: buildEntityMap(fixture.projects),
            _sectionsById: buildEntityMap(fixture.sections),
            _areasById: new Map(),
        });

        try {
            const startedAt = performance.now();
            const result = await useTaskStore.getState().updateTask(fixture.targetTaskId, {
                title: 'Incrementally persisted task',
            });
            const durationMs = performance.now() - startedAt;
            await Promise.resolve();

            expect(result).toEqual({ success: true });
            expect(savedTask).toMatchObject({
                id: fixture.targetTaskId,
                title: 'Incrementally persisted task',
            });
            expect(saveDataCalls).toBe(0);
            expectWithinBudget('One-task incremental persisted update', 50_000, durationMs, 1_000);
        } finally {
            await flushPendingSave();
            resetForTests();
        }
    });
});
