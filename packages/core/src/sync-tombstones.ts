import type { AppData, Attachment, Area, Person, Project, SavedFilter, Section, Task } from './types';
import { prunePendingRemoteAttachmentDeletes } from './attachment-cleanup';

const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;
const MIN_TOMBSTONE_RETENTION_DAYS = 1;
const MAX_TOMBSTONE_RETENTION_DAYS = 3650;

// Archived tasks older than this are dropped from the synced payload entirely.
// Without a cap the blob grows unbounded (observed: 9.9k archived tasks = 94%
// of a 9.8MB payload → slow fetches and "Storage request timed out").
// Configurable via settings.gtd.archivedRetentionDays; <= 0 disables pruning.
const DEFAULT_ARCHIVED_RETENTION_DAYS = 180;

const resolveArchivedRetentionDays = (value?: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_ARCHIVED_RETENTION_DAYS;
    return Math.min(MAX_TOMBSTONE_RETENTION_DAYS, Math.floor(value as number));
};

const parseTimestampOrNaN = (value?: string): number => {
    if (!value) return Number.NaN;
    return Date.parse(value);
};

/** Age of an archived task = its completion date (updatedAt as fallback).
 *  Deliberately NOT max(completedAt, updatedAt): bulk migrations / rev bumps
 *  touch updatedAt on thousands of archived tasks at once (observed 9.4k tasks
 *  all stamped the same day), which would immortalize the whole archive. */
const getArchivedActivityTimestamp = (task: Task): number => {
    const completedMs = parseTimestampOrNaN(task.completedAt);
    if (Number.isFinite(completedMs)) return completedMs;
    return parseTimestampOrNaN(task.updatedAt);
};

const resolveTombstoneRetentionDays = (value?: number): number => {
    if (!Number.isFinite(value)) return DEFAULT_TOMBSTONE_RETENTION_DAYS;
    const rounded = Math.floor(value as number);
    return Math.min(MAX_TOMBSTONE_RETENTION_DAYS, Math.max(MIN_TOMBSTONE_RETENTION_DAYS, rounded));
};

const parseTimestampOrInfinity = (value?: string): number => {
    if (!value) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const getTaskTombstoneTimestamp = (task: Task): number => {
    if (!task.deletedAt) return Number.POSITIVE_INFINITY;
    const purgedMs = parseTimestampOrInfinity(task.purgedAt);
    if (Number.isFinite(purgedMs)) return purgedMs;
    return parseTimestampOrInfinity(task.deletedAt);
};

const getProjectTombstoneTimestamp = (project: Project): number => {
    if (!project.deletedAt) return Number.POSITIVE_INFINITY;
    const purgedMs = parseTimestampOrInfinity(project.purgedAt);
    if (Number.isFinite(purgedMs)) return purgedMs;
    return parseTimestampOrInfinity(project.deletedAt);
};

const pruneAttachmentTombstones = (
    attachments: Attachment[] | undefined,
    cutoffMs: number
): { next: Attachment[] | undefined; removed: number } => {
    if (!attachments || attachments.length === 0) return { next: attachments, removed: 0 };
    let removed = 0;
    const next = attachments.filter((attachment) => {
        if (!attachment.deletedAt) return true;
        const deletedMs = parseTimestampOrInfinity(attachment.deletedAt);
        if (deletedMs <= cutoffMs) {
            removed += 1;
            return false;
        }
        return true;
    });
    return {
        next: next.length > 0 ? next : undefined,
        removed,
    };
};

const pruneSavedFilterTombstones = (
    savedFilters: SavedFilter[] | undefined,
    cutoffMs: number
): { next: SavedFilter[] | undefined; removed: number } => {
    if (!savedFilters || savedFilters.length === 0) return { next: savedFilters, removed: 0 };
    let removed = 0;
    const next = savedFilters.filter((filter) => {
        if (!filter.deletedAt) return true;
        const deletedMs = parseTimestampOrInfinity(filter.deletedAt);
        if (deletedMs <= cutoffMs) {
            removed += 1;
            return false;
        }
        return true;
    });
    return {
        next,
        removed,
    };
};

export const purgeExpiredTombstones = (
    data: AppData,
    nowIso: string,
    retentionDays?: number
): {
    data: AppData;
    removedTaskTombstones: number;
    removedProjectTombstones: number;
    removedSectionTombstones: number;
    removedAreaTombstones: number;
    removedPersonTombstones: number;
    removedAttachmentTombstones: number;
    removedSavedFilterTombstones: number;
    removedPendingRemoteDeletes: number;
    removedArchivedTasks: number;
} => {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
        return {
            data,
            removedTaskTombstones: 0,
            removedProjectTombstones: 0,
            removedSectionTombstones: 0,
            removedAreaTombstones: 0,
            removedPersonTombstones: 0,
            removedAttachmentTombstones: 0,
            removedSavedFilterTombstones: 0,
            removedPendingRemoteDeletes: 0,
            removedArchivedTasks: 0,
        };
    }
    const keepDays = resolveTombstoneRetentionDays(retentionDays);
    const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;
    const archivedKeepDays = resolveArchivedRetentionDays(data.settings.gtd?.archivedRetentionDays);
    const archivedCutoffMs = archivedKeepDays > 0
        ? nowMs - archivedKeepDays * 24 * 60 * 60 * 1000
        : Number.NEGATIVE_INFINITY;

    let removedArchivedTasks = 0;
    let removedTaskTombstones = 0;
    let removedProjectTombstones = 0;
    let removedSectionTombstones = 0;
    let removedAreaTombstones = 0;
    let removedPersonTombstones = 0;
    let removedAttachmentTombstones = 0;
    let removedSavedFilterTombstones = 0;
    const nextTasks: Task[] = [];
    for (const task of data.tasks) {
        const tombstoneAt = getTaskTombstoneTimestamp(task);
        if (task.deletedAt && tombstoneAt <= cutoffMs) {
            removedTaskTombstones += 1;
            continue;
        }
        if (!task.deletedAt && task.status === 'archived') {
            const activityMs = getArchivedActivityTimestamp(task);
            if (Number.isFinite(activityMs) && activityMs <= archivedCutoffMs) {
                removedArchivedTasks += 1;
                continue;
            }
        }
        const pruned = pruneAttachmentTombstones(task.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        if (pruned.removed > 0) {
            nextTasks.push({ ...task, attachments: pruned.next });
            continue;
        }
        nextTasks.push(task);
    }

    const nextProjects: Project[] = [];
    for (const project of data.projects) {
        const tombstoneMs = getProjectTombstoneTimestamp(project);
        if (project.deletedAt && tombstoneMs <= cutoffMs) {
            removedProjectTombstones += 1;
            continue;
        }
        const pruned = pruneAttachmentTombstones(project.attachments, cutoffMs);
        removedAttachmentTombstones += pruned.removed;
        nextProjects.push(pruned.removed > 0 ? { ...project, attachments: pruned.next } : project);
    }
    const nextSections: Section[] = [];
    for (const section of data.sections) {
        const deletedMs = parseTimestampOrInfinity(section.deletedAt);
        if (section.deletedAt && deletedMs <= cutoffMs) {
            removedSectionTombstones += 1;
            continue;
        }
        nextSections.push(section);
    }
    const nextAreas: Area[] = [];
    for (const area of data.areas) {
        const deletedMs = parseTimestampOrInfinity(area.deletedAt);
        if (area.deletedAt && deletedMs <= cutoffMs) {
            removedAreaTombstones += 1;
            continue;
        }
        nextAreas.push(area);
    }
    const nextPeople: Person[] = [];
    for (const person of data.people ?? []) {
        const deletedMs = parseTimestampOrInfinity(person.deletedAt);
        if (person.deletedAt && deletedMs <= cutoffMs) {
            removedPersonTombstones += 1;
            continue;
        }
        nextPeople.push(person);
    }

    let nextSettings = data.settings;
    const savedFilterPrune = pruneSavedFilterTombstones(data.settings.savedFilters, cutoffMs);
    removedSavedFilterTombstones = savedFilterPrune.removed;
    if (removedSavedFilterTombstones > 0) {
        nextSettings = {
            ...data.settings,
            savedFilters: savedFilterPrune.next,
        };
    }
    const pendingRemoteDeletes = data.settings.attachments?.pendingRemoteDeletes;
    const nextPendingRemoteDeletes = prunePendingRemoteAttachmentDeletes(pendingRemoteDeletes, nowIso);
    const removedPendingRemoteDeletes = Math.max(
        0,
        (pendingRemoteDeletes?.length ?? 0) - nextPendingRemoteDeletes.length,
    );
    if (removedPendingRemoteDeletes > 0) {
        nextSettings = {
            ...nextSettings,
            attachments: {
                ...nextSettings.attachments,
                pendingRemoteDeletes: nextPendingRemoteDeletes.length > 0
                    ? nextPendingRemoteDeletes
                    : undefined,
            },
        };
    }

    return {
        data: {
            ...data,
            tasks: nextTasks,
            projects: nextProjects,
            sections: nextSections,
            areas: nextAreas,
            people: nextPeople,
            settings: nextSettings,
        },
        removedTaskTombstones,
        removedProjectTombstones,
        removedSectionTombstones,
        removedAreaTombstones,
        removedPersonTombstones,
        removedAttachmentTombstones,
        removedSavedFilterTombstones,
        removedPendingRemoteDeletes,
        removedArchivedTasks,
    };
};
