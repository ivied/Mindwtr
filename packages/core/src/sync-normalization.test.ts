import { describe, expect, it, vi } from 'vitest';
import { CLOCK_SKEW_THRESHOLD_MS, SYNC_REPAIR_REV_BY, mergeAppData, mergeAppDataWithStats } from './sync';
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
