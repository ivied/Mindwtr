import type { AppData, Area, Attachment, Person, Project, Task } from './types';
import { normalizePersonName, normalizePersonNote, normalizePersonReferenceLink } from './people';
import { normalizeProjectSequentialScope } from './project-utils';
import { normalizeTaskForLoad } from './task-status';
import { SYNC_REPAIR_REV_BY } from './sync-types';
import { isValidRevision, nextRevision, normalizeRevision } from './sync-revision';
import { resolveTaskContainerHierarchy } from './task-container-rules';
import { dedupeLiveAreasByName } from './area-utils';

export const normalizeAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    people: Array.isArray(data.people) ? data.people : [],
    settings: data.settings ?? {},
});

export const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidTimestamp = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));

const normalizeOptionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const normalizeStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const ATTACHMENT_TRAVERSAL_SEGMENT_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const ATTACHMENT_URI_DECODE_LIMIT = 4;
const ATTACHMENT_CLOUD_KEY_PATTERN = /^attachments\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$|^cloudkit:[A-Za-z0-9][A-Za-z0-9_-]*$/;

const containsAttachmentTraversalSegment = (value: string): boolean => {
    const candidates = new Set<string>([value]);
    const queue: string[] = [value];
    const enqueueCandidate = (candidate: string) => {
        if (!candidate || candidates.has(candidate)) return;
        candidates.add(candidate);
        queue.push(candidate);
    };

    for (let index = 0; index < queue.length && index < ATTACHMENT_URI_DECODE_LIMIT; index += 1) {
        const current = queue[index];
        try {
            const decoded = decodeURIComponent(current);
            if (decoded !== current) enqueueCandidate(decoded);
        } catch {
            // Keep evaluating other candidates when decoding fails.
        }
        const trimmed = current.trim();
        if (trimmed.startsWith('//')) {
            try {
                enqueueCandidate(new URL(`file:${trimmed}`).pathname);
            } catch {
                // Keep evaluating the raw candidate when URL parsing fails.
            }
            continue;
        }
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
            try {
                enqueueCandidate(new URL(trimmed).pathname);
            } catch {
                // Keep evaluating the raw candidate when URL parsing fails.
            }
        }
    }

    return Array.from(candidates).some((candidate) => ATTACHMENT_TRAVERSAL_SEGMENT_PATTERN.test(candidate));
};

export const sanitizeAttachmentUriForSyncMerge = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0')) return undefined;
    if (containsAttachmentTraversalSegment(trimmed)) return undefined;
    return trimmed;
};

export const sanitizeAttachmentCloudKeyForSyncMerge = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0')) return undefined;
    if (containsAttachmentTraversalSegment(trimmed)) return undefined;
    return ATTACHMENT_CLOUD_KEY_PATTERN.test(trimmed) ? trimmed : undefined;
};

const normalizeAttachmentsForSyncMerge = (attachments: Attachment[] | undefined): Attachment[] | undefined => {
    if (!attachments) return attachments;
    return attachments.map((attachment) => {
        if (attachment.kind !== 'file') return attachment;
        return {
            ...attachment,
            uri: sanitizeAttachmentUriForSyncMerge(attachment.uri) ?? '',
            cloudKey: sanitizeAttachmentCloudKeyForSyncMerge(attachment.cloudKey),
        };
    });
};

type RevisionMetadata = {
    rev?: unknown;
    revBy?: unknown;
};

export const normalizeRevisionMetadata = <T extends RevisionMetadata>(item: T): T => {
    const normalized = { ...item };
    const rawRev = normalized.rev;
    if (!isValidRevision(rawRev)) {
        delete normalized.rev;
    } else {
        normalized.rev = normalizeRevision(rawRev);
    }
    const rawRevBy = normalized.revBy;
    if (typeof rawRevBy === 'string') {
        const trimmed = rawRevBy.trim();
        if (trimmed.length > 0) {
            normalized.revBy = trimmed;
        } else {
            delete normalized.revBy;
        }
    } else {
        delete normalized.revBy;
    }
    return normalized;
};

const normalizeProjectStatusForMerge = (value: unknown): Project['status'] => {
    if (value === 'active' || value === 'someday' || value === 'waiting' || value === 'archived') {
        return value;
    }
    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'active' || lowered === 'someday' || lowered === 'waiting' || lowered === 'archived') {
            return lowered as Project['status'];
        }
    }
    return 'active';
};

export const normalizeTaskForSyncMerge = (task: Task, nowIso: string): Task => {
    const normalized = normalizeTaskForLoad(task, nowIso);
    const hasRecurrence = normalized.recurrence !== undefined && normalized.recurrence !== null;
    return {
        id: normalized.id,
        title: normalized.title,
        status: normalized.status,
        priority: normalized.priority,
        energyLevel: normalized.energyLevel,
        assignedTo: normalized.assignedTo,
        taskMode: normalized.taskMode,
        startTime: normalized.startTime,
        relativeStartOffset: normalized.relativeStartOffset,
        dueDate: normalized.dueDate,
        recurrence: normalized.recurrence,
        pushCount: normalized.pushCount,
        tags: normalizeStringArray(normalized.tags),
        contexts: normalizeStringArray(normalized.contexts),
        checklist: normalized.checklist,
        description: normalized.description,
        textDirection: normalized.textDirection,
        attachments: normalizeAttachmentsForSyncMerge(normalized.attachments),
        location: normalized.location,
        projectId: normalized.projectId,
        sectionId: normalizeOptionalString(normalized.sectionId),
        areaId: normalized.areaId,
        isFocusedToday: normalized.isFocusedToday === true,
        timeEstimate: normalized.timeEstimate,
        showFutureRecurrence: hasRecurrence && normalized.showFutureRecurrence === true ? true : undefined,
        suppressMindwtrReminders: normalized.suppressMindwtrReminders === true,
        repeatReminderMinutes: normalized.repeatReminderMinutes,
        reviewAt: normalized.reviewAt,
        completedAt: normalized.completedAt,
        statusBeforeProjectArchive: normalized.statusBeforeProjectArchive,
        completedAtBeforeProjectArchive: normalized.completedAtBeforeProjectArchive,
        isFocusedTodayBeforeProjectArchive: normalized.isFocusedTodayBeforeProjectArchive,
        projectArchivedAt: normalized.projectArchivedAt,
        rev: normalized.rev,
        revBy: normalized.revBy,
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        deletedAt: normalized.deletedAt,
        purgedAt: normalized.purgedAt,
        order: normalized.order,
        orderNum: normalized.orderNum,
        boardOrder: normalized.boardOrder,
    };
};

export const normalizeProjectForSyncMerge = (project: Project): Project => {
    return {
        ...project,
        status: normalizeProjectStatusForMerge(project.status),
        color: normalizeOptionalString(project.color) ?? '#6B7280',
        tagIds: normalizeStringArray(project.tagIds),
        isSequential: project.isSequential === true,
        sequentialScope: normalizeProjectSequentialScope(project.sequentialScope),
        isFocused: project.isFocused === true,
        attachments: normalizeAttachmentsForSyncMerge(project.attachments),
        dueDate: normalizeOptionalString(project.dueDate),
        reviewAt: normalizeOptionalString(project.reviewAt),
        areaId: normalizeOptionalString(project.areaId),
        areaTitle: normalizeOptionalString(project.areaTitle),
    };
};

export type SyncMergeArea = Omit<Area, 'order'> & {
    order?: number;
    createdAt: string;
    updatedAt: string;
};

export const normalizeAreaForSyncMerge = (area: Area, nowIso: string): SyncMergeArea => {
    const createdAt = normalizeOptionalString(area.createdAt) ?? normalizeOptionalString(area.updatedAt) ?? nowIso;
    const updatedAt = normalizeOptionalString(area.updatedAt) ?? normalizeOptionalString(area.createdAt) ?? nowIso;
    return {
        ...area,
        color: normalizeOptionalString(area.color),
        icon: normalizeOptionalString(area.icon),
        order: Number.isFinite(area.order) ? area.order : undefined,
        createdAt,
        updatedAt,
    };
};

export const normalizePersonForSyncMerge = (person: Person, nowIso: string): Person => {
    const createdAt = normalizeOptionalString(person.createdAt) ?? normalizeOptionalString(person.updatedAt) ?? nowIso;
    const updatedAt = normalizeOptionalString(person.updatedAt) ?? normalizeOptionalString(person.createdAt) ?? nowIso;
    return {
        ...person,
        name: normalizePersonName(person.name),
        note: normalizePersonNote(person.note),
        referenceLink: normalizePersonReferenceLink(person.referenceLink),
        createdAt,
        updatedAt,
    };
};

const hasDeletedAt = (value: { deletedAt?: string } | undefined): boolean => Boolean(value?.deletedAt);

const normalizeRepairRevision = (value?: number): number => normalizeRevision(value);

const withRepairRevision = <T extends { rev?: number; revBy?: string }>(item: T): T => {
    const rev = normalizeRepairRevision(item.rev);
    return {
        ...item,
        rev: item.revBy === SYNC_REPAIR_REV_BY ? rev : nextRevision(item.rev),
        revBy: SYNC_REPAIR_REV_BY,
    };
};

export const repairMergedSyncReferences = (data: AppData, nowIso: string): AppData => {
    const dedupedAreas = dedupeLiveAreasByName(data.areas, {
        nowIso,
        revBy: SYNC_REPAIR_REV_BY,
    });
    const areaIdRemap = dedupedAreas.areaIdRemap;
    const areas = dedupedAreas.areas;
    const liveAreasById = new Map(
        areas
            .filter((area) => !hasDeletedAt(area))
            .map((area) => [area.id, area] as const)
    );
    const deletedAreaIds = new Set(
        areas
            .filter((area) => hasDeletedAt(area))
            .map((area) => area.id)
    );

    const repairedProjects = data.projects.map((project) => {
        const originalAreaId = normalizeOptionalString(project.areaId);
        const remappedAreaId = originalAreaId ? areaIdRemap.get(originalAreaId) : undefined;
        const areaId = remappedAreaId ?? originalAreaId;
        if (!areaId) {
            return areaId === project.areaId && project.areaTitle === normalizeOptionalString(project.areaTitle)
                ? project
                : {
                    ...project,
                    areaId,
                    areaTitle: normalizeOptionalString(project.areaTitle),
                };
        }
        const liveArea = liveAreasById.get(areaId);
        if (liveArea) {
            const areaTitle = normalizeOptionalString(liveArea.name);
            if (areaId === project.areaId && project.areaTitle === areaTitle) {
                return project;
            }
            return {
                ...withRepairRevision(project),
                areaId,
                areaTitle,
                updatedAt: nowIso,
            };
        }
        return {
            ...withRepairRevision(project),
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: nowIso,
        };
    });

    const liveProjectIds = new Set(
        repairedProjects
            .filter((project) => !hasDeletedAt(project))
            .map((project) => project.id)
    );
    const deletedProjectIds = new Set(
        repairedProjects
            .filter((project) => hasDeletedAt(project))
            .map((project) => project.id)
    );

    const repairedSections = data.sections.map((section) => {
        if (hasDeletedAt(section) || liveProjectIds.has(section.projectId) || !deletedProjectIds.has(section.projectId)) {
            return section;
        }
        return {
            ...withRepairRevision(section),
            deletedAt: nowIso,
            updatedAt: nowIso,
        };
    });

    const liveSections = new Map(
        repairedSections
            .filter((section) => !hasDeletedAt(section) && liveProjectIds.has(section.projectId))
            .map((section) => [section.id, section] as const)
    );

    const repairedTasks = data.tasks.map((task) => {
        const originalProjectId = normalizeOptionalString(task.projectId);
        const originalSectionId = normalizeOptionalString(task.sectionId);
        const originalAreaId = normalizeOptionalString(task.areaId);
        let nextProjectId = originalProjectId;
        let nextSectionId = originalSectionId;
        let nextAreaId = originalAreaId ? areaIdRemap.get(originalAreaId) ?? originalAreaId : undefined;
        let changed = nextAreaId !== originalAreaId;

        if (nextProjectId && deletedProjectIds.has(nextProjectId)) {
            nextProjectId = undefined;
            nextSectionId = undefined;
            changed = true;
        } else if (nextProjectId && !liveProjectIds.has(nextProjectId)) {
            nextProjectId = undefined;
            changed = true;
        }

        if (nextAreaId && (deletedAreaIds.has(nextAreaId) || !liveAreasById.has(nextAreaId))) {
            nextAreaId = undefined;
            changed = true;
        }

        const sectionProjectId = nextSectionId ? liveSections.get(nextSectionId)?.projectId : undefined;
        const resolvedContainer = resolveTaskContainerHierarchy({
            projectId: nextProjectId,
            sectionId: nextSectionId,
            areaId: nextAreaId,
            sectionProjectId,
        });
        if (
            resolvedContainer.projectId !== nextProjectId
            || resolvedContainer.sectionId !== nextSectionId
            || resolvedContainer.areaId !== nextAreaId
        ) {
            nextProjectId = resolvedContainer.projectId;
            nextSectionId = resolvedContainer.sectionId;
            nextAreaId = resolvedContainer.areaId;
            changed = true;
        }

        if (!changed) return task;

        return {
            ...withRepairRevision(task),
            projectId: nextProjectId,
            sectionId: nextSectionId,
            areaId: nextAreaId,
            ...(originalProjectId && !nextProjectId
                ? {
                    order: undefined,
                    orderNum: undefined,
                }
                : {}),
            updatedAt: nowIso,
        };
    });

    let repairedSettings = data.settings;
    const configuredDefaultAreaId = data.settings?.gtd?.defaultAreaId;
    const remappedDefaultAreaId = typeof configuredDefaultAreaId === 'string'
        ? areaIdRemap.get(configuredDefaultAreaId)
        : undefined;
    if (remappedDefaultAreaId && remappedDefaultAreaId !== configuredDefaultAreaId) {
        repairedSettings = {
            ...data.settings,
            gtd: {
                ...(data.settings?.gtd ?? {}),
                defaultAreaId: remappedDefaultAreaId,
            },
            syncPreferencesUpdatedAt: {
                ...(data.settings?.syncPreferencesUpdatedAt ?? {}),
                gtd: nowIso,
            },
        };
    }

    return {
        ...data,
        areas,
        tasks: repairedTasks,
        projects: repairedProjects,
        sections: repairedSections,
        settings: repairedSettings,
    };
};

const validateRevisionFields = (
    item: Record<string, unknown>,
    label: string,
    index: number,
    errors: string[]
) => {
    const rev = item.rev;
    if (rev !== undefined) {
        if (typeof rev !== 'number' || !Number.isFinite(rev) || rev < 0 || !Number.isInteger(rev)) {
            errors.push(`${label}[${index}].rev must be a non-negative integer when present`);
        }
    }
    const revBy = item.revBy;
    if (revBy !== undefined && !isNonEmptyString(revBy)) {
        errors.push(`${label}[${index}].revBy must be a non-empty string when present`);
    }
};

const validateEntityShape = (
    items: unknown[],
    label: 'tasks' | 'projects' | 'sections',
    errors: string[]
) => {
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!isObjectRecord(item)) {
            errors.push(`${label}[${index}] must be an object`);
            continue;
        }
        if (!isNonEmptyString(item.id)) {
            errors.push(`${label}[${index}].id must be a non-empty string`);
        }
        if (item.createdAt !== undefined && !isNonEmptyString(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a non-empty string when present`);
        } else if (isNonEmptyString(item.createdAt) && !isValidTimestamp(item.createdAt)) {
            errors.push(`${label}[${index}].createdAt must be a valid ISO timestamp when present`);
        }
        if (!isNonEmptyString(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a non-empty string`);
        } else if (!isValidTimestamp(item.updatedAt)) {
            errors.push(`${label}[${index}].updatedAt must be a valid ISO timestamp`);
        }
        if (isValidTimestamp(item.createdAt) && isValidTimestamp(item.updatedAt)) {
            const createdMs = Date.parse(item.createdAt);
            const updatedMs = Date.parse(item.updatedAt);
            if (updatedMs < createdMs) {
                errors.push(`${label}[${index}].updatedAt must be greater than or equal to createdAt`);
            }
        }
        validateRevisionFields(item, label, index, errors);
    }
};

export const validateMergedSyncData = (data: AppData): string[] => {
    const errors: string[] = [];
    if (!Array.isArray(data.tasks)) errors.push('tasks must be an array');
    if (!Array.isArray(data.projects)) errors.push('projects must be an array');
    if (!Array.isArray(data.sections)) errors.push('sections must be an array');
    if (!Array.isArray(data.areas)) errors.push('areas must be an array');
    if (data.people !== undefined && !Array.isArray(data.people)) errors.push('people must be an array');
    if (!isObjectRecord(data.settings)) errors.push('settings must be an object');

    if (Array.isArray(data.tasks)) validateEntityShape(data.tasks as unknown[], 'tasks', errors);
    if (Array.isArray(data.projects)) validateEntityShape(data.projects as unknown[], 'projects', errors);
    if (Array.isArray(data.sections)) validateEntityShape(data.sections as unknown[], 'sections', errors);
    if (Array.isArray(data.areas)) {
        for (let index = 0; index < data.areas.length; index += 1) {
            const area = data.areas[index] as unknown;
            if (!isObjectRecord(area)) {
                errors.push(`areas[${index}] must be an object`);
                continue;
            }
            if (!isNonEmptyString(area.id)) {
                errors.push(`areas[${index}].id must be a non-empty string`);
            }
            if (!isNonEmptyString(area.name)) {
                errors.push(`areas[${index}].name must be a non-empty string`);
            }
            if (!isNonEmptyString(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.createdAt)) {
                errors.push(`areas[${index}].createdAt must be a valid ISO timestamp`);
            }
            if (!isNonEmptyString(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a non-empty string`);
            } else if (!isValidTimestamp(area.updatedAt)) {
                errors.push(`areas[${index}].updatedAt must be a valid ISO timestamp`);
            }
            if (isValidTimestamp(area.createdAt) && isValidTimestamp(area.updatedAt)) {
                const createdMs = Date.parse(area.createdAt);
                const updatedMs = Date.parse(area.updatedAt);
                if (updatedMs < createdMs) {
                    errors.push(`areas[${index}].updatedAt must be greater than or equal to createdAt`);
                }
            }
            validateRevisionFields(area, 'areas', index, errors);
        }
    }
    if (Array.isArray(data.people)) {
        for (let index = 0; index < data.people.length; index += 1) {
            const person = data.people[index] as unknown;
            if (!isObjectRecord(person)) {
                errors.push(`people[${index}] must be an object`);
                continue;
            }
            if (!isNonEmptyString(person.id)) {
                errors.push(`people[${index}].id must be a non-empty string`);
            }
            if (!isNonEmptyString(person.name)) {
                errors.push(`people[${index}].name must be a non-empty string`);
            }
            if (!isNonEmptyString(person.createdAt)) {
                errors.push(`people[${index}].createdAt must be a non-empty string`);
            } else if (!isValidTimestamp(person.createdAt)) {
                errors.push(`people[${index}].createdAt must be a valid ISO timestamp`);
            }
            if (!isNonEmptyString(person.updatedAt)) {
                errors.push(`people[${index}].updatedAt must be a non-empty string`);
            } else if (!isValidTimestamp(person.updatedAt)) {
                errors.push(`people[${index}].updatedAt must be a valid ISO timestamp`);
            }
            if (isValidTimestamp(person.createdAt) && isValidTimestamp(person.updatedAt)) {
                const createdMs = Date.parse(person.createdAt);
                const updatedMs = Date.parse(person.updatedAt);
                if (updatedMs < createdMs) {
                    errors.push(`people[${index}].updatedAt must be greater than or equal to createdAt`);
                }
            }
            validateRevisionFields(person, 'people', index, errors);
        }
    }

    const allAreaIds = new Set(
        Array.isArray(data.areas)
            ? data.areas.filter((area) => isObjectRecord(area) && isNonEmptyString(area.id)).map((area) => String(area.id))
            : []
    );
    const liveAreaIds = new Set(
        Array.isArray(data.areas)
            ? data.areas
                .filter((area) => isObjectRecord(area) && isNonEmptyString(area.id) && !isNonEmptyString(area.deletedAt))
                .map((area) => String(area.id))
            : []
    );
    const allProjectIds = new Set(
        Array.isArray(data.projects)
            ? data.projects.filter((project) => isObjectRecord(project) && isNonEmptyString(project.id)).map((project) => String(project.id))
            : []
    );
    const liveProjectIds = new Set(
        Array.isArray(data.projects)
            ? data.projects
                .filter((project) => isObjectRecord(project) && isNonEmptyString(project.id) && !isNonEmptyString(project.deletedAt))
                .map((project) => String(project.id))
            : []
    );
    const deletedProjectIds = new Set(
        Array.isArray(data.projects)
            ? data.projects.filter((project) => isObjectRecord(project) && isNonEmptyString(project.deletedAt)).map((project) => String(project.id))
            : []
    );
    const liveSections = new Map(
        Array.isArray(data.sections)
            ? data.sections
                .filter((section) => isObjectRecord(section) && !isNonEmptyString(section.deletedAt))
                .map((section) => [String(section.id), section] as const)
            : []
    );
    const deletedSectionIds = new Set(
        Array.isArray(data.sections)
            ? data.sections
                .filter((section) => isObjectRecord(section) && isNonEmptyString(section.deletedAt))
                .map((section) => String(section.id))
            : []
    );
    const allSectionIds = new Set(
        Array.isArray(data.sections)
            ? data.sections
                .filter((section) => isObjectRecord(section) && isNonEmptyString(section.id))
                .map((section) => String(section.id))
            : []
    );

    if (Array.isArray(data.projects)) {
        data.projects.forEach((project, index) => {
            if (!isObjectRecord(project)) return;
            if (isNonEmptyString(project.areaId) && !allAreaIds.has(project.areaId)) {
                errors.push(`projects[${index}].areaId must reference an existing area`);
                return;
            }
            if (isNonEmptyString(project.deletedAt)) return;
            if (isNonEmptyString(project.areaId) && !liveAreaIds.has(project.areaId)) {
                errors.push(`projects[${index}].areaId must not reference a deleted area`);
            }
        });
    }

    if (Array.isArray(data.sections)) {
        data.sections.forEach((section, index) => {
            if (!isObjectRecord(section)) return;
            if (isNonEmptyString(section.projectId) && !allProjectIds.has(section.projectId)) {
                errors.push(`sections[${index}].projectId must reference an existing project`);
                return;
            }
            if (isNonEmptyString(section.deletedAt)) return;
            if (deletedProjectIds.has(String(section.projectId))) {
                errors.push(`sections[${index}].projectId must not reference a deleted project`);
            }
        });
    }

    if (Array.isArray(data.tasks)) {
        data.tasks.forEach((task, index) => {
            if (!isObjectRecord(task)) return;
            const taskProjectExists = !isNonEmptyString(task.projectId) || allProjectIds.has(task.projectId);
            const taskAreaExists = !isNonEmptyString(task.areaId) || allAreaIds.has(task.areaId);
            if (isNonEmptyString(task.projectId) && !taskProjectExists) {
                errors.push(`tasks[${index}].projectId must reference an existing project`);
            }
            if (isNonEmptyString(task.areaId) && !taskAreaExists) {
                errors.push(`tasks[${index}].areaId must reference an existing area`);
            }
            if (isNonEmptyString(task.sectionId) && !allSectionIds.has(task.sectionId)) {
                errors.push(`tasks[${index}].sectionId must reference an existing section`);
                return;
            }
            if (isNonEmptyString(task.deletedAt)) return;
            if (isNonEmptyString(task.projectId) && taskProjectExists && !liveProjectIds.has(task.projectId)) {
                errors.push(`tasks[${index}].projectId must not reference a deleted project`);
            }
            if (isNonEmptyString(task.areaId) && taskAreaExists && !liveAreaIds.has(task.areaId)) {
                errors.push(`tasks[${index}].areaId must not reference a deleted area`);
            }
            if (isNonEmptyString(task.sectionId)) {
                if (deletedSectionIds.has(task.sectionId)) {
                    errors.push(`tasks[${index}].sectionId must not reference a deleted section`);
                    return;
                }
                const section = liveSections.get(task.sectionId);
                if (!section) return;
                if (!isNonEmptyString(task.projectId)) {
                    errors.push(`tasks[${index}].projectId is required when sectionId is present`);
                    return;
                }
                if (String(section.projectId) !== task.projectId) {
                    errors.push(`tasks[${index}].sectionId must belong to the same projectId`);
                }
            }
        });
    }

    return errors;
};

export const validateSyncPayloadShape = (data: unknown, source: 'local' | 'remote'): string[] => {
    const errors: string[] = [];
    if (!isObjectRecord(data)) {
        errors.push(`${source} payload must be an object`);
        return errors;
    }
    const record = data as Record<string, unknown>;
    if (record.tasks !== undefined && !Array.isArray(record.tasks)) {
        errors.push(`${source} payload field "tasks" must be an array when present`);
    }
    if (record.projects !== undefined && !Array.isArray(record.projects)) {
        errors.push(`${source} payload field "projects" must be an array when present`);
    }
    if (record.sections !== undefined && !Array.isArray(record.sections)) {
        errors.push(`${source} payload field "sections" must be an array when present`);
    }
    if (record.areas !== undefined && !Array.isArray(record.areas)) {
        errors.push(`${source} payload field "areas" must be an array when present`);
    }
    if (record.people !== undefined && !Array.isArray(record.people)) {
        errors.push(`${source} payload field "people" must be an array when present`);
    }
    if (record.settings !== undefined && !isObjectRecord(record.settings)) {
        errors.push(`${source} payload field "settings" must be an object when present`);
    }
    return errors;
};
