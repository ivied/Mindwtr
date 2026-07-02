import { describe, expect, it } from 'vitest';

import {
    createBackupFileName,
    prepareRestoredBackupDataForSync,
    serializeBackupData,
    validateBackupJson,
} from './backup-transfer';
import { mergeAppData } from './sync';
import { SYNC_BACKUP_RESTORE_REV_BY } from './sync-revision';
import type { AppData } from './types';

const buildAppData = (): AppData => {
    const now = '2026-03-30T12:00:00.000Z';
    return {
        tasks: [
            {
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: now,
                updatedAt: now,
            },
        ],
        projects: [
            {
                id: 'project-1',
                title: 'Project',
                status: 'active',
                color: '#94a3b8',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
    };
};

describe('backup transfer', () => {
    it('validates a serialized backup and derives metadata from the file name', () => {
        const data = buildAppData();
        const fileName = createBackupFileName(new Date('2026-03-30T12:34:56.789Z'));
        const result = validateBackupJson(serializeBackupData(data), { fileName });

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(data);
        expect(result.metadata?.taskCount).toBe(1);
        expect(result.metadata?.projectCount).toBe(1);
        expect(result.metadata?.backupAt).toBe('2026-03-30T12:34:56.789Z');
        expect(result.warnings).toEqual([]);
    });

    it('rejects non-Mindwtr JSON payloads', () => {
        const result = validateBackupJson(JSON.stringify({
            tasks: {},
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }), {
            fileName: 'package.json',
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('tasks');
    });

    it('marks restored live backup records as fresh local sync operations', () => {
        const data = buildAppData();
        const restoredAt = '2026-04-01T00:00:10.000Z';
        data.areas = [{
            id: 'area-1',
            name: 'Area',
            order: 0,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.people = [{
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.projects[0] = {
            ...data.projects[0],
            areaId: 'area-1',
            rev: 4,
            revBy: 'old-device',
        };
        data.sections = [{
            id: 'section-1',
            projectId: 'project-1',
            title: 'Section',
            description: '',
            order: 0,
            isCollapsed: false,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        data.tasks[0] = {
            ...data.tasks[0],
            areaId: 'area-1',
            projectId: 'project-1',
            sectionId: 'section-1',
            rev: 4,
            revBy: 'old-device',
        };
        data.tasks.push({
            ...data.tasks[0],
            id: 'deleted-task',
            title: 'Deleted task',
            deletedAt: '2026-03-31T00:00:00.000Z',
            updatedAt: '2026-03-31T00:00:00.000Z',
            rev: 8,
            revBy: 'delete-device',
        });

        const restored = prepareRestoredBackupDataForSync(data, { restoredAt });

        expect(restored.tasks.find((task) => task.id === 'task-1')).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.projects[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.sections[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.areas[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.people?.[0]).toMatchObject({
            updatedAt: restoredAt,
            rev: 5,
            revBy: SYNC_BACKUP_RESTORE_REV_BY,
        });
        expect(restored.tasks.find((task) => task.id === 'deleted-task')).toMatchObject({
            updatedAt: '2026-03-31T00:00:00.000Z',
            rev: 8,
            revBy: 'delete-device',
            deletedAt: '2026-03-31T00:00:00.000Z',
        });
        expect(restored.settings).toMatchObject({
            pendingRemoteWriteAt: restoredAt,
            pendingRemoteWriteRetryAt: undefined,
            pendingRemoteWriteAttempts: undefined,
        });
    });

    it('does not restore device-local mobile app lock state', () => {
        const data = buildAppData();
        const restoredAt = '2026-04-01T00:00:10.000Z';
        data.settings = {
            diagnostics: { loggingEnabled: true },
            security: { mobileAppLockEnabled: true },
        };

        const restored = prepareRestoredBackupDataForSync(data, { restoredAt });

        expect(restored.settings.security).toBeUndefined();
        expect(restored.settings.diagnostics).toEqual({ loggingEnabled: true });
        expect(restored.settings.pendingRemoteWriteAt).toBe(restoredAt);
    });

    it('keeps recovered backup data live when remote sync still has stale cascade tombstones', () => {
        const deletedAt = '2026-04-01T00:00:05.000Z';
        const restoredAt = '2026-04-01T00:00:10.000Z';
        const backup = buildAppData();
        backup.areas = [{
            id: 'area-1',
            name: 'Area',
            order: 0,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.people = [{
            id: 'person-1',
            name: 'Alex',
            note: 'Design lead',
            referenceLink: 'https://example.com/alex',
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.projects[0] = {
            ...backup.projects[0],
            areaId: 'area-1',
            areaTitle: 'Area',
            rev: 4,
            revBy: 'old-device',
        };
        backup.sections = [{
            id: 'section-1',
            projectId: 'project-1',
            title: 'Section',
            description: '',
            order: 0,
            isCollapsed: false,
            createdAt: '2026-03-30T12:00:00.000Z',
            updatedAt: '2026-03-30T12:00:00.000Z',
            rev: 4,
            revBy: 'old-device',
        }];
        backup.tasks[0] = {
            ...backup.tasks[0],
            areaId: 'area-1',
            projectId: 'project-1',
            sectionId: 'section-1',
            rev: 4,
            revBy: 'old-device',
        };
        const restored = prepareRestoredBackupDataForSync(backup, { restoredAt });
        const remote: AppData = {
            tasks: [{
                ...backup.tasks[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            projects: [{
                ...backup.projects[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            sections: [{
                ...backup.sections[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            areas: [{
                ...backup.areas[0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            people: [{
                ...backup.people![0],
                updatedAt: deletedAt,
                deletedAt,
                rev: 99,
                revBy: 'remote-delete',
            }],
            settings: {},
        };

        const forward = mergeAppData(restored, remote, { nowIso: restoredAt });
        const reverse = mergeAppData(remote, restored, { nowIso: restoredAt });

        for (const merged of [forward, reverse]) {
            expect(merged.tasks[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.tasks[0].deletedAt).toBeUndefined();
            expect(merged.projects[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.projects[0].deletedAt).toBeUndefined();
            expect(merged.sections[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.sections[0].deletedAt).toBeUndefined();
            expect(merged.areas[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.areas[0].deletedAt).toBeUndefined();
            expect(merged.people?.[0]).toMatchObject({
                updatedAt: restoredAt,
                revBy: SYNC_BACKUP_RESTORE_REV_BY,
            });
            expect(merged.people?.[0].deletedAt).toBeUndefined();
        }
    });
});
