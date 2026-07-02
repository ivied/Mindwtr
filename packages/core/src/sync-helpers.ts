import type { AppData, Attachment } from './types';
import { normalizeSavedFilters } from './saved-filters';
import { SYNC_FILE_NAME } from './sync-service-utils';

const MISSING_ATTACHMENT_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';

export type SoftDeletable = {
    deletedAt?: string | null;
};

export function filterNotDeleted<T extends SoftDeletable>(items: readonly T[]): T[] {
    return items.filter((item) => !item.deletedAt);
}

export type PendingAttachmentUpload = {
    ownerType: 'task' | 'project';
    ownerId: string;
    attachmentId: string;
    title: string;
    uriScheme: string;
    localStatus?: Attachment['localStatus'];
};

export const normalizeWebdavUrl = (rawUrl: string): string => {
    const splitIndex = rawUrl.search(/[?#]/);
    const pathEnd = splitIndex >= 0 ? splitIndex : rawUrl.length;
    const path = rawUrl.slice(0, pathEnd).replace(/\/+$/, '');
    const suffix = rawUrl.slice(pathEnd);
    const lowerPath = path.toLowerCase();
    const normalizedPath = lowerPath.endsWith(`/${SYNC_FILE_NAME}`) || lowerPath.endsWith('.json')
        ? path
        : `${path}/${SYNC_FILE_NAME}`;

    if (!suffix) return normalizedPath;
    const hashIndex = suffix.indexOf('#');
    const queryPart = suffix.startsWith('?')
        ? suffix.slice(0, hashIndex >= 0 ? hashIndex : suffix.length)
        : '';
    const hashPart = hashIndex >= 0 ? suffix.slice(hashIndex) : (suffix.startsWith('#') ? suffix : '');
    if (!queryPart) return `${normalizedPath}${hashPart}`;

    const params = new URLSearchParams(queryPart.slice(1));
    params.delete('_');
    const query = params.toString();
    return `${normalizedPath}${query ? `?${query}` : ''}${hashPart}`;
};

export const normalizeCloudUrl = (rawUrl: string): string => {
    const trimmed = rawUrl.replace(/\/+$/, '');
    const lower = trimmed.toLowerCase();

    if (lower.endsWith('/v1/data') || lower.endsWith('/data')) {
        return trimmed;
    }

    if (/\/v\d+$/i.test(trimmed)) {
        return `${trimmed}/data`;
    }

    return `${trimmed}/v1/data`;
};

const isLocalAttachmentUri = (uri: string): boolean => {
    const trimmed = uri.trim();
    if (!trimmed) return false;
    return !/^https?:\/\//i.test(trimmed);
};

const getAttachmentUriScheme = (uri: string): string => {
    const trimmed = uri.trim();
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    return match?.[1]?.toLowerCase() ?? (trimmed ? 'file' : 'empty');
};

const isLocalCalendarSourceUrl = (url: string): boolean => {
    const normalized = url.trim().toLowerCase();
    return normalized.startsWith('file://') || normalized.startsWith('content://');
};

const collectPendingUploads = (
    ownerType: PendingAttachmentUpload['ownerType'],
    ownerId: string,
    attachments?: Attachment[]
): PendingAttachmentUpload[] => {
    if (!attachments || attachments.length === 0) return [];

    return attachments
        .filter((attachment) => {
            if (attachment.kind !== 'file') return false;
            if (attachment.deletedAt) return false;
            if (attachment.cloudKey) return false;
            if (!isLocalAttachmentUri(attachment.uri)) return false;
            if (attachment.localStatus === 'missing') return false;
            return true;
        })
        .map((attachment) => ({
            ownerType,
            ownerId,
            attachmentId: attachment.id,
            title: attachment.title,
            uriScheme: getAttachmentUriScheme(attachment.uri),
            localStatus: attachment.localStatus,
        }));
};

export const findPendingAttachmentUploads = (data: AppData): PendingAttachmentUpload[] => {
    const pending: PendingAttachmentUpload[] = [];

    for (const task of data.tasks) {
        if (task.deletedAt) continue;
        pending.push(...collectPendingUploads('task', task.id, task.attachments));
    }

    for (const project of data.projects) {
        if (project.deletedAt) continue;
        pending.push(...collectPendingUploads('project', project.id, project.attachments));
    }

    return pending;
};

export const assertNoPendingAttachmentUploads = (data: AppData): void => {
    const pending = findPendingAttachmentUploads(data);
    if (pending.length === 0) return;

    const sample = pending
        .slice(0, 3)
        .map((item) => `${item.ownerType}:${item.ownerId}:${item.attachmentId}`)
        .join(', ');
    const extra = pending.length > 3 ? `, +${pending.length - 3} more` : '';
    throw new Error(
        `Attachment upload incomplete: ${pending.length} file attachment(s) are still pending upload (${sample}${extra}).`
    );
};

export const hasPendingSyncSideEffects = (data: AppData): boolean => (
    Boolean(data.settings.pendingRemoteWriteAt)
    || findPendingAttachmentUploads(data).length > 0
    || Boolean(data.settings.attachments?.pendingRemoteDeletes?.length)
);

export const sanitizeAppDataForRemote = (data: AppData): AppData => {
    const hasNonEmptyValue = (value: unknown): boolean => (
        typeof value === 'string' && value.trim().length > 0
    );
    const sanitizeAttachments = (attachments?: Attachment[], ownerDeleted = false): Attachment[] | undefined => {
        if (!attachments) return attachments;
        return attachments.map((attachment) => {
            if (attachment.kind !== 'file') return attachment;
            const hasCloudKey = hasNonEmptyValue(attachment.cloudKey);
            if (!attachment.deletedAt) {
                if ((ownerDeleted && !hasCloudKey) || (attachment.localStatus === 'missing' && !hasCloudKey)) {
                    const fallbackUpdatedAt = hasNonEmptyValue(attachment.updatedAt)
                        ? attachment.updatedAt
                        : MISSING_ATTACHMENT_TIMESTAMP_SENTINEL;
                    return {
                        ...attachment,
                        deletedAt: fallbackUpdatedAt,
                        updatedAt: fallbackUpdatedAt,
                        uri: '',
                        localStatus: undefined,
                    };
                }
            }
            return {
                ...attachment,
                uri: '',
                localStatus: undefined,
            };
        });
    };

    const sanitizeSettingsForRemote = (settings: AppData['settings']): AppData['settings'] => {
        const prefs = settings.syncPreferences ?? {};
        const next: AppData['settings'] = {
            syncPreferences: { ...prefs },
            syncPreferencesUpdatedAt: settings.syncPreferencesUpdatedAt
                ? { ...settings.syncPreferencesUpdatedAt }
                : undefined,
        };

        if (prefs.appearance === true) {
            next.theme = settings.theme;
            next.appearance = settings.appearance ? { ...settings.appearance } : settings.appearance;
            next.keybindingStyle = settings.keybindingStyle;
            // Desktop global shortcut registration is local runtime behavior and should never sync.
            next.globalQuickAddShortcut = undefined;
        }

        if (prefs.language === true) {
            next.language = settings.language;
            next.weekStart = settings.weekStart;
            next.dateFormat = settings.dateFormat;
            next.timeFormat = settings.timeFormat;
        }

        if (prefs.gtd === true) {
            if (
                settings.gtd?.defaultScheduleTime !== undefined
                || settings.gtd?.focusTaskLimit !== undefined
                || settings.gtd?.focusGroupBy !== undefined
                || settings.gtd?.defaultProjectFlowMode !== undefined
            ) {
                next.gtd = {
                    ...(settings.gtd.defaultScheduleTime !== undefined ? { defaultScheduleTime: settings.gtd.defaultScheduleTime } : {}),
                    ...(settings.gtd.focusTaskLimit !== undefined ? { focusTaskLimit: settings.gtd.focusTaskLimit } : {}),
                    ...(settings.gtd.focusGroupBy !== undefined ? { focusGroupBy: settings.gtd.focusGroupBy } : {}),
                    ...(settings.gtd.defaultProjectFlowMode !== undefined ? { defaultProjectFlowMode: settings.gtd.defaultProjectFlowMode } : {}),
                };
            }
        }

        if (prefs.savedFilters === true) {
            next.savedFilters = normalizeSavedFilters(settings.savedFilters);
        }

        if (prefs.externalCalendars === true) {
            next.externalCalendars = settings.externalCalendars
                ? settings.externalCalendars
                    .filter((item) => !isLocalCalendarSourceUrl(item.url))
                    .map((item) => ({ ...item }))
                : settings.externalCalendars;
        }

        if (prefs.ai === true && settings.ai) {
            next.ai = {
                ...settings.ai,
                apiKey: undefined,
                speechToText: settings.ai.speechToText
                    ? {
                        ...settings.ai.speechToText,
                        offlineModelPath: undefined,
                    }
                    : settings.ai.speechToText,
            };
        }

        return next;
    };

    return {
        ...data,
        tasks: data.tasks.map((task) => ({
            ...task,
            attachments: sanitizeAttachments(task.attachments, Boolean(task.deletedAt)),
        })),
        projects: data.projects.map((project) => ({
            ...project,
            attachments: sanitizeAttachments(project.attachments, Boolean(project.deletedAt)),
        })),
        settings: sanitizeSettingsForRemote(data.settings),
    };
};

const normalizeForSyncComparison = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeForSyncComparison(item));
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            normalized[key] = normalizeForSyncComparison(record[key]);
        }
        return normalized;
    }
    return value;
};

export const areSyncPayloadsEqual = (left: AppData, right: AppData): boolean =>
    JSON.stringify(normalizeForSyncComparison(left)) === JSON.stringify(normalizeForSyncComparison(right));

export const toStableSyncJson = (value: unknown): string =>
    JSON.stringify(normalizeForSyncComparison(value));

const hashStableSyncJson = (value: string): string => {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        left ^= code;
        left = Math.imul(left, 0x01000193);
        right ^= code + index;
        right = Math.imul(right, 0x85ebca6b);
        right ^= right >>> 13;
    }
    return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
};

export const computeStableValueFingerprint = (value: unknown): string => {
    const json = toStableSyncJson(value);
    return `stable-v1:${json.length}:${hashStableSyncJson(json)}`;
};

export const computeSyncPayloadFingerprint = (data: AppData): string =>
    computeStableValueFingerprint(sanitizeAppDataForRemote(data));

type ExternalCalendarProvider = {
    load: () => Promise<AppData['settings']['externalCalendars'] | undefined>;
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) => Promise<void>;
    onWarn?: (message: string, error?: unknown) => void;
};

export const injectExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<AppData> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return data;
    try {
        const stored = await provider.load();
        if (!stored || stored.length === 0) return data;
        if (data.settings.externalCalendars && data.settings.externalCalendars.length > 0) {
            return data;
        }
        return {
            ...data,
            settings: {
                ...data.settings,
                externalCalendars: stored,
            },
        };
    } catch (error) {
        provider.onWarn?.('Failed to load external calendars for sync', error);
        return data;
    }
};

export const persistExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<void> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return;
    try {
        await provider.save(data.settings.externalCalendars ?? []);
    } catch (error) {
        provider.onWarn?.('Failed to save external calendars from sync', error);
    }
};
