#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import {
    applyTaskUpdates,
    areSyncPayloadsEqual,
    buildHttpRemoteFileFingerprint,
    filterNotDeleted,
    generateUUID,
    mergeAppDataWithStats,
    parseQuickAdd,
    repairMergedSyncReferences,
    searchAll,
    validateAttachmentForUpload,
    type Area,
    type Attachment,
    type AppData,
    type PendingRemoteAttachmentDelete,
    type Project,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
import {
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    getClientIp,
    getToken,
    isAuthorizedToken,
    normalizeAllowedAuthTokens,
    parseAllowedAuthTokens,
    parseBoolEnv,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    toRateLimitRoute,
    tokenToKey,
    type AllowedAuthTokenInput,
} from './server-auth';
import {
    AUTH_FAILURE_RATE_MAX,
    CLOUD_API_REV_BY,
    resolveAllowedOrigin,
    withCorsContext,
    errorResponse,
    jsonResponse,
    logError,
    logInfo,
    logWarn,
    LIST_MAX_LIMIT,
    MAX_TASK_QUICK_ADD_LENGTH,
    MAX_TASK_TITLE_LENGTH,
    normalizeRevision,
    parseArgs,
    parsePagination,
    preflightResponse,
    RATE_LIMIT_MAX_KEYS,
    UUID_PATTERN,
} from './server-config';
import {
    createRequestAbortError,
    createWriteLockRunner,
    ensureWritableDir,
    isBodyReadError,
    isPathWithinRoot,
    isRequestAbortError,
    normalizeAttachmentRelativePath,
    pathContainsSymlink,
    readData,
    readJsonBody,
    readRequestBytes,
    resolveAttachmentPath,
    throwIfRequestAborted,
    writeAttachmentFileSafely,
    writeData,
} from './server-storage';
import {
    asStatus,
    pickTaskList,
    validateAppData,
    validateAreaCreationProps,
    validateAreaPatchProps,
    validateProjectCreationProps,
    validateProjectPatchProps,
    validateSectionCreationProps,
    validateSectionPatchProps,
    validateTaskCreationProps,
    validateTaskPatchProps,
} from './server-validation';
import {
    __serverDataCacheTestUtils,
    dataMetadataResponse,
    getDataFileMetadata,
    isTrustedValidatedDataFile,
    jsonFileResponse,
    loadAppData,
    rememberValidatedDataFile,
    writeCloudData,
} from './server-data-cache';

const normalizeAttachmentContentType = (value: string | null): string => value?.split(';', 1)[0]?.trim().toLowerCase() || '';
const ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT = 32;
const TOKEN_NAMESPACE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const TOKEN_NAMESPACE_DIR_PATTERN = /^[a-f0-9]{64}$/;
// Relies on POSIX mtime; do not lower below 1 minute without auditing filesystem timestamp resolution and batching.
const ORPHAN_ATTACHMENT_GC_GRACE_MS = 5 * 60 * 1000;
const getBlockedAttachmentSignature = (bytes: Uint8Array): string | null => {
    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
        return 'windows-pe';
    }
    if (bytes.length >= 4) {
        if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
            return 'elf';
        }
        const signature = `${bytes[0].toString(16).padStart(2, '0')}${bytes[1].toString(16).padStart(2, '0')}`
            + `${bytes[2].toString(16).padStart(2, '0')}${bytes[3].toString(16).padStart(2, '0')}`;
        if (signature === 'feedface' || signature === 'feedfacf' || signature === 'cefaedfe' || signature === 'cffaedfe') {
            return 'mach-o';
        }
    }
    return null;
};

const generateRequestId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createInternalServerErrorResponse = (message: string, requestId: string): Response => (
    jsonResponse(
        { error: message, requestId },
        { status: 500, headers: { 'X-Request-Id': requestId } },
    )
);

const emptyCorsResponse = (status: number): Response => {
    const headers = new Headers({
        'Access-Control-Allow-Origin': resolveAllowedOrigin(),
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS',
    });
    return new Response(null, { status, headers });
};

const normalizeStoredAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    people: Array.isArray(data.people) ? data.people : [],
    settings: isRecord(data.settings) ? data.settings : {},
});

const validateStoredAppData = (
    filePath: string,
    key: string,
    rawData: unknown,
): AppData | { error: Response } => {
    if (isTrustedValidatedDataFile(filePath)) {
        return normalizeStoredAppData(rawData as AppData);
    }
    const validated = validateAppData(rawData);
    if (!validated.ok) {
        logWarn('Stored cloud data failed validation', { key, error: validated.error });
        return { error: errorResponse('Stored data failed validation', 500) };
    }
    rememberValidatedDataFile(filePath);
    return normalizeStoredAppData(validated.data);
};

const loadExistingDataForMerge = (filePath: string, key: string): AppData | { error: Response } => {
    if (!existsSync(filePath)) return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
    const rawData = readData(filePath);
    if (!rawData) {
        logWarn('Stored cloud data failed validation', { key, error: 'Invalid JSON' });
        return { error: errorResponse('Stored data failed validation', 500) };
    }
    return validateStoredAppData(filePath, key, rawData);
};

type BunServer = {
    port: number;
    stop?: (closeIdleConnections?: boolean) => void | Promise<void>;
};

type BunRuntime = {
    serve: (options: {
        hostname: string;
        port: number;
        idleTimeout?: number;
        fetch: (req: Request) => Response | Promise<Response>;
    }) => BunServer;
};

const getBunRuntime = (): BunRuntime | undefined => (
    (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
);

const IS_MAIN_MODULE = !!getBunRuntime() && (import.meta as ImportMeta & { main?: boolean }).main === true;

type RateLimitState = {
    count: number;
    resetAt: number;
    lastSeenAt: number;
};

function decodePathParam(rawValue: string): string | null {
    try {
        return decodeURIComponent(rawValue);
    } catch {
        return null;
    }
}

function parseTaskRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    if (!decoded) return null;
    return UUID_PATTERN.test(decoded) ? decoded : null;
}

function parseEntityRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    const trimmed = decoded?.trim() ?? '';
    if (!trimmed || trimmed.length > 200 || trimmed.includes('/')) return null;
    return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROJECT_STATUSES = new Set<Project['status']>(['active', 'someday', 'waiting', 'archived']);

function asProjectStatus(value: unknown): Project['status'] | null {
    return PROJECT_STATUSES.has(value as Project['status']) ? value as Project['status'] : null;
}

function readObjectBody(body: unknown): Record<string, unknown> | null {
    return isRecord(body) ? body : null;
}

function nextOrder(items: Array<{ order?: number }>): number {
    return items.reduce((maxOrder, item) => (
        typeof item.order === 'number' && Number.isFinite(item.order)
            ? Math.max(maxOrder, item.order)
            : maxOrder
    ), -1) + 1;
}

function parseSearchPaginationValue(searchParams: URLSearchParams, name: string, fallback: number): number | { error: string } {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || (name.toLowerCase().includes('limit') && parsed <= 0)) {
        return { error: `Invalid ${name}` };
    }
    const value = Math.floor(parsed);
    return name.toLowerCase().includes('limit') ? Math.min(LIST_MAX_LIMIT, value) : value;
}

type FinalizeCloudDataForWriteOptions = {
    rejectInvalidBeforeRepair?: boolean;
};

const FINALIZE_REJECT_INVALID_REST_WRITE: FinalizeCloudDataForWriteOptions = {
    rejectInvalidBeforeRepair: true,
};

function finalizeCloudDataForWrite(
    data: AppData,
    nowIso: string,
    options: FinalizeCloudDataForWriteOptions = {},
): AppData | { error: Response } {
    if (options.rejectInvalidBeforeRepair) {
        const initialValidation = validateAppData(data);
        if (!initialValidation.ok) {
            return { error: errorResponse(initialValidation.error, 400) };
        }
    }
    const repaired = repairMergedSyncReferences(data, nowIso);
    const validated = validateAppData(repaired);
    if (!validated.ok) {
        return { error: errorResponse(validated.error, 400) };
    }
    return repaired;
}

type CloudEntity = {
    id: string;
    deletedAt?: string;
    updatedAt: string;
    rev?: number;
    revBy?: string;
};
type EntityCollectionKey = 'projects' | 'sections' | 'areas';
type EntityItemKey = 'project' | 'section' | 'area';

type EntityRouteDefinition<T extends CloudEntity> = {
    path: string;
    collectionKey: EntityCollectionKey;
    itemKey: EntityItemKey;
    listKey: EntityCollectionKey;
    label: string;
    invalidIdMessage: string;
    listItems: (data: AppData, url: URL) => T[];
    createEntity: (body: Record<string, unknown>, data: AppData, nowIso: string) => T | Response;
    canPatchDeletedEntity?: (body: Record<string, unknown>) => boolean;
    patchEntity: (body: Record<string, unknown>, existing: T, data: AppData, nowIso: string) => T | Response;
};

type EntityRouteContext = {
    key: string;
    filePath: string;
    maxBodyBytes: number;
    signal: AbortSignal;
    withWriteLock: ReturnType<typeof createWriteLockRunner>;
};

type EntityBodyResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; response: Response };

const isResponse = (value: unknown): value is Response => value instanceof Response;

const readEntityObjectBody = async (
    req: Request,
    maxBodyBytes: number,
    signal: AbortSignal
): Promise<EntityBodyResult> => {
    const body = await readJsonBody(req, maxBodyBytes, signal);
    if (isBodyReadError(body)) {
        const err = body.__mindwtrError;
        return {
            ok: false,
            response: errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413),
        };
    }
    const bodyRecord = readObjectBody(body);
    if (!bodyRecord) return { ok: false, response: errorResponse('Invalid JSON body') };
    return { ok: true, body: bodyRecord };
};

const getEntityCollection = <T extends CloudEntity>(data: AppData, route: EntityRouteDefinition<T>): T[] =>
    data[route.collectionKey] as unknown as T[];

const handleEntityRoute = async <T extends CloudEntity>(
    route: EntityRouteDefinition<T>,
    req: Request,
    pathname: string,
    url: URL,
    context: EntityRouteContext
): Promise<Response | null> => {
    if (req.method === 'GET' && pathname === route.path) {
        throwIfRequestAborted(context.signal);
        const pagination = parsePagination(url.searchParams);
        if ('error' in pagination) return errorResponse(pagination.error, 400);
        const data = loadAppData(context.filePath);
        const items = route.listItems(data, url);
        const total = items.length;
        return jsonResponse({
            [route.listKey]: items.slice(pagination.offset, pagination.offset + pagination.limit),
            total,
            limit: pagination.limit,
            offset: pagination.offset,
        });
    }

    if (req.method === 'POST' && pathname === route.path) {
        const bodyResult = await readEntityObjectBody(req, context.maxBodyBytes, context.signal);
        if (!bodyResult.ok) return bodyResult.response;

        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const data = loadAppData(context.filePath);
            const nowIso = new Date().toISOString();
            const entity = route.createEntity(bodyResult.body, data, nowIso);
            if (isResponse(entity)) return entity;
            getEntityCollection(data, route).push(entity);
            const finalized = finalizeCloudDataForWrite(data, nowIso);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized);
            return jsonResponse({ [route.itemKey]: entity }, { status: 201 });
        });
    }

    const entityMatch = pathname.match(new RegExp(`^${route.path}/([^/]+)$`));
    if (!entityMatch) return null;
    const entityId = parseEntityRouteId(entityMatch[1]);
    if (!entityId) return errorResponse(route.invalidIdMessage, 400);

    if (req.method === 'GET') {
        const data = loadAppData(context.filePath);
        const entity = getEntityCollection(data, route).find((item) => item.id === entityId && !item.deletedAt);
        if (!entity) return errorResponse(`${route.label} not found`, 404);
        return jsonResponse({ [route.itemKey]: entity });
    }

    if (req.method === 'PATCH') {
        const bodyResult = await readEntityObjectBody(req, context.maxBodyBytes, context.signal);
        if (!bodyResult.ok) return bodyResult.response;

        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const data = loadAppData(context.filePath);
            const collection = getEntityCollection(data, route);
            const idx = collection.findIndex((item) => (
                item.id === entityId
                && (!item.deletedAt || route.canPatchDeletedEntity?.(bodyResult.body))
            ));
            if (idx < 0) return errorResponse(`${route.label} not found`, 404);
            const nowIso = new Date().toISOString();
            const updated = route.patchEntity(bodyResult.body, collection[idx], data, nowIso);
            if (isResponse(updated)) return updated;
            collection[idx] = updated;
            const finalized = finalizeCloudDataForWrite(data, nowIso);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized);
            const entity = getEntityCollection(finalized, route).find((item) => item.id === entityId);
            return jsonResponse({ [route.itemKey]: entity });
        });
    }

    if (req.method === 'DELETE') {
        return await context.withWriteLock(context.key, async () => {
            throwIfRequestAborted(context.signal);
            const data = loadAppData(context.filePath);
            const collection = getEntityCollection(data, route);
            const idx = collection.findIndex((item) => item.id === entityId && !item.deletedAt);
            if (idx < 0) return errorResponse(`${route.label} not found`, 404);
            const nowIso = new Date().toISOString();
            const existing = collection[idx];
            collection[idx] = {
                ...existing,
                deletedAt: nowIso,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
            const finalized = finalizeCloudDataForWrite(data, nowIso);
            if ('error' in finalized) return finalized.error;
            throwIfRequestAborted(context.signal);
            writeCloudData(context.filePath, finalized);
            return jsonResponse({ ok: true });
        });
    }

    return null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The route table is heterogeneous; each route owns its entity type.
const ENTITY_ROUTES: Array<EntityRouteDefinition<any>> = [
    {
        path: '/v1/projects',
        collectionKey: 'projects',
        itemKey: 'project',
        listKey: 'projects',
        label: 'Project',
        invalidIdMessage: 'Invalid project id',
        listItems: (data, url) => (
            url.searchParams.get('deleted') === '1' ? data.projects : filterNotDeleted(data.projects)
        ),
        createEntity: (bodyRecord, data, nowIso): Project | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateProjectCreationProps(rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
            if (!title) return errorResponse('Missing project title');
            if (title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            const props = validatedProps.props as Record<string, unknown>;
            if (props.areaId !== undefined && typeof props.areaId !== 'string') return errorResponse('Invalid area id', 400);
            const areaId = typeof props.areaId === 'string' ? props.areaId.trim() : '';
            if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                return errorResponse('Area not found', 404);
            }
            const rawStatus = props.status;
            const status = rawStatus === undefined ? 'active' : asProjectStatus(rawStatus);
            if (!status) return errorResponse('Invalid project status', 400);
            const rawOrder = props.order;
            const rawTagIds = props.tagIds;
            const {
                status: _status,
                color: rawColor,
                order: _order,
                tagIds: _tagIds,
                areaId: _areaId,
                ...restProps
            } = props;
            return {
                id: generateUUID(),
                title,
                ...restProps,
                areaId: areaId || undefined,
                status,
                color: typeof rawColor === 'string' && rawColor.trim() ? rawColor : '#6B7280',
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.projects),
                tagIds: Array.isArray(rawTagIds) ? rawTagIds.filter((item): item is string => typeof item === 'string') : [],
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        canPatchDeletedEntity: isProjectPurgePatch,
        patchEntity: (bodyRecord, existing: Project, data, nowIso): Project | Response => {
            const validatedPatch = validateProjectPatchProps(bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            const purgingProject = isProjectPurgePatch(bodyRecord);
            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing project title');
            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (updates.status !== undefined && !asProjectStatus(updates.status)) return errorResponse('Invalid project status', 400);
            if (updates.areaId !== undefined && updates.areaId !== null && typeof updates.areaId !== 'string') {
                return errorResponse('Invalid area id', 400);
            }
            if (typeof updates.areaId === 'string' && updates.areaId.trim() === '') return errorResponse('Invalid area id', 400);
            const areaId = updates.areaId === null
                ? null
                : typeof updates.areaId === 'string'
                    ? updates.areaId.trim()
                    : undefined;
            if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                return errorResponse('Area not found', 404);
            }
            const updatedProject = {
                ...existing,
                ...updates,
                title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                areaId: areaId !== undefined ? areaId ?? undefined : existing.areaId,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
            if (!purgingProject) return updatedProject;

            const pendingDeletes = collectPendingRemoteDeletesForProjectPurge(updatedProject, data);
            data.settings = appendPendingRemoteAttachmentDeletes(data.settings, pendingDeletes);
            return {
                ...updatedProject,
                deletedAt: typeof updatedProject.deletedAt === 'string' ? updatedProject.deletedAt : nowIso,
                purgedAt: typeof updates.purgedAt === 'string' ? updates.purgedAt : updatedProject.purgedAt,
                attachments: stripProjectAttachmentRemoteMetadata(updatedProject.attachments),
            };
        },
    },
    {
        path: '/v1/sections',
        collectionKey: 'sections',
        itemKey: 'section',
        listKey: 'sections',
        label: 'Section',
        invalidIdMessage: 'Invalid section id',
        listItems: (data, url) => {
            let sections = url.searchParams.get('deleted') === '1' ? data.sections : filterNotDeleted(data.sections);
            const projectId = url.searchParams.get('projectId');
            if (projectId) sections = sections.filter((section) => section.projectId === projectId);
            return sections;
        },
        createEntity: (bodyRecord, data, nowIso): Section | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateSectionCreationProps(rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
            const projectId = typeof bodyRecord.projectId === 'string' ? bodyRecord.projectId.trim() : '';
            if (!title) return errorResponse('Missing section title');
            if (title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (!projectId) return errorResponse('Missing project id');
            if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                return errorResponse('Project not found', 404);
            }
            const props = validatedProps.props as Record<string, unknown>;
            const rawOrder = props.order;
            const { order: _order, ...restProps } = props;
            return {
                id: generateUUID(),
                projectId,
                title,
                ...restProps,
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder)
                    ? rawOrder
                    : nextOrder(data.sections.filter((item) => item.projectId === projectId)),
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        patchEntity: (bodyRecord, existing: Section, data, nowIso): Section | Response => {
            const validatedPatch = validateSectionPatchProps(bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing section title');
            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            if (updates.projectId !== undefined && typeof updates.projectId !== 'string') {
                return errorResponse('Invalid project id', 400);
            }
            const projectId = typeof updates.projectId === 'string' ? updates.projectId.trim() : existing.projectId;
            if (!projectId) return errorResponse('Missing project id');
            if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                return errorResponse('Project not found', 404);
            }
            return {
                ...existing,
                ...updates,
                projectId,
                title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
    },
    {
        path: '/v1/areas',
        collectionKey: 'areas',
        itemKey: 'area',
        listKey: 'areas',
        label: 'Area',
        invalidIdMessage: 'Invalid area id',
        listItems: (data, url) => (
            url.searchParams.get('deleted') === '1' ? data.areas : filterNotDeleted(data.areas)
        ),
        createEntity: (bodyRecord, data, nowIso): Area | Response => {
            const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
            const validatedProps = validateAreaCreationProps(rawProps);
            if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
            const name = typeof bodyRecord.name === 'string' ? bodyRecord.name.trim() : '';
            if (!name) return errorResponse('Missing area name');
            if (name.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Area name too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            const props = validatedProps.props as Record<string, unknown>;
            const rawOrder = props.order;
            const { order: _order, ...restProps } = props;
            return {
                id: generateUUID(),
                name,
                ...restProps,
                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.areas),
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
        patchEntity: (bodyRecord, existing: Area, _data, nowIso): Area | Response => {
            const validatedPatch = validateAreaPatchProps(bodyRecord);
            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
            const updates = validatedPatch.props;
            if (typeof updates.name === 'string' && !updates.name.trim()) return errorResponse('Missing area name');
            if (typeof updates.name === 'string' && updates.name.length > MAX_TASK_TITLE_LENGTH) {
                return errorResponse(`Area name too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
            }
            return {
                ...existing,
                ...updates,
                name: typeof updates.name === 'string' ? updates.name.trim() : existing.name,
                updatedAt: nowIso,
                rev: normalizeRevision(existing.rev) + 1,
                revBy: CLOUD_API_REV_BY,
            };
        },
    },
];

function namespaceExists(dataDir: string, key: string): boolean {
    return existsSync(join(dataDir, `${key}.json`)) || existsSync(join(dataDir, key));
}

function countTokenNamespaces(dataDir: string): number {
    const namespaces = new Set<string>();
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.isFile()) {
            const match = entry.name.match(TOKEN_NAMESPACE_FILE_PATTERN);
            if (match?.[1]) namespaces.add(match[1]);
        } else if (entry.isDirectory() && TOKEN_NAMESPACE_DIR_PATTERN.test(entry.name)) {
            namespaces.add(entry.name);
        }
    }
    return namespaces.size;
}

function resolveServerMergeTimestamp(..._dataSets: AppData[]): string {
    return new Date().toISOString();
}

function isProjectPurgePatch(bodyRecord: Record<string, unknown>): boolean {
    return typeof bodyRecord.purgedAt === 'string' && bodyRecord.purgedAt.trim().length > 0;
}

const stripProjectAttachmentRemoteMetadata = (attachments: Project['attachments']): Project['attachments'] => (
    attachments?.map((attachment) => (
        attachment.kind === 'file'
            ? {
                ...attachment,
                cloudKey: undefined,
                localStatus: undefined,
            }
            : attachment
    ))
);

const getAttachmentCloudKey = (attachment: Attachment): string | null => {
    if (attachment.kind !== 'file' || !attachment.cloudKey) return null;
    return normalizeAttachmentRelativePath(attachment.cloudKey);
};

const collectRetainedAttachmentCloudKeysForProjectPurge = (data: AppData, purgedProjectId: string): Set<string> => {
    const cloudKeys = new Set<string>();
    for (const project of data.projects) {
        if (project.id === purgedProjectId || project.purgedAt) continue;
        for (const attachment of project.attachments || []) {
            const cloudKey = getAttachmentCloudKey(attachment);
            if (cloudKey) cloudKeys.add(cloudKey);
        }
    }
    for (const task of data.tasks) {
        if (task.purgedAt) continue;
        for (const attachment of task.attachments || []) {
            const cloudKey = getAttachmentCloudKey(attachment);
            if (cloudKey) cloudKeys.add(cloudKey);
        }
    }
    return cloudKeys;
};

const collectPendingRemoteDeletesForProjectPurge = (
    project: Project,
    data: AppData,
): PendingRemoteAttachmentDelete[] => {
    const retainedCloudKeys = collectRetainedAttachmentCloudKeysForProjectPurge(data, project.id);
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const attachment of project.attachments || []) {
        const cloudKey = getAttachmentCloudKey(attachment);
        if (!cloudKey || retainedCloudKeys.has(cloudKey) || byCloudKey.has(cloudKey)) continue;
        byCloudKey.set(cloudKey, {
            cloudKey,
            title: attachment.title || cloudKey,
        });
    }
    return Array.from(byCloudKey.values());
};

const appendPendingRemoteAttachmentDeletes = (
    settings: AppData['settings'],
    pendingDeletes: readonly PendingRemoteAttachmentDelete[],
): AppData['settings'] => {
    if (pendingDeletes.length === 0) return settings;
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const existing of settings.attachments?.pendingRemoteDeletes || []) {
        byCloudKey.set(existing.cloudKey, existing);
    }
    for (const pending of pendingDeletes) {
        if (byCloudKey.has(pending.cloudKey)) continue;
        byCloudKey.set(pending.cloudKey, pending);
    }
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: Array.from(byCloudKey.values()),
        },
    };
};

function collectReferencedAttachmentCloudKeys(data: AppData): Set<string> {
    const referenced = new Set<string>();
    const collect = (attachments: Attachment[] | undefined, ownerDeleted?: string) => {
        if (ownerDeleted) return;
        for (const attachment of attachments ?? []) {
            if (attachment.kind !== 'file' || attachment.deletedAt || !attachment.cloudKey) continue;
            const normalized = normalizeAttachmentRelativePath(attachment.cloudKey);
            if (normalized) referenced.add(normalized);
        }
    };
    data.tasks.forEach((task) => collect(task.attachments, task.deletedAt));
    data.projects.forEach((project) => collect(project.attachments, project.deletedAt));
    return referenced;
}

function garbageCollectOrphanAttachments(dataDir: string, key: string, data: AppData): {
    deleted: number;
    errors: string[];
    kept: number;
    scanned: number;
} {
    const rootDir = join(dataDir, key, 'attachments');
    if (!existsSync(rootDir)) return { deleted: 0, errors: [], kept: 0, scanned: 0 };
    mkdirSync(rootDir, { recursive: true });
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return {
            deleted: 0,
            errors: ['attachment root is not a normal directory'],
            kept: 0,
            scanned: 0,
        };
    }
    const rootRealPath = realpathSync(rootDir);
    const referenced = collectReferencedAttachmentCloudKeys(data);
    const errors: string[] = [];
    let deleted = 0;
    let kept = 0;
    let scanned = 0;

    const visit = (dirPath: string) => {
        for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
            const entryPath = join(dirPath, dirent.name);
            let stat;
            try {
                stat = lstatSync(entryPath);
            } catch (error) {
                errors.push(`${relative(rootRealPath, entryPath)}: ${(error as Error).message}`);
                continue;
            }
            if (stat.isDirectory()) {
                visit(entryPath);
                try {
                    if (entryPath !== rootRealPath) rmdirSync(entryPath);
                } catch {
                    // Directory still has referenced files or concurrent writes.
                }
                continue;
            }

            scanned += 1;
            const relativePath = normalizeAttachmentRelativePath(relative(rootRealPath, entryPath).replace(/\\/g, '/'));
            if (!relativePath || referenced.has(relativePath)) {
                kept += 1;
                continue;
            }
            if (stat.mtimeMs > Date.now() - ORPHAN_ATTACHMENT_GC_GRACE_MS) {
                kept += 1;
                continue;
            }
            try {
                unlinkSync(entryPath);
                deleted += 1;
            } catch (error) {
                errors.push(`${relativePath}: ${(error as Error).message}`);
            }
        }
    };

    visit(rootRealPath);
    return { deleted, errors, kept, scanned };
}

export const __cloudTestUtils = {
    parseArgs,
    getToken,
    tokenToKey,
    parseAllowedAuthTokens,
    parseBoolEnv,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    isAuthorizedToken,
    getClientIp,
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    toRateLimitRoute,
    validateAppData,
    asStatus,
    validateTaskCreationProps,
    validateTaskPatchProps,
    pickTaskList,
    readJsonBody,
    isBodyReadError,
    resolveServerMergeTimestamp,
    writeData,
    resolveAttachmentPath,
    normalizeAttachmentRelativePath,
    isPathWithinRoot,
    pathContainsSymlink,
    createWriteLockRunner,
    createInternalServerErrorResponse,
    ...__serverDataCacheTestUtils,
    getParsedDataCacheMaxEntries: __serverDataCacheTestUtils.getDataCacheMaxEntries,
};

type CloudServerOptions = {
    port?: number;
    host?: string;
    dataDir?: string;
    windowMs?: number;
    maxPerWindow?: number;
    maxAttachmentPerWindow?: number;
    maxBodyBytes?: number;
    maxAttachmentBytes?: number;
    requestTimeoutMs?: number;
    allowedAuthTokens?: AllowedAuthTokenInput;
    trustProxyHeaders?: boolean;
    trustedProxyIps?: Set<string> | null;
    maxAnyTokenNamespaces?: number;
};

type CloudServerHandle = {
    stop: () => void;
    port: number;
};

export async function startCloudServer(options: CloudServerOptions = {}): Promise<CloudServerHandle> {
    const flags = parseArgs(process.argv.slice(2));
    const port = Number(options.port ?? flags.port ?? process.env.PORT ?? 8787);
    const host = String(options.host ?? flags.host ?? process.env.HOST ?? '0.0.0.0');
    const dataDir = String(options.dataDir ?? process.env.MINDWTR_CLOUD_DATA_DIR ?? join(process.cwd(), 'data'));

    // ── Task-changes webhook (our fork addition) ───────────────────────
    // Fire-and-forget POST to ai-service on user-originated task
    // create/edit/delete so the Enricher pipeline picks up Mindwtr-side
    // changes (FR80). Skipped when the inbound request itself came from
    // ai-service (X-Mindwtr-Source: ai-service) to avoid feedback loops.
    const taskWebhookUrl = String(process.env.MINDWTR_TASK_WEBHOOK_URL || '').trim();
    const taskWebhookToken = String(process.env.MINDWTR_TASK_WEBHOOK_TOKEN || '').trim();
    const fireTaskWebhook = (
        kind: 'create' | 'edit' | 'delete',
        taskId: string,
        fields?: Record<string, unknown>
    ): void => {
        if (!taskWebhookUrl) return;
        const body = JSON.stringify(kind === 'delete' ? { kind, taskId } : { kind, taskId, fields });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (taskWebhookToken) headers.Authorization = `Bearer ${taskWebhookToken}`;
        fetch(taskWebhookUrl, { method: 'POST', headers, body }).catch((err) => {
            console.warn('[task-webhook] fire failed:', (err as Error).message);
        });
    };

    const rateLimits = new Map<string, RateLimitState>();
    const windowMs = Number(options.windowMs ?? process.env.MINDWTR_CLOUD_RATE_WINDOW_MS ?? 60_000);
    const maxPerWindow = Number(options.maxPerWindow ?? process.env.MINDWTR_CLOUD_RATE_MAX ?? 120);
    const maxAttachmentPerWindow = Number(
        options.maxAttachmentPerWindow ?? process.env.MINDWTR_CLOUD_ATTACHMENT_RATE_MAX ?? maxPerWindow
    );
    const maxBodyBytes = Number(options.maxBodyBytes ?? process.env.MINDWTR_CLOUD_MAX_BODY_BYTES ?? 2_000_000);
    const maxAttachmentBytes = Number(
        options.maxAttachmentBytes ?? process.env.MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES ?? 50_000_000
    );
    const allowedAuthTokens = normalizeAllowedAuthTokens(
        options.allowedAuthTokens === undefined
            ? resolveAllowedAuthTokensFromEnv(process.env)
            : options.allowedAuthTokens
    );
    const trustProxyHeaders = options.trustProxyHeaders ?? parseBoolEnv(process.env.MINDWTR_CLOUD_TRUST_PROXY_HEADERS);
    const trustedProxyIps = options.trustedProxyIps ?? parseTrustedProxyIps(process.env.MINDWTR_CLOUD_TRUSTED_PROXY_IPS);
    const rawMaxAnyTokenNamespaces = Number(
        options.maxAnyTokenNamespaces
        ?? process.env.MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES
        ?? ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT
    );
    const maxAnyTokenNamespaces = Number.isFinite(rawMaxAnyTokenNamespaces) && rawMaxAnyTokenNamespaces >= 0
        ? Math.floor(rawMaxAnyTokenNamespaces)
        : ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT;
    const withWriteLock = createWriteLockRunner(dataDir);
    const rateLimitCleanupMs = Number(process.env.MINDWTR_CLOUD_RATE_CLEANUP_MS || 60_000);
    const requestTimeoutMs = Number(options.requestTimeoutMs ?? process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS ?? 30_000);

    const pruneExpiredRateLimits = (now: number) => {
        for (const [key, state] of rateLimits.entries()) {
            if (now > state.resetAt) {
                rateLimits.delete(key);
            }
        }
    };

    const findLeastRecentlyUsedRateLimitKey = (): string | null => {
        let oldestKey: string | null = null;
        let oldestSeenAt = Number.POSITIVE_INFINITY;
        let oldestResetAt = Number.POSITIVE_INFINITY;
        for (const [key, state] of rateLimits.entries()) {
            if (
                state.lastSeenAt < oldestSeenAt
                || (state.lastSeenAt === oldestSeenAt && state.resetAt < oldestResetAt)
            ) {
                oldestKey = key;
                oldestSeenAt = state.lastSeenAt;
                oldestResetAt = state.resetAt;
            }
        }
        return oldestKey;
    };

    const ensureRateLimitCapacity = (now: number) => {
        pruneExpiredRateLimits(now);
        while (rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
            const oldestKey = findLeastRecentlyUsedRateLimitKey();
            if (!oldestKey) break;
            rateLimits.delete(oldestKey);
        }
    };

    const checkRateLimit = (rateKey: string, maxAllowed: number): Response | null => {
        const now = Date.now();
        const state = rateLimits.get(rateKey);
        if (state && now < state.resetAt) {
            state.count += 1;
            state.lastSeenAt = now;
            if (state.count > maxAllowed) {
                const retryAfter = Math.ceil((state.resetAt - now) / 1000);
                return jsonResponse(
                    { error: 'Rate limit exceeded', retryAfterSeconds: retryAfter },
                    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
                );
            }
            return null;
        }
        if (!state && rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
            ensureRateLimitCapacity(now);
        }
        rateLimits.set(rateKey, { count: 1, resetAt: now + windowMs, lastSeenAt: now });
        return null;
    };

    const ensureNamespaceWriteAllowed = (key: string): Response | null => {
        if (allowedAuthTokens) return null;
        if (namespaceExists(dataDir, key)) return null;
        if (maxAnyTokenNamespaces <= 0) {
            return errorResponse('Token namespace creation is disabled', 403);
        }
        if (countTokenNamespaces(dataDir) >= maxAnyTokenNamespaces) {
            return errorResponse('Token namespace limit reached', 403);
        }
        return null;
    };

    const unauthorizedResponse = (req: Request, token?: string | null): Response => {
        const requestIp = (() => {
            const bunServer = server as { requestIP?: (request: Request) => { address?: string | null } | null };
            if (typeof bunServer.requestIP !== 'function') return null;
            return bunServer.requestIP(req)?.address ?? null;
        })();
        const authRateKey = getAuthFailureRateKey(req, {
            trustProxyHeaders,
            trustedProxyIps,
            requestIpAddress: requestIp,
        });
        const authRateLimitKeys = [
            authRateKey,
            getAuthFailureTokenRateKey({
                token,
                authHeader: req.headers.get('authorization'),
            }),
        ].filter((key): key is string => Boolean(key));
        for (const key of authRateLimitKeys) {
            const authRateLimitResponse = checkRateLimit(key, AUTH_FAILURE_RATE_MAX);
            if (authRateLimitResponse) {
                return authRateLimitResponse;
            }
        }
        return errorResponse('Unauthorized', 401);
    };

    const cleanupTimer = setInterval(() => {
        pruneExpiredRateLimits(Date.now());
    }, rateLimitCleanupMs);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }

    logInfo(`dataDir: ${dataDir}`);
    const usingLegacyTokenVar = options.allowedAuthTokens === undefined
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS || '').trim()
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS_FILE || '').trim()
        && (
            String(process.env.MINDWTR_CLOUD_TOKEN || '').trim().length > 0
            || String(process.env.MINDWTR_CLOUD_TOKEN_FILE || '').trim().length > 0
        );
    if (usingLegacyTokenVar) {
        logWarn('MINDWTR_CLOUD_TOKEN is deprecated; use MINDWTR_CLOUD_AUTH_TOKENS instead');
    }
    if (allowedAuthTokens) {
        logInfo('token auth allowlist enabled', { allowedTokens: String(allowedAuthTokens.size) });
    } else {
        logInfo('token namespace mode enabled by explicit opt-in', {
            hint: 'set MINDWTR_CLOUD_AUTH_TOKENS to enforce a strict token allowlist',
            maxNamespaces: String(maxAnyTokenNamespaces),
        });
    }
    if (trustProxyHeaders) {
        if (trustedProxyIps.size > 0) {
            logWarn('trusting proxy IP headers for auth failure rate limiting', {
                trustedProxyIps: String(trustedProxyIps.size),
                hint: 'only requests from MINDWTR_CLOUD_TRUSTED_PROXY_IPS can supply forwarded client IP headers',
            });
        } else {
            logWarn('MINDWTR_CLOUD_TRUST_PROXY_HEADERS is enabled but no trusted proxy IPs are configured; forwarded IP headers will be ignored', {
                hint: 'set MINDWTR_CLOUD_TRUSTED_PROXY_IPS to the exact reverse-proxy source IPs',
            });
        }
    }
    if (!ensureWritableDir(dataDir)) {
        throw new Error(`Cloud data directory is not writable: ${dataDir}`);
    }
    logInfo(`listening on http://${host}:${port}`);

    const bunRuntime = getBunRuntime();
    if (!bunRuntime) {
        throw new Error('Mindwtr Cloud requires the Bun runtime.');
    }

    // Bun's default idleTimeout is 10s — too short for a full /v1/data PUT
    // (multi-MB AppData blob) on a slow uplink. Bumped to 120s; clients still
    // have their own request-level abort via `requestTimeoutMs`.
    const idleTimeoutSec = Math.max(
        10,
        Number(process.env.MINDWTR_CLOUD_IDLE_TIMEOUT_SEC) || 120
    );
    const server = bunRuntime.serve({
        hostname: host,
        port,
        idleTimeout: idleTimeoutSec,
        async fetch(req: Request) {
          return withCorsContext(req, async () => {
            const requestId = generateRequestId();
            const requestAbortController = new AbortController();
            const requestTimeout = setTimeout(() => {
                requestAbortController.abort(createRequestAbortError('Request timed out', 408));
            }, requestTimeoutMs);
            try {
                throwIfRequestAborted(requestAbortController.signal);
                if (req.method === 'OPTIONS') return preflightResponse();

                const url = new URL(req.url);
                const pathname = url.pathname.replace(/\/+$/, '') || '/';

                if (req.method === 'GET' && pathname === '/health') {
                    return jsonResponse({ ok: true });
                }

                if (
                    pathname === '/v1/tasks'
                    || pathname === '/v1/projects'
                    || pathname === '/v1/sections'
                    || pathname === '/v1/areas'
                    || pathname === '/v1/search'
                    || pathname.startsWith('/v1/tasks/')
                    || pathname.startsWith('/v1/projects/')
                    || pathname.startsWith('/v1/sections/')
                    || pathname.startsWith('/v1/areas/')
                ) {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const routeKey = toRateLimitRoute(pathname);
                    const rateKey = `${key}:${req.method}:${routeKey}`;
                    const rateLimitResponse = checkRateLimit(rateKey, maxPerWindow);
                    if (rateLimitResponse) return rateLimitResponse;
                    const filePath = join(dataDir, `${key}.json`);
                    if (req.method !== 'GET') {
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
                    }

                    if (req.method === 'GET' && pathname === '/v1/tasks') {
                        const query = url.searchParams.get('query') || '';
                        const includeAll = url.searchParams.get('all') === '1';
                        const includeDeleted = url.searchParams.get('deleted') === '1';
                        const rawStatus = url.searchParams.get('status');
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const status = asStatus(rawStatus);
                        if (rawStatus !== null && status === null) {
                            return errorResponse('Invalid task status');
                        }
                        const data = loadAppData(filePath);
                        const tasks = pickTaskList(data, {
                            includeDeleted,
                            includeCompleted: includeAll,
                            status,
                            query,
                        });
                        const total = tasks.length;
                        const pageTasks = tasks.slice(pagination.offset, pagination.offset + pagination.limit);
                        return jsonResponse({ tasks: pageTasks, total, limit: pagination.limit, offset: pagination.offset });
                    }

                    if (req.method === 'POST' && pathname === '/v1/tasks') {
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        const bodyRecord = readObjectBody(body);
                        if (!bodyRecord) return errorResponse('Invalid JSON body');

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const nowIso = new Date().toISOString();

                            const input = typeof bodyRecord.input === 'string' ? bodyRecord.input : '';
                            const rawTitle = typeof bodyRecord.title === 'string' ? bodyRecord.title : '';
                            const rawInitialProps = readObjectBody(bodyRecord.props) ?? {};
                            const validatedInitialProps = validateTaskCreationProps(rawInitialProps);
                            if (!validatedInitialProps.ok) {
                                return errorResponse(validatedInitialProps.error, 400);
                            }
                            const initialProps = validatedInitialProps.props;
                            if (input.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
                                return errorResponse(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`, 400);
                            }

                            const parsed = input
                                ? parseQuickAdd(input, data.projects, new Date(nowIso), data.areas)
                                : { title: rawTitle, props: {} };
                            const title = (parsed.title || rawTitle || input).trim();
                            if (!title) return errorResponse('Missing task title');
                            if (title.length > MAX_TASK_TITLE_LENGTH) {
                                return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                            }

                            const props: Partial<Task> = {
                                ...parsed.props,
                                ...initialProps,
                            };

                            const rawStatus = props.status;
                            const parsedStatus = asStatus(rawStatus);
                            if (rawStatus !== undefined && parsedStatus === null) {
                                return errorResponse('Invalid task status', 400);
                            }
                            const status = parsedStatus || 'inbox';
                            const tags = Array.isArray(props.tags) ? props.tags : [];
                            const contexts = Array.isArray(props.contexts) ? props.contexts : [];
                            const {
                                id: _id,
                                title: _title,
                                createdAt: _createdAt,
                                updatedAt: _updatedAt,
                                status: _status,
                                tags: _tags,
                                contexts: _contexts,
                                ...restProps
                            } = props;
                            const task: Task = {
                                id: generateUUID(),
                                title,
                                ...restProps,
                                status,
                                tags,
                                contexts,
                                rev: 1,
                                revBy: CLOUD_API_REV_BY,
                                createdAt: nowIso,
                                updatedAt: nowIso,
                            } as Task;
                            if ((status === 'done' || status === 'archived') && !task.completedAt) {
                                task.completedAt = nowIso;
                            }

                            data.tasks.push(task);
                            const finalized = finalizeCloudDataForWrite(data, nowIso, FINALIZE_REJECT_INVALID_REST_WRITE);
                            if ('error' in finalized) return finalized.error;
                            const finalizedTask = finalized.tasks.find((item) => item.id === task.id) || task;
                            throwIfRequestAborted(requestAbortController.signal);
                            writeCloudData(filePath, finalized);

                            // Notify ai-service so manually-added cards (Mindwtr UI quick-add,
                            // sync from another device) flow through the Enricher pipeline.
                            // ai-service-originated creates skip this branch via the source guard.
                            if ((req.headers.get('x-mindwtr-source') || '') !== 'ai-service') {
                                fireTaskWebhook('create', finalizedTask.id, {
                                    title: finalizedTask.title,
                                    description: finalizedTask.description,
                                    status: finalizedTask.status,
                                    tags: finalizedTask.tags,
                                    projectId: finalizedTask.projectId ?? null,
                                });
                            }
                            return jsonResponse({ task: finalizedTask }, { status: 201 });
                        });
                    }

                    const actionMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/(complete|archive)$/);
                    if (actionMatch && req.method === 'POST') {
                        const taskId = parseTaskRouteId(actionMatch[1]);
                        if (!taskId) return errorResponse('Invalid task id', 400);
                        const action = actionMatch[2];
                        const status: TaskStatus = action === 'archive' ? 'archived' : 'done';

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                            if (idx < 0) return errorResponse('Task not found', 404);

                            const nowIso = new Date().toISOString();
                            const existing = data.tasks[idx];
                            const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                                existing,
                                {
                                    status,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                },
                                nowIso,
                            );
                            data.tasks[idx] = updatedTask;
                            if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                            const finalized = finalizeCloudDataForWrite(data, nowIso, FINALIZE_REJECT_INVALID_REST_WRITE);
                            if ('error' in finalized) return finalized.error;
                            const finalizedTask = finalized.tasks.find((item) => item.id === updatedTask.id) || updatedTask;
                            throwIfRequestAborted(requestAbortController.signal);
                            writeCloudData(filePath, finalized);
                            return jsonResponse({ task: finalizedTask });
                        });
                    }

                    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
                    if (taskMatch) {
                        const taskId = parseTaskRouteId(taskMatch[1]);
                        if (!taskId) return errorResponse('Invalid task id', 400);

                        if (req.method === 'GET') {
                            const data = loadAppData(filePath);
                            const task = data.tasks.find((t) => t.id === taskId && !t.deletedAt);
                            if (!task) return errorResponse('Task not found', 404);
                            return jsonResponse({ task });
                        }

                        if (req.method === 'PATCH') {
                            const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                            if (isBodyReadError(body)) {
                                const err = body.__mindwtrError;
                                return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                            }
                            const bodyRecord = readObjectBody(body);
                            if (!bodyRecord) return errorResponse('Invalid JSON body');
                            const validatedPatch = validateTaskPatchProps(bodyRecord);
                            if (!validatedPatch.ok) {
                                return errorResponse(validatedPatch.error, 400);
                            }
                            const updates = validatedPatch.props;
                            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                                return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                            }
                            const rawStatus = updates.status;
                            if (rawStatus !== undefined && asStatus(rawStatus) === null) {
                                return errorResponse('Invalid task status', 400);
                            }

                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                                if (idx < 0) return errorResponse('Task not found', 404);

                                const nowIso = new Date().toISOString();
                                const existing = data.tasks[idx];
                                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                                    existing,
                                    {
                                        ...updates,
                                        rev: normalizeRevision(existing.rev) + 1,
                                        revBy: CLOUD_API_REV_BY,
                                    },
                                    nowIso,
                                );

                                data.tasks[idx] = updatedTask;
                                if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                                const finalized = finalizeCloudDataForWrite(data, nowIso, FINALIZE_REJECT_INVALID_REST_WRITE);
                                if ('error' in finalized) return finalized.error;
                                const finalizedTask = finalized.tasks.find((item) => item.id === updatedTask.id) || updatedTask;
                                throwIfRequestAborted(requestAbortController.signal);
                                writeCloudData(filePath, finalized);

                                // DIAGNOSTIC: trace direct PATCH writes that promote a task
                                // into 'next'. Pinpoints HTTP integrations (e.g. ai-service)
                                // that keep moving someday tasks back to Next. Remove later.
                                if (finalizedTask.status === 'next' && existing.status !== 'next') {
                                    const sequential = finalizedTask.projectId
                                        ? (finalized.projects ?? []).some((p) => p && p.id === finalizedTask.projectId && p.isSequential === true)
                                        : false;
                                    logWarn('[status-trace] PATCH promoted task to next', {
                                        key,
                                        requestId,
                                        source: req.headers.get('x-mindwtr-source') || '(none)',
                                        userAgent: req.headers.get('user-agent') || '(none)',
                                        clientIp: getClientIp(req) || '(none)',
                                        taskId: finalizedTask.id,
                                        title: typeof finalizedTask.title === 'string' ? finalizedTask.title.slice(0, 60) : '',
                                        from: existing.status,
                                        projectId: finalizedTask.projectId ?? null,
                                        inSequentialProject: sequential,
                                    });
                                }

                                if ((req.headers.get('x-mindwtr-source') || '') !== 'ai-service') {
                                    fireTaskWebhook('edit', taskId, {
                                        title: finalizedTask.title,
                                        description: finalizedTask.description,
                                        status: finalizedTask.status,
                                        tags: finalizedTask.tags,
                                        projectId: finalizedTask.projectId ?? null,
                                    });
                                }
                                return jsonResponse({ task: finalizedTask });
                            });
                        }

                        if (req.method === 'DELETE') {
                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                                if (idx < 0) return errorResponse('Task not found', 404);

                                const nowIso = new Date().toISOString();
                                const existing = data.tasks[idx];
                                data.tasks[idx] = {
                                    ...existing,
                                    deletedAt: nowIso,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso, FINALIZE_REJECT_INVALID_REST_WRITE);
                                if ('error' in finalized) return finalized.error;
                                throwIfRequestAborted(requestAbortController.signal);
                                writeCloudData(filePath, finalized);

                                if ((req.headers.get('x-mindwtr-source') || '') !== 'ai-service') {
                                    fireTaskWebhook('delete', taskId);
                                }
                                return jsonResponse({ ok: true });
                            });
                        }
                    }

                    for (const entityRoute of ENTITY_ROUTES) {
                        const entityRouteResponse = await handleEntityRoute(entityRoute, req, pathname, url, {
                            key,
                            filePath,
                            maxBodyBytes,
                            signal: requestAbortController.signal,
                            withWriteLock,
                        });
                        if (entityRouteResponse) return entityRouteResponse;
                    }

                    if (req.method === 'GET' && pathname === '/v1/search') {
                        throwIfRequestAborted(requestAbortController.signal);
                        const query = url.searchParams.get('query') || '';
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const taskOffset = parseSearchPaginationValue(url.searchParams, 'taskOffset', pagination.offset);
                        if (typeof taskOffset !== 'number') return errorResponse(taskOffset.error, 400);
                        const projectOffset = parseSearchPaginationValue(url.searchParams, 'projectOffset', pagination.offset);
                        if (typeof projectOffset !== 'number') return errorResponse(projectOffset.error, 400);
                        const taskLimit = parseSearchPaginationValue(url.searchParams, 'taskLimit', pagination.limit);
                        if (typeof taskLimit !== 'number') return errorResponse(taskLimit.error, 400);
                        const projectLimit = parseSearchPaginationValue(url.searchParams, 'projectLimit', pagination.limit);
                        if (typeof projectLimit !== 'number') return errorResponse(projectLimit.error, 400);
                        const data = loadAppData(filePath);
                        const tasks = filterNotDeleted(data.tasks);
                        const projects = filterNotDeleted(data.projects);
                        const results = searchAll(tasks, projects, query);
                        const taskTotal = results.tasks.length;
                        const projectTotal = results.projects.length;
                        return jsonResponse({
                            tasks: results.tasks.slice(taskOffset, taskOffset + taskLimit),
                            projects: results.projects.slice(projectOffset, projectOffset + projectLimit),
                            taskTotal,
                            projectTotal,
                            limit: pagination.limit,
                            offset: pagination.offset,
                            taskLimit,
                            taskOffset,
                            projectLimit,
                            projectOffset,
                        });
                    }

                    if (
                        pathname.startsWith('/v1/tasks')
                        || pathname.startsWith('/v1/projects')
                        || pathname.startsWith('/v1/sections')
                        || pathname.startsWith('/v1/areas')
                        || pathname === '/v1/search'
                    ) {
                        return errorResponse('Method not allowed', 405);
                    }
                }

                if (pathname === '/v1/data') {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const dataRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                    const dataRateLimitResponse = checkRateLimit(dataRateKey, maxPerWindow);
                    if (dataRateLimitResponse) return dataRateLimitResponse;
                    const filePath = join(dataDir, `${key}.json`);

                    if (req.method === 'HEAD') {
                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) return emptyCorsResponse(404);
                            return dataMetadataResponse(filePath);
                        });
                    }

                    if (req.method === 'GET') {
                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) {
                                const namespaceResponse = ensureNamespaceWriteAllowed(key);
                                if (namespaceResponse) return namespaceResponse;
                                const emptyData: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
                                throwIfRequestAborted(requestAbortController.signal);
                                if (!existsSync(filePath)) writeCloudData(filePath, emptyData);
                                return jsonResponse(emptyData);
                            }
                            let rawData: Uint8Array;
                            try {
                                rawData = readFileSync(filePath);
                            } catch {
                                return errorResponse('Failed to read data', 500);
                            }
                            if (isTrustedValidatedDataFile(filePath)) {
                                return jsonFileResponse(rawData);
                            }
                            let data: unknown;
                            try {
                                const rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawData);
                                data = JSON.parse(rawText);
                            } catch {
                                return errorResponse('Failed to read data', 500);
                            }
                            const validated = validateStoredAppData(filePath, key, data);
                            if ('error' in validated) return validated.error;
                            return jsonFileResponse(rawData);
                        });
                    }

                    if (req.method === 'PUT') {
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        if (!body) return errorResponse('Missing body');
                        if (typeof body !== 'object') return errorResponse('Invalid JSON body');
                        const validated = validateAppData(body);
                        if (!validated.ok) return errorResponse(validated.error, 400);
                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const existingDataResult = loadExistingDataForMerge(filePath, key);
                            if ('error' in existingDataResult) return existingDataResult.error;
                            const existingData = existingDataResult;
                            const incomingData = validated.data;
                            const mergeTimestamp = resolveServerMergeTimestamp(existingData, incomingData);
                            const mergeResult = mergeAppDataWithStats(existingData, incomingData, {
                                nowIso: mergeTimestamp,
                            });
                            throwIfRequestAborted(requestAbortController.signal);
                            writeCloudData(filePath, mergeResult.data);

                            // Fire 'create' webhook for tasks that appear in the merged
                            // snapshot but weren't there before. That's how desktop UI's
                            // manual-add (Mindwtr quick-add) reaches the Enricher (FR80).
                            // Source guard prevents ai-service from re-triggering itself.
                            if ((req.headers.get('x-mindwtr-source') || '') !== 'ai-service' && taskWebhookUrl) {
                                const priorTaskIds = new Set<string>();
                                for (const t of existingData.tasks ?? []) {
                                    if (t && typeof t.id === 'string') priorTaskIds.add(t.id);
                                }
                                for (const task of mergeResult.data.tasks ?? []) {
                                    if (!task || typeof task.id !== 'string') continue;
                                    if (task.deletedAt) continue;
                                    if (priorTaskIds.has(task.id)) continue;
                                    fireTaskWebhook('create', task.id, {
                                        title: task.title,
                                        description: task.description,
                                        status: task.status,
                                        tags: task.tags,
                                        projectId: task.projectId ?? null,
                                    });
                                }
                            }
                            const metadata = getDataFileMetadata(filePath);
                            const contentLength = String(metadata.size);
                            const remoteFingerprint = buildHttpRemoteFileFingerprint('cloud', {
                                etag: metadata.etag,
                                lastModified: metadata.lastModified,
                                contentLength,
                            });
                            const incomingOnlyMerge = mergeAppDataWithStats({
                                tasks: [],
                                projects: [],
                                sections: [],
                                areas: [],
                                people: [],
                                settings: {},
                            }, incomingData, { nowIso: mergeTimestamp });
                            const serverMergedRemoteData = !areSyncPayloadsEqual(mergeResult.data, incomingOnlyMerge.data);
                            return jsonResponse({
                                ok: true,
                                stats: mergeResult.stats,
                                clockSkewWarning: mergeResult.clockSkewWarning ?? null,
                                remoteFingerprint,
                                etag: metadata.etag,
                                lastModified: metadata.lastModified,
                                contentLength,
                                serverMergedRemoteData,
                            }, {
                                headers: {
                                    ETag: metadata.etag,
                                    'Last-Modified': metadata.lastModified,
                                },
                            });
                        });
                    }
                }

                if (pathname === '/v1/attachments/orphans') {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const attachmentRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                    const attachmentRateLimitResponse = checkRateLimit(attachmentRateKey, maxAttachmentPerWindow);
                    if (attachmentRateLimitResponse) return attachmentRateLimitResponse;
                    if (req.method !== 'POST' && req.method !== 'DELETE') {
                        return errorResponse('Method not allowed', 405);
                    }

                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        const filePath = join(dataDir, `${key}.json`);
                        const data = loadAppData(filePath);
                        const validated = validateAppData(data);
                        if (!validated.ok) {
                            logWarn('Stored cloud data failed validation before attachment GC', { key, error: validated.error });
                            return errorResponse('Stored data failed validation', 500);
                        }
                        const result = garbageCollectOrphanAttachments(dataDir, key, data);
                        return jsonResponse({ ok: result.errors.length === 0, ...result });
                    });
                }

                if (pathname.startsWith('/v1/attachments/')) {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const attachmentRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                    const attachmentRateLimitResponse = checkRateLimit(attachmentRateKey, maxAttachmentPerWindow);
                    if (attachmentRateLimitResponse) return attachmentRateLimitResponse;

                    const resolvedAttachmentPath = resolveAttachmentPath(dataDir, key, pathname.slice('/v1/attachments/'.length));
                    if (!resolvedAttachmentPath) {
                        return errorResponse('Invalid attachment path', 400);
                    }
                    const { rootRealPath, filePath } = resolvedAttachmentPath;

                    if (req.method === 'GET') {
                        if (!existsSync(filePath)) return errorResponse('Not found', 404);
                        try {
                            const realFilePath = realpathSync(filePath);
                            if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                                return errorResponse('Invalid attachment path', 400);
                            }
                            const file = readFileSync(realFilePath);
                            const headers = new Headers();
                            headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin());
                            headers.set('Content-Type', 'application/octet-stream');
                            return new Response(file, { status: 200, headers });
                        } catch {
                            return errorResponse('Failed to read attachment', 500);
                        }
                    }

                    if (req.method === 'PUT') {
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
                        const contentType = normalizeAttachmentContentType(req.headers.get('content-type'));
                        if (contentType) {
                            const validation = await validateAttachmentForUpload({
                                id: 'attachment-upload',
                                kind: 'file',
                                title: pathname,
                                uri: '',
                                createdAt: '1970-01-01T00:00:00.000Z',
                                updatedAt: '1970-01-01T00:00:00.000Z',
                                mimeType: contentType,
                            } satisfies Attachment, 0);
                            if (!validation.valid && validation.error === 'mime_type_blocked') {
                                return errorResponse(`Blocked attachment content type: ${validation.details}`, 400);
                            }
                        }
                        const body = await readRequestBytes(req, maxAttachmentBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            return errorResponse(body.__mindwtrError.message, body.__mindwtrError.status);
                        }
                        const blockedSignature = getBlockedAttachmentSignature(body);
                        if (blockedSignature) {
                            return errorResponse(`Blocked executable attachment signature: ${blockedSignature}`, 400);
                        }
                        throwIfRequestAborted(requestAbortController.signal);
                        const wrote = writeAttachmentFileSafely(rootRealPath, filePath, body);
                        if (!wrote) return errorResponse('Invalid attachment path', 400);
                        return jsonResponse({ ok: true });
                    }

                    if (req.method === 'DELETE') {
                        if (!existsSync(filePath)) {
                            return jsonResponse({ ok: true });
                        }
                        try {
                            const realFilePath = realpathSync(filePath);
                            if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                                return errorResponse('Invalid attachment path', 400);
                            }
                            unlinkSync(realFilePath);
                            return jsonResponse({ ok: true });
                        } catch {
                            return errorResponse('Failed to delete attachment', 500);
                        }
                    }

                    return errorResponse('Method not allowed', 405);
                }

                return errorResponse('Not found', 404);
            } catch (error) {
                if (isRequestAbortError(error)) {
                    return errorResponse(error.message, error.status);
                }
                if (error && typeof error === 'object' && 'code' in error) {
                    const code = (error as { code?: unknown }).code;
                    if (code === 'EACCES') {
                        logError(`permission denied writing cloud data (requestId=${requestId})`, error);
                        return createInternalServerErrorResponse(
                            'Cloud data directory is not writable. Check volume permissions.',
                            requestId,
                        );
                    }
                }
                logError(`request failed (requestId=${requestId})`, error);
                return createInternalServerErrorResponse('Internal server error', requestId);
            } finally {
                clearTimeout(requestTimeout);
            }
          });
        },
    });

    let stopped = false;
    const stopServer = async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(cleanupTimer);
        try {
            await Promise.resolve((server as { stop?: (closeIdleConnections?: boolean) => void | Promise<void> }).stop?.(true));
        } catch {
            // Ignore stop errors during teardown.
        }
    };
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
    if (IS_MAIN_MODULE) {
        const handleSignal = (signal: NodeJS.Signals) => {
            logInfo(`received ${signal}, shutting down`);
            void stopServer().finally(() => process.exit(0));
        };
        for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
            const handler = () => handleSignal(signal);
            signalHandlers.push([signal, handler]);
            process.once(signal, handler);
        }
    }

    return {
        port: server.port,
        stop: () => {
            for (const [signal, handler] of signalHandlers) {
                process.off(signal, handler);
            }
            void stopServer();
        },
    };
}

if (IS_MAIN_MODULE) {
    startCloudServer().catch((err) => {
        logError('Failed to start server', err);
        process.exit(1);
    });
}
