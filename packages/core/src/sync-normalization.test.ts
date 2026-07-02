import { describe, expect, it, vi } from 'vitest';
import { CLOCK_SKEW_THRESHOLD_MS, SYNC_REPAIR_REV_BY, mergeAppData, mergeAppDataWithStats } from './sync';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import {
    normalizeAreaForSyncMerge,
    normalizeAppData,
    normalizeProjectForSyncMerge,
    normalizeRevisionMetadata,
    normalizeTaskForSyncMerge,
    repairMergedSyncReferences,
    validateMergedSyncData,
} from './sync-normalization';
import { createMockArea, createMockProject, createMockSection, createMockTask, mockAppData } from './sync-test-utils';
import type { AppData, Area, Project, Section, Task } from './types';

const NOW = '2026-01-01T00:00:00.000Z';

describe('normalizeTaskForSyncMerge repeatReminderMinutes', () => {
    const taskWith = (repeatReminderMinutes: number): Task => ({
        id: 't', title: 't', status: 'next', tags: [], contexts: [],
        createdAt: NOW, updatedAt: NOW, repeatReminderMinutes,
    });

    it('coerces an out-of-range repeatReminderMinutes to undefined', () => {
        const task = normalizeTaskForSyncMerge(taskWith(7), NOW);
        expect(task.repeatReminderMinutes).toBeUndefined();
    });

    it('preserves a valid repeatReminderMinutes', () => {
        const task = normalizeTaskForSyncMerge(taskWith(15), NOW);
        expect(task.repeatReminderMinutes).toBe(15);
    });

    it('drops unknown legacy task fields', () => {
        const task = normalizeTaskForSyncMerge({
            ...taskWith(15),
            removedLegacyField: 'stale remote value',
        } as Task & Record<string, unknown>, NOW) as Task & Record<string, unknown>;

        expect(task.removedLegacyField).toBeUndefined();
    });
});

const normalizeForMerge = (data: AppData, nowIso = NOW): AppData => {
    const normalized = normalizeAppData(data);
    return {
        ...normalized,
        tasks: normalized.tasks.map((task) => normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, nowIso))),
        projects: normalized.projects.map((project) => normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))),
        sections: normalized.sections.map((section) => normalizeRevisionMetadata(section)),
        areas: normalized.areas.map((area) => normalizeRevisionMetadata(normalizeAreaForSyncMerge(area, nowIso))),
    };
};

describe('sync normalization', () => {
    it('normalizes malformed entity fields idempotently before merge', () => {
        const task = {
            ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
            tags: ['home', 3, null],
            contexts: ['work', false],
            sectionId: '   ',
            isFocusedToday: 'yes',
            rev: 3,
            revBy: ' device-a ',
        } as unknown as Task;
        const project = {
            ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
            status: 'SOMEDAY',
            color: '',
            tagIds: ['tag-1', 42],
            areaId: '',
            areaTitle: '   ',
            isSequential: 'true',
            sequentialScope: 'not-a-scope',
        } as unknown as Project;
        const area = {
            ...createMockArea('area-1', '2025-12-31T23:00:00.000Z'),
            color: '',
            icon: '',
            order: Number.NaN,
        } satisfies Area;
        const data: AppData = {
            tasks: [task],
            projects: [project],
            sections: [createMockSection('section-1', 'project-1', '2025-12-31T23:00:00.000Z')],
            areas: [area],
            settings: {},
        };

        const once = normalizeForMerge(data);
        const twice = normalizeForMerge(once);

        expect(twice).toEqual(once);
        expect(once.tasks[0]).toMatchObject({
            tags: ['home'],
            contexts: ['work'],
            sectionId: undefined,
            isFocusedToday: false,
            rev: 3,
            revBy: 'device-a',
        });
        expect(once.projects[0]).toMatchObject({
            status: 'someday',
            color: '#6B7280',
            tagIds: ['tag-1'],
            areaId: undefined,
            areaTitle: undefined,
            isSequential: false,
            sequentialScope: undefined,
        });
        expect(once.areas[0]).toMatchObject({
            color: undefined,
            icon: undefined,
            order: undefined,
        });
    });

    it('strips invalid revision metadata and validates malformed revisions', () => {
        expect(normalizeRevisionMetadata({ rev: '4', revBy: 'device-a' })).toEqual({ revBy: 'device-a' });
        expect(normalizeRevisionMetadata({ rev: 4, revBy: ' device-a ' })).toEqual({ rev: 4, revBy: 'device-a' });
        expect(normalizeRevisionMetadata({ rev: -1, revBy: '   ' })).toEqual({});

        const invalidData = {
            tasks: [{
                ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
                rev: -1,
                revBy: '',
            }],
            projects: [{
                ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
                rev: 1.5,
                revBy: ['device-a'],
            }],
            sections: [{
                ...createMockSection('section-1', 'project-1', '2025-12-31T23:00:00.000Z'),
                rev: Number.POSITIVE_INFINITY,
                revBy: 42,
            }],
            areas: [{
                ...createMockArea('area-1', '2025-12-31T23:00:00.000Z'),
                rev: '2',
                revBy: '   ',
            }],
            settings: {},
        } as unknown as AppData;

        expect(validateMergedSyncData(invalidData)).toEqual(expect.arrayContaining([
            'tasks[0].rev must be a non-negative integer when present',
            'tasks[0].revBy must be a non-empty string when present',
            'projects[0].rev must be a non-negative integer when present',
            'projects[0].revBy must be a non-empty string when present',
            'sections[0].rev must be a non-negative integer when present',
            'sections[0].revBy must be a non-empty string when present',
            'areas[0].rev must be a non-negative integer when present',
            'areas[0].revBy must be a non-empty string when present',
        ]));
    });

    it('clears focus flags from tasks with future start dates during merge normalization', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            status: 'next',
            startTime: '2026-01-03',
            isFocusedToday: true,
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-01-01T10:00:00.000Z');

        expect(normalized.startTime).toBe('2026-01-03');
        expect(normalized.isFocusedToday).toBe(false);
    });

    it('detects date incoherence from incoming synced tasks without mutating dates', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            status: 'next',
            dueDate: '2026-04-24',
            startTime: '2026-04-25',
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-04-20T10:00:00.000Z');

        expect(getTaskDateCoherenceIssues(normalized)).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
        expect(normalized.startTime).toBe('2026-04-25');
        expect(normalized.dueDate).toBe('2026-04-24');
    });

    it('sanitizes synced task attachment URIs and cloud keys during normalization', () => {
        const task = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z'),
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'Unsafe',
                    uri: 'file:///safe/%252e%252e/secret.txt',
                    cloudKey: '../attachments/secret.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    id: 'att-2',
                    kind: 'file',
                    title: 'Safe',
                    uri: 'file:///local/attachments/safe.txt',
                    cloudKey: 'attachments/att-2.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } satisfies Task;

        const normalized = normalizeTaskForSyncMerge(task, '2026-04-20T10:00:00.000Z');

        expect(normalized.attachments?.[0]?.uri).toBe('');
        expect(normalized.attachments?.[0]?.cloudKey).toBeUndefined();
        expect(normalized.attachments?.[1]?.uri).toBe('file:///local/attachments/safe.txt');
        expect(normalized.attachments?.[1]?.cloudKey).toBe('attachments/att-2.txt');
    });

    it('sanitizes synced project attachment cloud keys during normalization', () => {
        const project = {
            ...createMockProject('project-1', '2026-01-01T00:00:00.000Z'),
            attachments: [
                {
                    id: 'att-1',
                    kind: 'file',
                    title: 'Unsafe',
                    uri: '/tmp/safe.txt',
                    cloudKey: 'attachments/../secret.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } satisfies Project;

        const normalized = normalizeProjectForSyncMerge(project);

        expect(normalized.attachments?.[0]?.uri).toBe('/tmp/safe.txt');
        expect(normalized.attachments?.[0]?.cloudKey).toBeUndefined();
    });

    it('does not let one-sided revBy metadata decide equal-revision conflicts', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const local = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'zz local deterministic winner',
            rev: 7,
        }]);
        const incoming = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'aa incoming has revBy',
            rev: 7,
            revBy: 'device-z',
        }]);

        const forward = mergeAppDataWithStats(local, incoming, { nowIso: NOW });
        const reverse = mergeAppDataWithStats(incoming, local, { nowIso: NOW });

        expect(forward.data.tasks[0].title).toBe('zz local deterministic winner');
        expect(reverse.data.tasks[0].title).toBe('zz local deterministic winner');
        expect(forward.stats.tasks.conflictReasonCounts?.content).toBe(1);
    });

    it('uses deterministic ordering when timestamps and revision metadata both match', () => {
        const updatedAt = '2026-01-01T00:00:00.000Z';
        const left = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'aa lower signature',
            rev: 8,
            revBy: 'device-a',
        }]);
        const right = mockAppData([{
            ...createMockTask('task-1', updatedAt),
            title: 'zz higher signature',
            rev: 8,
            revBy: 'device-a',
        }]);

        const forward = mergeAppDataWithStats(left, right, { nowIso: NOW });
        const reverse = mergeAppDataWithStats(right, left, { nowIso: NOW });

        expect(forward.data.tasks[0].title).toBe('zz higher signature');
        expect(reverse.data.tasks[0].title).toBe('zz higher signature');
    });

    it('keeps normalize merge normalize round trips idempotent', () => {
        const local = normalizeForMerge(mockAppData([
            {
                ...createMockTask('task-1', '2026-01-01T01:00:00.000Z'),
                title: 'Local title',
                tags: ['one', 2],
                rev: 2,
                revBy: 'local-device',
            } as unknown as Task,
        ], [
            {
                ...createMockProject('project-1', '2026-01-01T00:30:00.000Z'),
                status: 'WAITING',
                rev: 2,
                revBy: 'local-device',
            } as unknown as Project,
        ]));
        const incoming = normalizeForMerge(mockAppData([
            {
                ...createMockTask('task-1', '2026-01-01T02:00:00.000Z'),
                title: 'Incoming title',
                contexts: ['office', null],
                rev: 3,
                revBy: 'incoming-device',
            } as unknown as Task,
        ], [
            {
                ...createMockProject('project-1', '2026-01-01T02:00:00.000Z'),
                status: 'ACTIVE',
                tagIds: ['tag-a', null],
                rev: 3,
                revBy: 'incoming-device',
            } as unknown as Project,
        ]));

        const merged = mergeAppData(local, incoming, { nowIso: NOW });
        const normalizedAfterMerge = normalizeForMerge(merged);
        const mergedAgain = mergeAppData(normalizedAfterMerge, normalizedAfterMerge, { nowIso: NOW });

        expect(normalizeForMerge(mergedAgain)).toEqual(normalizedAfterMerge);
        expect(validateMergedSyncData(normalizedAfterMerge)).toEqual([]);
    });

    it('repairs deleted area project section references once and preserves tombstones', () => {
        const data: AppData = {
            tasks: [{
                ...createMockTask('task-1', '2025-12-31T23:00:00.000Z'),
                projectId: 'deleted-project',
                sectionId: 'deleted-project-section',
                areaId: 'deleted-area',
                order: 1,
                orderNum: 1,
                rev: 5,
                revBy: 'device-a',
            }],
            projects: [
                {
                    ...createMockProject('project-1', '2025-12-31T23:00:00.000Z'),
                    areaId: 'deleted-area',
                    areaTitle: 'Deleted area',
                    rev: 5,
                    revBy: 'device-a',
                },
                createMockProject('deleted-project', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ],
            sections: [
                createMockSection('deleted-project-section', 'deleted-project', '2025-12-31T23:00:00.000Z'),
            ],
            areas: [
                createMockArea('deleted-area', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ],
            settings: {},
        };

        const repaired = repairMergedSyncReferences(data, NOW);
        const repairedAgain = repairMergedSyncReferences(repaired, '2026-01-02T00:00:00.000Z');

        expect(repairedAgain).toEqual(repaired);
        expect(repaired.projects[0]).toMatchObject({
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: NOW,
            rev: 6,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.sections[0]).toMatchObject({
            deletedAt: NOW,
            updatedAt: NOW,
            rev: 1,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.tasks[0]).toMatchObject({
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            order: undefined,
            orderNum: undefined,
            updatedAt: NOW,
            rev: 6,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.areas[0].deletedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('repairs missing task container references once before sync persistence', () => {
        const data: AppData = {
            tasks: [{
                ...createMockTask('task-missing-container', '2025-12-31T23:00:00.000Z'),
                projectId: 'missing-project',
                sectionId: 'missing-section',
                areaId: 'missing-area',
                order: 4,
                orderNum: 4,
                rev: 9,
                revBy: 'device-a',
            }],
            projects: [{
                ...createMockProject('project-missing-area', '2025-12-31T23:00:00.000Z'),
                areaId: 'missing-area',
                areaTitle: 'Missing area',
                rev: 3,
                revBy: 'device-a',
            }],
            sections: [],
            areas: [],
            settings: {},
        };

        const repaired = repairMergedSyncReferences(data, NOW);
        const repairedAgain = repairMergedSyncReferences(repaired, '2026-01-02T00:00:00.000Z');

        expect(repairedAgain).toEqual(repaired);
        expect(repaired.projects[0]).toMatchObject({
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: NOW,
            rev: 4,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(repaired.tasks[0]).toMatchObject({
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            order: undefined,
            orderNum: undefined,
            updatedAt: NOW,
            rev: 10,
            revBy: SYNC_REPAIR_REV_BY,
        });
        expect(validateMergedSyncData(repaired)).toEqual([]);
    });

    it('reports missing parent references during sync validation', () => {
        const invalidData: AppData = {
            tasks: [{
                ...createMockTask('task-missing-parents', '2025-12-31T23:00:00.000Z'),
                projectId: 'missing-project',
                sectionId: 'missing-section',
                areaId: 'missing-area',
            }],
            projects: [{
                ...createMockProject('project-missing-area', '2025-12-31T23:00:00.000Z'),
                areaId: 'missing-area',
            }],
            sections: [{
                ...createMockSection('section-missing-project', 'missing-project', '2025-12-31T23:00:00.000Z'),
            }],
            areas: [],
            settings: {},
        };

        expect(validateMergedSyncData(invalidData)).toEqual(expect.arrayContaining([
            'projects[0].areaId must reference an existing area',
            'sections[0].projectId must reference an existing project',
            'tasks[0].projectId must reference an existing project',
            'tasks[0].areaId must reference an existing area',
            'tasks[0].sectionId must reference an existing section',
        ]));
    });

    it('clamps adversarial future timestamps during merge comparison', () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date(NOW).getTime());
        try {
            const local = mockAppData([
                createMockTask('task-1', '2099-01-01T00:00:00.000Z'),
            ]);
            const incoming = mockAppData([
                createMockTask('task-1', NOW),
            ]);

            const result = mergeAppDataWithStats(local, incoming, { nowIso: NOW });

            expect(result.stats.tasks.maxClockSkewMs).toBeLessThanOrEqual(CLOCK_SKEW_THRESHOLD_MS);
            expect(validateMergedSyncData(result.data)).toEqual([]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('does not report clock skew at the warning boundary', () => {
        const localUpdatedAt = '2026-01-01T00:00:00.000Z';
        const incomingUpdatedAt = new Date(Date.parse(localUpdatedAt) + CLOCK_SKEW_THRESHOLD_MS).toISOString();
        const result = mergeAppDataWithStats(
            mockAppData([{ ...createMockTask('task-1', localUpdatedAt), title: 'Local title' }]),
            mockAppData([{ ...createMockTask('task-1', incomingUpdatedAt), title: 'Incoming title' }]),
            { nowIso: NOW },
        );

        expect(result.stats.tasks.maxClockSkewMs).toBe(CLOCK_SKEW_THRESHOLD_MS);
        expect(result.clockSkewWarning).toBeUndefined();
    });

    it('preserves a live undelete when it is newer than a remote tombstone', () => {
        const deleted = {
            ...createMockTask('task-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            title: 'Deleted copy',
        };
        const undeleted = {
            ...createMockTask('task-1', '2026-01-01T00:02:00.000Z'),
            title: 'Restored copy',
        };

        const forward = mergeAppData(mockAppData([deleted]), mockAppData([undeleted]), { nowIso: NOW });
        const reverse = mergeAppData(mockAppData([undeleted]), mockAppData([deleted]), { nowIso: NOW });

        expect(forward.tasks[0]).toMatchObject({
            title: 'Restored copy',
            deletedAt: undefined,
        });
        expect(reverse.tasks[0]).toMatchObject({
            title: 'Restored copy',
            deletedAt: undefined,
        });
    });
});
