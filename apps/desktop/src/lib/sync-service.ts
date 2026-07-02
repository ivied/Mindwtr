
import {
    AppData,
    AppSettings,
    Attachment,
    useTaskStore,
    MergeStats,
    webdavGetJson,
    webdavHeadFile,
    webdavPutJson,
    cloudGetJson,
    cloudHeadJson,
    cloudPutJson,
    flushPendingSave,
    performSyncCycle,
    mergeAppData,
    normalizeAppData,
    normalizeWebdavUrl,
    normalizeCloudUrl,
    sanitizeAppDataForRemote,
    buildHttpRemoteFileFingerprint,
    computeStableValueFingerprint,
    computeSyncPayloadFingerprint,
    areSyncPayloadsEqual,
    assertNoPendingAttachmentUploads,
    buildMergeSummaryLog,
    buildPendingAttachmentUploadLogExtra,
    findPendingAttachmentUploads,
    findDeletedAttachmentsForFileCleanup,
    findOrphanedAttachments,
    injectExternalCalendars as injectExternalCalendarsForSync,
    persistExternalCalendars as persistExternalCalendarsForSync,
    summarizeMergeStats,
    withTimeout,
    withRetry,
    isRetryableWebdavReadError,
    isWebdavInvalidJsonError,
    CLOCK_SKEW_THRESHOLD_MS,
    appendSyncHistory,
    cloneAppData,
    createSyncOrchestrator,
    ensureFreshLocalSyncSnapshot,
    runPreSyncAttachmentPhase as runCorePreSyncAttachmentPhase,
    formatSyncErrorMessage,
    LocalSyncAbort,
    getInMemoryAppDataSnapshot,
    shouldRunAttachmentCleanup,
    createAbortableFetch,
    getTranslationsSync,
    isSupportedLanguage,
    LEGACY_SYNC_FILE_NAME,
    SYNC_FILE_NAME,
    type CloudJsonWriteResult,
    type CloudProvider,
    type PendingAttachmentUpload,
    type RemoteJsonWriteResult,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { getTauriHttpFetch } from './tauri-http';
import { reportError } from './report-error';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { useUiStore } from '../store/ui-store';
import { markLocalSqliteWrite, markLocalWrite } from './local-data-watcher';
import { ExternalCalendarService } from './external-calendar-service';
import { webStorage } from './storage-adapter-web';
import {
    cleanupAttachmentTempFiles,
    cleanupOrphanedAttachments,
    type AttachmentCleanupDeps,
} from './sync-attachment-cleanup';
import {
    clearAttachmentSyncState,
    type AttachmentBackendDeps,
    type CloudConfig,
    syncCloudAttachments,
    syncCloudKitAttachments,
    syncDropboxAttachments,
    syncFileAttachments,
    syncWebdavAttachments as syncAttachments,
    type WebDavConfig,
} from './sync-attachment-backends';
import {
    ensureCloudKitReady,
    readRemoteCloudKit,
    writeRemoteCloudKit,
} from './cloudkit-sync';
import {
    getBaseSyncUrl,
    getCloudBaseUrl,
} from './sync-attachments';
import {
    getFileSyncDir,
    hashString,
    isSyncFilePath,
    normalizeSyncBackend,
    toStableJson,
    yieldToRenderer,
} from './sync-service-utils';
import {
    clearAttachmentValidationFailures,
    getAttachmentValidationFailureAttempts,
    handleAttachmentValidationFailure,
} from './sync-attachment-validation';
import type { SyncBackend } from './sync-service-utils';
import {
    downloadDropboxAppData,
    DropboxConflictError,
    DropboxUnauthorizedError,
    getDropboxAppDataMetadata,
    testDropboxAccess,
    uploadDropboxAppData,
} from './dropbox-sync';
import {
    CLOUD_REMEMBER_TOKEN_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    getCloudConfigLocal,
    getSyncBackendLocal,
    getWebDavConfigLocal,
    readCloudConfig,
    readCloudProvider,
    readDropboxAppKey,
    readSyncBackend,
    readSyncPath,
    readWebDavConfig,
    writeCloudConfig,
    writeCloudProvider,
    writeDropboxAppKey,
    writeSyncBackend,
    writeSyncPath,
    writeWebDavConfig,
} from './sync-service-config';
import {
    buildFastSyncScope,
    clearLocalSyncStatus,
    clearFastSyncState,
    hasPendingSyncSideEffects,
    readLocalSyncStatus,
    readFastSyncState,
    writeLocalSyncStatus,
    writeFastSyncState,
    type FastSyncState,
} from './sync-service-fast-sync';

export type ExternalSyncChangeResolution = 'keep-local' | 'use-external' | 'merge';
export type { CloudProvider };

export type ExternalSyncChange = {
    at: string;
    incomingHash: string;
    syncPath: string;
    hasLocalChanges: boolean;
    localChangeAt: number;
    lastSyncAt?: string;
};

const DROPBOX_AUTH_RETRY_LIMIT = 1;
const WEBDAV_READ_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30_000,
    shouldRetry: isRetryableWebdavReadError,
};
const ATTACHMENT_WARNING_TOAST_THRESHOLD = 2;
const ATTACHMENT_WARNING_TOAST_COOLDOWN_MS = 10 * 60 * 1000;
type SyncServiceDependencies = {
    isTauriRuntime: () => boolean;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    getStoreState: typeof useTaskStore.getState;
    applySyncedDataToStore: (data: AppData) => void;
    flushPendingSave: typeof flushPendingSave;
    performSyncCycle: typeof performSyncCycle;
    getInMemoryAppDataSnapshot: typeof getInMemoryAppDataSnapshot;
    markLocalWrite: typeof markLocalWrite;
    markLocalSqliteWrite: typeof markLocalSqliteWrite;
    reportError: typeof reportError;
    logInfo: typeof logInfo;
    logWarn: typeof logWarn;
    logSyncError: typeof logSyncError;
    sanitizeLogMessage: typeof sanitizeLogMessage;
    getExternalCalendars: typeof ExternalCalendarService.getCalendars;
    setExternalCalendars: typeof ExternalCalendarService.setCalendars;
    ensureCloudKitReady: typeof ensureCloudKitReady;
    readRemoteCloudKit: typeof readRemoteCloudKit;
    writeRemoteCloudKit: typeof writeRemoteCloudKit;
};

const defaultInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as any, args as any);
};

const defaultGetTauriFetch = async (): Promise<typeof fetch | undefined> => {
    if (!syncServiceDependencies.isTauriRuntime()) return undefined;
    try {
        return await getTauriHttpFetch();
    } catch (error) {
        logSyncWarning('Failed to load tauri http fetch', error);
        return undefined;
    }
};

const applySyncedDataToStore = (data: AppData): void => {
    const normalized = normalizeAppData(data);
    const allTasks = Array.isArray(normalized.tasks) ? normalized.tasks : [];
    const allProjects = Array.isArray(normalized.projects) ? normalized.projects : [];
    const allSections = Array.isArray(normalized.sections) ? normalized.sections : [];
    const allAreas = Array.isArray(normalized.areas) ? normalized.areas : [];
    const allPeople = Array.isArray(normalized.people) ? normalized.people : [];

    useTaskStore.setState((state) => ({
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        _allPeople: allPeople,
        settings: normalized.settings ?? state.settings,
    }));
};

const defaultSyncServiceDependencies: SyncServiceDependencies = {
    isTauriRuntime,
    invoke: defaultInvoke,
    getTauriFetch: defaultGetTauriFetch,
    getStoreState: useTaskStore.getState,
    applySyncedDataToStore,
    flushPendingSave,
    performSyncCycle,
    getInMemoryAppDataSnapshot,
    markLocalWrite,
    markLocalSqliteWrite,
    reportError,
    logInfo,
    logWarn,
    logSyncError,
    sanitizeLogMessage,
    getExternalCalendars: () => ExternalCalendarService.getCalendars(),
    setExternalCalendars: (calendars) => ExternalCalendarService.setCalendars(calendars),
    ensureCloudKitReady,
    readRemoteCloudKit,
    writeRemoteCloudKit,
};

let syncServiceDependencies: SyncServiceDependencies = {
    ...defaultSyncServiceDependencies,
};

const isTauriRuntimeEnv = () => syncServiceDependencies.isTauriRuntime();
const getStoreState = () => syncServiceDependencies.getStoreState();
const fallbackSyncTranslations = getTranslationsSync('en');

const resolveSyncText = (key: string, fallback: string): string => {
    const language = getStoreState().settings?.language;
    const translations = language && isSupportedLanguage(language)
        ? getTranslationsSync(language)
        : fallbackSyncTranslations;
    return translations[key] || fallbackSyncTranslations[key] || fallback;
};

const logSyncWarning = (message: string, error?: unknown) => {
    const extra = error
        ? { error: syncServiceDependencies.sanitizeLogMessage(error instanceof Error ? error.message : String(error)) }
        : undefined;
    void syncServiceDependencies.logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
    void syncServiceDependencies.logInfo(message, { scope: 'sync', extra });
};

const isSyncPayloadTraceEnabled = (): boolean => (
    getStoreState().settings?.diagnostics?.loggingEnabled === true
);

const SYNC_TRACE_SURFACES = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings'] as const;
type SyncTraceSurface = typeof SYNC_TRACE_SURFACES[number];

const capitalizeTraceName = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const getSyncTraceSurfaceValue = (data: AppData, surface: SyncTraceSurface): unknown => {
    if (surface === 'settings') return data.settings ?? {};
    const value = data[surface];
    return Array.isArray(value) ? value : [];
};

const buildSyncPayloadSurfaceTraceExtra = (
    data: AppData,
    prefix = '',
): Record<string, string> => {
    const sanitized = sanitizeAppDataForRemote(data);
    return Object.fromEntries(
        SYNC_TRACE_SURFACES.map((surface) => {
            const name = `${prefix}${prefix ? capitalizeTraceName(surface) : surface}Sig`;
            return [name, computeStableValueFingerprint(getSyncTraceSurfaceValue(sanitized, surface))];
        }),
    );
};

const buildSyncPayloadTraceExtra = (
    data: AppData | null | undefined,
    extra: Record<string, string> = {},
): Record<string, string> => {
    if (!data) {
        return { ...extra, hasData: 'false' };
    }

    const areas = Array.isArray(data.areas) ? data.areas : [];
    const areaIds = areas
        .map((area) => `${area.id}${area.deletedAt ? ':deleted' : ''}`)
        .sort();
    return {
        ...extra,
        hasData: 'true',
        tasks: String(Array.isArray(data.tasks) ? data.tasks.length : 0),
        projects: String(Array.isArray(data.projects) ? data.projects.length : 0),
        sections: String(Array.isArray(data.sections) ? data.sections.length : 0),
        areas: String(areas.length),
        deletedAreas: String(areas.filter((area) => Boolean(area.deletedAt)).length),
        areaIdsSample: areaIds.slice(0, 24).join(','),
        areaIdsTruncated: String(areaIds.length > 24),
        pendingRemoteWrite: String(Boolean(data.settings?.pendingRemoteWriteAt)),
        fingerprint: computeSyncPayloadFingerprint(data),
        ...buildSyncPayloadSurfaceTraceExtra(data),
    };
};

const logSyncPayloadTrace = (
    message: string,
    data: AppData | null | undefined,
    extra?: Record<string, string>,
): void => {
    if (!isSyncPayloadTraceEnabled()) return;
    logSyncInfo(message, buildSyncPayloadTraceExtra(data, extra));
};

const MAX_TRACE_DIFF_ITEMS = 12;
const MAX_TRACE_DIFF_FIELDS = 16;

const isPlainTraceRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeTraceFieldPath = (path: string): string => (
    /(password|token|secret|authorization|api[-_.]?key)/i.test(path) ? '[sensitive]' : path
);

const collectChangedTracePaths = (
    left: unknown,
    right: unknown,
    prefix = '',
    depth = 0,
): string[] => {
    if (toStableJson(left) === toStableJson(right)) return [];
    if (depth >= 3 || !isPlainTraceRecord(left) || !isPlainTraceRecord(right)) {
        return [sanitizeTraceFieldPath(prefix || '<root>')];
    }
    const names = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    return names.flatMap((name) => {
        const nextPath = prefix ? `${prefix}.${name}` : name;
        return collectChangedTracePaths(left[name], right[name], nextPath, depth + 1);
    });
};

const getTraceRecordId = (item: Record<string, unknown>, index: number): string => {
    const id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : `index-${index}`;
    return id.length > 80 ? `${id.slice(0, 80)}...` : id;
};

const buildCollectionDiffTraceSample = (left: unknown, right: unknown): string => {
    const leftItems = Array.isArray(left) ? left.filter(isPlainTraceRecord) : [];
    const rightItems = Array.isArray(right) ? right.filter(isPlainTraceRecord) : [];
    const leftById = new Map(leftItems.map((item, index) => [getTraceRecordId(item, index), item] as const));
    const rightById = new Map(rightItems.map((item, index) => [getTraceRecordId(item, index), item] as const));
    const ids = Array.from(new Set([...leftById.keys(), ...rightById.keys()])).sort();
    const parts: string[] = [];

    for (const id of ids) {
        const leftItem = leftById.get(id);
        const rightItem = rightById.get(id);
        if (!leftItem) {
            parts.push(`${id}:onlySynced:${computeStableValueFingerprint(rightItem)}`);
        } else if (!rightItem) {
            parts.push(`${id}:onlyCurrent:${computeStableValueFingerprint(leftItem)}`);
        } else if (toStableJson(leftItem) !== toStableJson(rightItem)) {
            const fields = collectChangedTracePaths(leftItem, rightItem)
                .slice(0, MAX_TRACE_DIFF_FIELDS)
                .join('|');
            parts.push(`${id}:fields=${fields};current=${computeStableValueFingerprint(leftItem)};synced=${computeStableValueFingerprint(rightItem)}`);
        }
        if (parts.length >= MAX_TRACE_DIFF_ITEMS) break;
    }

    return parts.join(';');
};

const buildSyncPayloadDiffTraceExtra = (currentData: AppData, syncedData: AppData): Record<string, string> => {
    const current = sanitizeAppDataForRemote(currentData);
    const synced = sanitizeAppDataForRemote(syncedData);
    const changedSurfaces = SYNC_TRACE_SURFACES.filter((surface) => (
        toStableJson(getSyncTraceSurfaceValue(current, surface)) !== toStableJson(getSyncTraceSurfaceValue(synced, surface))
    ));
    const extra: Record<string, string> = {
        surfaceDiffs: changedSurfaces.join(',') || 'none',
        ...Object.fromEntries(SYNC_TRACE_SURFACES.map((surface) => [
            `${surface}Changed`,
            String(changedSurfaces.includes(surface)),
        ])),
        ...buildSyncPayloadSurfaceTraceExtra(current, 'current'),
        ...buildSyncPayloadSurfaceTraceExtra(synced, 'synced'),
    };

    for (const surface of SYNC_TRACE_SURFACES) {
        if (!changedSurfaces.includes(surface)) continue;
        const currentSurface = getSyncTraceSurfaceValue(current, surface);
        const syncedSurface = getSyncTraceSurfaceValue(synced, surface);
        if (surface === 'settings') {
            extra.settingsPaths = collectChangedTracePaths(currentSurface, syncedSurface)
                .slice(0, MAX_TRACE_DIFF_FIELDS)
                .join(',');
            continue;
        }
        extra[`${surface}Sample`] = buildCollectionDiffTraceSample(currentSurface, syncedSurface);
    }

    return extra;
};

const logPendingAttachmentUploads = (
    message: string,
    backend: string,
    phase: string,
    pending: PendingAttachmentUpload[]
): void => {
    if (pending.length === 0) return;
    void syncServiceDependencies.logWarn(message, {
        scope: 'sync',
        extra: buildPendingAttachmentUploadLogExtra(
            backend,
            phase,
            pending,
            syncServiceDependencies.sanitizeLogMessage
        ),
    });
};

const externalCalendarProvider = {
    load: () => syncServiceDependencies.getExternalCalendars(),
    save: (calendars: AppSettings['externalCalendars'] | undefined) =>
        syncServiceDependencies.setExternalCalendars(calendars ?? []),
    onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
    injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
    persistExternalCalendarsForSync(data, externalCalendarProvider);

const mergeLocalSyncStatus = (data: AppData): AppData => {
    const localStatus = readLocalSyncStatus();
    if (!localStatus) return data;
    return normalizeAppData({
        ...data,
        settings: {
            ...(data.settings ?? {}),
            ...localStatus,
        },
    });
};

// Sync should start from persisted data so startup sync cannot overwrite settings with an unhydrated store snapshot.
const readLocalDataForSync = async (): Promise<AppData> => {
    if (isTauriRuntimeEnv()) {
        try {
            const persisted = await tauriInvoke<AppData>('get_data');
            return mergeLocalSyncStatus(normalizeAppData(persisted));
        } catch (error) {
            logSyncWarning('Failed to read persisted local data for sync; using in-memory snapshot', error);
        }
    } else {
        const persisted = await webStorage.getData();
        return normalizeAppData(persisted);
    }

    const state = getStoreState();
    return normalizeAppData({
        tasks: [...state._allTasks],
        projects: [...state._allProjects],
        sections: [...state._allSections],
        areas: [...state._allAreas],
        people: [...state._allPeople],
        settings: state.settings ?? {},
    });
};

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return syncServiceDependencies.invoke<T>(command, args);
}

async function persistLocalDataForSync(data: AppData): Promise<void> {
    syncServiceDependencies.markLocalWrite(data);
    syncServiceDependencies.markLocalSqliteWrite();
    await tauriInvoke('save_data', { data });
    syncServiceDependencies.markLocalSqliteWrite();
}

async function persistSyncSettings(updates: Partial<AppSettings>): Promise<void> {
    if (isTauriRuntimeEnv()) {
        writeLocalSyncStatus(updates, logSyncWarning);
        useTaskStore.setState((state) => ({
            settings: {
                ...(state.settings ?? {}),
                ...updates,
            },
        }));
        return;
    }
    await getStoreState().updateSettings(updates);
}

const DROPBOX_REDIRECT_URI_FALLBACK = 'http://127.0.0.1:53682/oauth/dropbox/callback';
const DROPBOX_TEST_TIMEOUT_MS = 15_000;

async function getTauriFetch(): Promise<typeof fetch | undefined> {
    return syncServiceDependencies.getTauriFetch();
}

async function resolveWebdavPassword(config: WebDavConfig): Promise<string> {
    if (typeof config.password === 'string') return config.password;
    if (config.hasPassword === false) return '';
    if (!isTauriRuntimeEnv()) return '';
    try {
        return await tauriInvoke<string>('get_webdav_password');
    } catch (error) {
        logSyncWarning('Failed to load WebDAV password', error);
        return '';
    }
}

const attachmentBackendDeps: AttachmentBackendDeps = {
    getTauriFetch,
    isTauriRuntimeEnv,
    logSyncInfo,
    logSyncWarning,
    resolveWebdavPassword,
};

const getAttachmentCleanupDeps = (): AttachmentCleanupDeps => ({
    getCloudConfig: () => SyncService.getCloudConfig(),
    getCloudProvider: () => SyncService.getCloudProvider(),
    getDropboxAccessToken: (clientId, options) => SyncService.getDropboxAccessToken(clientId, options),
    getDropboxAppKey: () => SyncService.getDropboxAppKey(),
    getSyncPath: () => SyncService.getSyncPath(),
    getTauriFetch,
    getWebDavConfig: () => SyncService.getWebDavConfig(),
    isTauriRuntimeEnv,
    logSyncInfo,
    logSyncWarning,
    resolveWebdavPassword,
});

const getSyncConfigDeps = () => ({
    isTauriRuntimeEnv,
    maybeMigrateLegacyLocalStorageToConfig: () => SyncService.maybeMigrateLegacyLocalStorageToConfig(),
    reportError: syncServiceDependencies.reportError,
    startFileWatcher: () => SyncService.startFileWatcher(),
    tauriInvoke,
});

type SyncRunResult = {
    success: boolean;
    stats?: MergeStats;
    error?: string;
    skipped?: 'requeued' | 'unchanged' | 'pendingRemoteWriteBackoff';
};

type SyncRunOptions = {
    backendOverride?: SyncBackend;
};

type SyncExecutionContext = {
    backend: SyncBackend;
    step: string;
    syncUrl?: string;
    localSnapshotChangeAt: number;
    localDataCache: { changeAt: number; data: AppData } | null;
    networkWentOffline: boolean;
    removeNetworkListener: (() => void) | null;
    requestAbortController: AbortController;
    preSyncedLocalData: AppData | null;
    wroteLocal: boolean;
    remoteDataForCompare: AppData | null;
    lastRemoteWriteFingerprint: string | null;
    lastRemoteWriteMergedServerData: boolean;
    webdavRemoteCorrupted: boolean;
    webdavConfig: WebDavConfig | null;
    cloudProvider: CloudProvider;
    cloudConfig: CloudConfig | null;
    dropboxAppKey: string;
    dropboxDataRev: string | null;
    cachedDropboxAccessToken: string | null;
    syncPath: string;
    fileBaseDir: string;
    hadAttachmentWarning: boolean;
};

type RemoteWriteResultLike = Partial<RemoteJsonWriteResult & CloudJsonWriteResult>;

const normalizeRemoteWriteResult = (
    source: 'cloud' | 'webdav',
    result: RemoteWriteResultLike | boolean | null | undefined,
): { fingerprint: string | null; serverMergedRemoteData: boolean } => {
    if (!result || typeof result !== 'object') {
        return { fingerprint: null, serverMergedRemoteData: false };
    }
    const fingerprint = typeof result.fingerprint === 'string' && result.fingerprint.trim()
        ? result.fingerprint
        : buildHttpRemoteFileFingerprint(source, {
            etag: typeof result.etag === 'string' ? result.etag : null,
            lastModified: typeof result.lastModified === 'string' ? result.lastModified : null,
            contentLength: typeof result.contentLength === 'string' ? result.contentLength : null,
        });
    return {
        fingerprint,
        serverMergedRemoteData: result.serverMergedRemoteData === true,
    };
};

type SyncRunDependencies = {
    updateSyncStep: (next: string) => void;
    requestFollowUp: () => void;
    acceptCoveredLocalSnapshot: (data: AppData) => boolean;
    applySyncedDataToStore: (data: AppData) => void;
    persistLocalData: (data: AppData) => Promise<void>;
    getDropboxAccessToken: (appKey: string, options?: { forceRefresh?: boolean }) => Promise<string>;
    runDropboxWithRetry: <T>(
        resolveToken: (forceRefresh?: boolean) => Promise<string>,
        operation: (token: string) => Promise<T>
    ) => Promise<T>;
};

class SyncRun {
    constructor(
        readonly options: SyncRunOptions,
        readonly context: SyncExecutionContext,
        private readonly deps: SyncRunDependencies
    ) { }

    setStep(next: string): void {
        this.context.step = next;
        this.deps.updateSyncStep(next);
    }

    createFetchWithAbort(baseFetch: typeof fetch): typeof fetch {
        return createAbortableFetch(baseFetch, { baseSignal: this.context.requestAbortController.signal });
    }

    ensureNetworkStillAvailable(): void {
        const { context } = this;
        if (context.backend !== 'cloud' && context.backend !== 'webdav' && context.backend !== 'cloudkit') return;
        if (
            context.networkWentOffline
            || (typeof navigator !== 'undefined' && navigator.onLine === false)
        ) {
            context.requestAbortController.abort();
            throw new Error('Sync paused: offline state detected');
        }
    }

    ensureLocalSnapshotFresh(expectedSyncedData?: AppData): void {
        ensureFreshLocalSyncSnapshot({
            localSnapshotChangeAt: this.context.localSnapshotChangeAt,
            getCurrentChangeAt: () => getStoreState().lastDataChangeAt,
            acceptCoveredSnapshot: expectedSyncedData
                ? () => this.deps.acceptCoveredLocalSnapshot(expectedSyncedData)
                : undefined,
            requestFollowUp: () => this.deps.requestFollowUp(),
        });
    }

    async persistLocalDataWithTracking(data: AppData): Promise<void> {
        await this.deps.persistLocalData(data);
        this.deps.applySyncedDataToStore(data);
        const currentChangeAt = getStoreState().lastDataChangeAt;
        this.context.localSnapshotChangeAt = currentChangeAt;
        this.context.localDataCache = {
            changeAt: currentChangeAt,
            data: normalizeAppData(data),
        };
        this.context.wroteLocal = true;
    }

    requestFollowUp(): void {
        this.deps.requestFollowUp();
    }

    async resolveDropboxAccessToken(forceRefresh = false): Promise<string> {
        const { context } = this;
        if (!context.dropboxAppKey) {
            throw new Error('Dropbox app key is not configured');
        }
        if (!context.cachedDropboxAccessToken || forceRefresh) {
            context.cachedDropboxAccessToken = await this.deps.getDropboxAccessToken(context.dropboxAppKey, { forceRefresh });
        }
        return context.cachedDropboxAccessToken;
    }

    runDropboxWithRetry<T>(operation: (token: string) => Promise<T>): Promise<T> {
        return this.deps.runDropboxWithRetry((forceRefresh) => this.resolveDropboxAccessToken(forceRefresh), operation);
    }
}

export class SyncService {
    private static didMigrate = false;
    private static queuedSyncOptions: SyncRunOptions | null = null;
    private static syncStatus: {
        inFlight: boolean;
        queued: boolean;
        step: string | null;
        lastResult: 'success' | 'error' | null;
        lastResultAt: string | null;
    } = {
        inFlight: false,
        queued: false,
        step: null,
        lastResult: null,
        lastResultAt: null,
    };
    private static readonly syncOrchestrator = createSyncOrchestrator<SyncRunOptions, SyncRunResult>({
        runCycle: async (options) => SyncService.runSyncCycle(options),
        onQueueStateChange: (queued) => {
            SyncService.updateSyncStatus({ queued });
        },
        onDrained: () => {
            SyncService.queuedSyncOptions = null;
        },
        onQueuedRunComplete: (queuedResult) => {
            if (!queuedResult.success) {
                logSyncWarning('Queued sync failed', queuedResult.error);
                try {
                    useUiStore.getState().showToast(
                        queuedResult.error || resolveSyncText('settings.queuedSyncFailed', 'Queued sync failed.'),
                        'error',
                        6000,
                    );
                } catch {
                    // UI store may be unavailable during shutdown/tests.
                }
            }
        },
        onQueuedRunError: (error) => {
            logSyncWarning('Queued sync crashed', error);
        },
    });
    private static syncListeners = new Set<(status: typeof SyncService.syncStatus) => void>();
    private static fileWatcherStop: (() => void) | null = null;
    private static fileWatcherPath: string | null = null;
    private static fileWatcherBackend: SyncBackend | null = null;
    private static lastWrittenHash: string | null = null;
    private static lastObservedHash: string | null = null;
    private static lastSuccessfulSyncLocalChangeAt = 0;
    private static ignoreFileEventsUntil = 0;
    private static fileWriteIgnoreActive = false;
    private static externalSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private static pendingExternalSyncChange: ExternalSyncChange | null = null;
    private static externalSyncChangeListeners = new Set<(change: ExternalSyncChange | null) => void>();
    private static consecutiveAttachmentWarningRuns = 0;
    private static lastAttachmentWarningToastAt = 0;

    private static getMonotonicNow(): number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    private static requestQueuedSyncRun(nextOptions?: SyncRunOptions, preferLatest = true) {
        if (nextOptions && (preferLatest || !SyncService.queuedSyncOptions)) {
            SyncService.queuedSyncOptions = nextOptions;
        }
        const queuedOptions = SyncService.queuedSyncOptions ?? nextOptions;
        logSyncInfo('Sync trace follow-up requested', {
            hasQueuedOptions: String(Boolean(queuedOptions)),
            preferLatest: String(preferLatest),
        });
        if (queuedOptions) {
            SyncService.syncOrchestrator.requestFollowUp(queuedOptions);
            return;
        }
        SyncService.syncOrchestrator.requestFollowUp();
    }

    private static areSyncRunOptionsEquivalent(left?: SyncRunOptions | null, right?: SyncRunOptions | null): boolean {
        return (left?.backendOverride ?? undefined) === (right?.backendOverride ?? undefined);
    }

    private static acceptCoveredLocalSnapshot(context: SyncExecutionContext, expectedData: AppData): boolean {
        const currentChangeAt = getStoreState().lastDataChangeAt;
        if (currentChangeAt <= context.localSnapshotChangeAt) return true;

        const currentData = normalizeAppData(syncServiceDependencies.getInMemoryAppDataSnapshot());
        const syncedData = normalizeAppData(expectedData);
        const currentFingerprint = computeSyncPayloadFingerprint(currentData);
        const syncedFingerprint = computeSyncPayloadFingerprint(syncedData);
        const rawPayloadsEqual = areSyncPayloadsEqual(currentData, syncedData);
        if (currentFingerprint !== syncedFingerprint) {
            logSyncInfo('Sync trace covered local snapshot differs', {
                currentChangeAt: String(currentChangeAt),
                localSnapshotChangeAt: String(context.localSnapshotChangeAt),
                currentFingerprint,
                syncedFingerprint,
                rawPayloadsEqual: String(rawPayloadsEqual),
                ...buildSyncPayloadDiffTraceExtra(currentData, syncedData),
            });
            return false;
        }

        context.localSnapshotChangeAt = currentChangeAt;
        logSyncInfo('Sync trace covered local snapshot accepted', {
            currentChangeAt: String(currentChangeAt),
            currentFingerprint,
            rawPayloadsEqual: String(rawPayloadsEqual),
        });
        return true;
    }

    private static clearCoveredQueuedSyncRun(context: SyncExecutionContext, options: SyncRunOptions): void {
        if (!SyncService.syncOrchestrator.getState().queued) return;
        if (!SyncService.areSyncRunOptionsEquivalent(SyncService.queuedSyncOptions, options)) return;
        if (getStoreState().lastDataChangeAt > context.localSnapshotChangeAt) return;

        SyncService.queuedSyncOptions = null;
        SyncService.syncOrchestrator.clearFollowUp();
    }

    static getSyncStatus() {
        return SyncService.syncStatus;
    }

    static subscribeSyncStatus(listener: (status: typeof SyncService.syncStatus) => void): () => void {
        SyncService.syncListeners.add(listener);
        listener(SyncService.syncStatus);
        return () => SyncService.syncListeners.delete(listener);
    }

    static getPendingExternalSyncChange(): ExternalSyncChange | null {
        return SyncService.pendingExternalSyncChange;
    }

    static subscribeExternalSyncChange(listener: (change: ExternalSyncChange | null) => void): () => void {
        SyncService.externalSyncChangeListeners.add(listener);
        listener(SyncService.pendingExternalSyncChange);
        return () => SyncService.externalSyncChangeListeners.delete(listener);
    }

    private static notifyExternalSyncChange() {
        SyncService.externalSyncChangeListeners.forEach((listener) => listener(SyncService.pendingExternalSyncChange));
    }

    private static setPendingExternalSyncChange(change: ExternalSyncChange | null) {
        SyncService.pendingExternalSyncChange = change;
        SyncService.notifyExternalSyncChange();
    }

    static async resetForTests(): Promise<void> {
        await SyncService.stopFileWatcher();
        SyncService.didMigrate = false;
        SyncService.syncOrchestrator.reset();
        SyncService.queuedSyncOptions = null;
        SyncService.syncStatus = {
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
        };
        SyncService.syncListeners.clear();
        SyncService.fileWatcherStop = null;
        SyncService.fileWatcherPath = null;
        SyncService.fileWatcherBackend = null;
        SyncService.lastWrittenHash = null;
        SyncService.lastObservedHash = null;
        SyncService.lastSuccessfulSyncLocalChangeAt = 0;
        SyncService.ignoreFileEventsUntil = 0;
        SyncService.fileWriteIgnoreActive = false;
        SyncService.externalSyncTimer = null;
        SyncService.pendingExternalSyncChange = null;
        SyncService.externalSyncChangeListeners.clear();
        SyncService.consecutiveAttachmentWarningRuns = 0;
        SyncService.lastAttachmentWarningToastAt = 0;
        clearFastSyncState();
        clearLocalSyncStatus();
        clearAttachmentSyncState();
        clearAttachmentValidationFailures();
    }

    private static finalizeAttachmentWarningState(context: Pick<SyncExecutionContext, 'hadAttachmentWarning'>, result: Pick<SyncRunResult, 'success'>) {
        if (context.hadAttachmentWarning) {
            SyncService.consecutiveAttachmentWarningRuns += 1;
            if (SyncService.consecutiveAttachmentWarningRuns < ATTACHMENT_WARNING_TOAST_THRESHOLD) {
                return;
            }
            const now = Date.now();
            if (now - SyncService.lastAttachmentWarningToastAt < ATTACHMENT_WARNING_TOAST_COOLDOWN_MS) {
                return;
            }
            SyncService.lastAttachmentWarningToastAt = now;
            try {
                useUiStore.getState().showToast(
                    resolveSyncText(
                        'settings.attachmentSyncRetryWarning',
                        'Attachment sync is still failing. Files will retry in the background.',
                    ),
                    'error',
                    6000,
                );
            } catch {
                // UI store may be unavailable during shutdown/tests.
            }
            return;
        }
        if (result.success) {
            SyncService.consecutiveAttachmentWarningRuns = 0;
        }
    }

    private static updateSyncStatus(partial: Partial<typeof SyncService.syncStatus>) {
        SyncService.syncStatus = { ...SyncService.syncStatus, ...partial };
        SyncService.syncListeners.forEach((listener) => listener(SyncService.syncStatus));
    }

    static async maybeMigrateLegacyLocalStorageToConfig() {
        if (!isTauriRuntimeEnv() || SyncService.didMigrate) return;
        SyncService.didMigrate = true;

        const legacyBackend = getSyncBackendLocal();
        const legacyWebdav = getWebDavConfigLocal();
        const legacyCloud = getCloudConfigLocal();
        const hasLegacyBackend = legacyBackend === 'webdav' || legacyBackend === 'cloud';
        const hasLegacyWebdav = Boolean(legacyWebdav.url);
        const hasLegacyCloud = Boolean(legacyCloud.url || legacyCloud.token);
        if (!hasLegacyBackend && !hasLegacyWebdav && !hasLegacyCloud) return;

        try {
            const [currentBackend, currentWebdav, currentCloud] = await Promise.all([
                tauriInvoke<string>('get_sync_backend'),
                tauriInvoke<WebDavConfig>('get_webdav_config'),
                tauriInvoke<CloudConfig>('get_cloud_config'),
            ]);

            let migrated = false;
            if (hasLegacyBackend && normalizeSyncBackend(currentBackend) === 'file') {
                await tauriInvoke('set_sync_backend', { backend: legacyBackend });
                migrated = true;
            }

            if (hasLegacyWebdav && !currentWebdav.url) {
                await tauriInvoke('set_webdav_config', legacyWebdav);
                migrated = true;
            }

            if (hasLegacyCloud && !currentCloud.url && !currentCloud.token) {
                await tauriInvoke('set_cloud_config', { url: legacyCloud.url, token: legacyCloud.token });
                migrated = true;
            }

            if (migrated) {
                localStorage.removeItem(SYNC_BACKEND_KEY);
                localStorage.removeItem(WEBDAV_URL_KEY);
                localStorage.removeItem(WEBDAV_USERNAME_KEY);
                localStorage.removeItem(WEBDAV_PASSWORD_KEY);
                localStorage.removeItem(CLOUD_URL_KEY);
                localStorage.removeItem(CLOUD_TOKEN_KEY);
                localStorage.removeItem(CLOUD_REMEMBER_TOKEN_KEY);
                sessionStorage.removeItem(WEBDAV_PASSWORD_KEY);
                sessionStorage.removeItem(CLOUD_TOKEN_KEY);
            }
        } catch (error) {
            syncServiceDependencies.reportError('Failed to migrate legacy sync config', error);
        }
    }

    static async getSyncBackend(): Promise<SyncBackend> {
        return readSyncBackend(getSyncConfigDeps());
    }

    static async setSyncBackend(backend: SyncBackend): Promise<void> {
        return writeSyncBackend(backend, getSyncConfigDeps());
    }

    static async getWebDavConfig(options?: { silent?: boolean }): Promise<WebDavConfig> {
        return readWebDavConfig(getSyncConfigDeps(), options);
    }

    static async setWebDavConfig(config: { url: string; username?: string; password?: string; allowInsecureHttp?: boolean; allowWeakFingerprint?: boolean }): Promise<void> {
        return writeWebDavConfig(config, getSyncConfigDeps());
    }

    static async testWebDavConnection(config: { url: string; username?: string; password?: string; hasPassword?: boolean; allowInsecureHttp?: boolean }): Promise<void> {
        const normalizedUrl = normalizeWebdavUrl(config.url.trim());
        if (!normalizedUrl) {
            throw new Error('WebDAV URL not configured');
        }
        const fetcher = await getTauriFetch();
        const password = await resolveWebdavPassword({
            url: config.url,
            username: config.username || '',
            password: config.password,
            hasPassword: config.hasPassword,
        });
        await webdavGetJson<unknown>(normalizedUrl, {
            allowInsecureHttp: config.allowInsecureHttp,
            username: config.username?.trim(),
            password,
            timeoutMs: 10_000,
            fetcher: fetcher ?? fetch,
        });
    }

    static async getCloudConfig(options?: { silent?: boolean }): Promise<CloudConfig> {
        return readCloudConfig(getSyncConfigDeps(), options);
    }

    static async setCloudConfig(config: { url: string; token?: string; allowInsecureHttp?: boolean; rememberToken?: boolean }): Promise<void> {
        return writeCloudConfig(config, getSyncConfigDeps());
    }

    static async getCloudProvider(): Promise<CloudProvider> {
        return readCloudProvider();
    }

    static async setCloudProvider(provider: CloudProvider): Promise<void> {
        return writeCloudProvider(provider);
    }

    static async getDropboxAppKey(): Promise<string> {
        return readDropboxAppKey();
    }

    static async setDropboxAppKey(value: string): Promise<void> {
        return writeDropboxAppKey(value);
    }

    static async getDropboxRedirectUri(): Promise<string> {
        if (!isTauriRuntimeEnv()) return DROPBOX_REDIRECT_URI_FALLBACK;
        try {
            return await tauriInvoke<string>('get_dropbox_redirect_uri');
        } catch {
            return DROPBOX_REDIRECT_URI_FALLBACK;
        }
    }

    static async isDropboxConnected(clientId: string): Promise<boolean> {
        const normalized = clientId.trim();
        if (!normalized) return false;
        if (!isTauriRuntimeEnv()) return false;
        try {
            return await tauriInvoke<boolean>('is_dropbox_connected', { clientId: normalized });
        } catch (error) {
            syncServiceDependencies.reportError('Failed to check Dropbox connection status', error);
            return false;
        }
    }

    static async connectDropbox(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await tauriInvoke('connect_dropbox', { clientId: normalized });
    }

    static async disconnectDropbox(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await tauriInvoke('disconnect_dropbox', { clientId: normalized });
    }

    static async getDropboxAccessToken(clientId: string, options?: { forceRefresh?: boolean }): Promise<string> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        return await tauriInvoke<string>('get_dropbox_access_token', {
            clientId: normalized,
            forceRefresh: options?.forceRefresh === true,
        });
    }

    static async testDropboxConnection(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        const fetcher = await getTauriFetch();
        const runTest = async (forceRefresh: boolean) => {
            const accessToken = await SyncService.getDropboxAccessToken(normalized, { forceRefresh });
            await withTimeout(
                testDropboxAccess(accessToken, fetcher ?? fetch),
                DROPBOX_TEST_TIMEOUT_MS,
                'Dropbox connection test timed out. Please try again.'
            );
        };
        try {
            await runTest(false);
        } catch (error) {
            if (error instanceof DropboxUnauthorizedError) {
                await runTest(true);
                return;
            }
            throw error;
        }
    }

    /**
     * Get the currently configured sync path from the backend
     */
    static async getSyncPath(): Promise<string> {
        return readSyncPath(getSyncConfigDeps());
    }

    /**
     * Set the sync path in the backend
     */
    static async setSyncPath(path: string): Promise<{ success: boolean; path: string; error?: string }> {
        return writeSyncPath(path, getSyncConfigDeps());
    }

    private static async markSyncWrite(data: AppData) {
        const hash = await hashString(toStableJson(data));
        SyncService.lastWrittenHash = hash;
        SyncService.fileWriteIgnoreActive = true;
        SyncService.ignoreFileEventsUntil = Number.POSITIVE_INFINITY;
    }

    private static finalizeSyncWriteIgnoreWindow() {
        if (!SyncService.fileWriteIgnoreActive) return;
        SyncService.fileWriteIgnoreActive = false;
        SyncService.ignoreFileEventsUntil = SyncService.getMonotonicNow() + 2000;
    }

    private static async runDropboxWithRetry<T>(
        resolveAccessToken: (forceRefresh?: boolean) => Promise<string>,
        operation: (token: string) => Promise<T>
    ): Promise<T> {
        let forceRefresh = false;
        let unauthorizedRetries = 0;
        while (true) {
            try {
                const token = await resolveAccessToken(forceRefresh);
                return await operation(token);
            } catch (error) {
                if (!(error instanceof DropboxUnauthorizedError) || unauthorizedRetries >= DROPBOX_AUTH_RETRY_LIMIT) {
                    throw error;
                }
                unauthorizedRetries += 1;
                forceRefresh = true;
            }
        }
    }

    private static async persistSuccessfulSyncStatus(
        syncStatus: NonNullable<AppSettings['lastSyncStatus']>,
        now: string,
        lastSyncHistory?: ReturnType<typeof appendSyncHistory>
    ): Promise<boolean> {
        try {
            await persistSyncSettings({
                lastSyncAt: now,
                lastSyncStatus: syncStatus,
                lastSyncError: undefined,
                ...(lastSyncHistory ? { lastSyncHistory } : {}),
            });
            SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;
            return true;
        } catch (error) {
            logSyncWarning('Failed to persist sync status', error);
            return false;
        }
    }

    private static createSyncExecutionContext(): SyncExecutionContext {
        return {
            backend: 'off',
            step: 'init',
            syncUrl: undefined,
            localSnapshotChangeAt: 0,
            localDataCache: null,
            networkWentOffline: false,
            removeNetworkListener: null,
            requestAbortController: new AbortController(),
            preSyncedLocalData: null,
            wroteLocal: false,
            remoteDataForCompare: null,
            lastRemoteWriteFingerprint: null,
            lastRemoteWriteMergedServerData: false,
            webdavRemoteCorrupted: false,
            webdavConfig: null,
            cloudProvider: 'selfhosted',
            cloudConfig: null,
            dropboxAppKey: '',
            dropboxDataRev: null,
            cachedDropboxAccessToken: null,
            syncPath: '',
            fileBaseDir: '',
            hadAttachmentWarning: false,
        };
    }

    private static async readRemoteFingerprintForFastCheck(run: SyncRun): Promise<string | null> {
        const { context } = run;
        run.ensureNetworkStillAvailable();
        if (context.backend === 'webdav') {
            if (!context.webdavConfig?.url) return null;
            const normalizedUrl = normalizeWebdavUrl(context.webdavConfig.url);
            context.syncUrl = normalizedUrl;
            const password = await resolveWebdavPassword(context.webdavConfig);
            const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            const metadata = await webdavHeadFile(normalizedUrl, {
                allowInsecureHttp: context.webdavConfig.allowInsecureHttp,
                allowWeakFingerprint: context.webdavConfig.allowWeakFingerprint,
                username: context.webdavConfig.username,
                password,
                fetcher,
            });
            if (!metadata.exists) return null;
            return metadata.fingerprint;
        }
        if (context.backend === 'cloud' && context.cloudProvider === 'selfhosted') {
            if (!context.cloudConfig?.url) return null;
            const normalizedUrl = normalizeCloudUrl(context.cloudConfig.url);
            context.syncUrl = normalizedUrl;
            const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            const metadata = await cloudHeadJson(normalizedUrl, {
                allowInsecureHttp: context.cloudConfig.allowInsecureHttp,
                token: context.cloudConfig.token,
                fetcher,
            });
            if (!metadata.exists) return null;
            return metadata.fingerprint;
        }
        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox') {
            const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            const metadata = await run.runDropboxWithRetry((token) =>
                getDropboxAppDataMetadata(token, fetcher)
            );
            context.dropboxDataRev = metadata.rev;
            return metadata.rev ? `dropbox:v1:rev=${metadata.rev}` : null;
        }
        return null;
    }

    private static async persistUnchangedSyncStatus(
        context: SyncExecutionContext,
        state: FastSyncState
    ): Promise<void> {
        const now = new Date().toISOString();
        writeFastSyncState({ ...state, checkedAt: now }, logSyncWarning);
        SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;
        SyncService.setPendingExternalSyncChange(null);
        getStoreState().setError(null);
        try {
            await persistSyncSettings({
                lastSyncAt: now,
                lastSyncStatus: 'success',
                lastSyncError: undefined,
            });
        } catch (error) {
            logSyncWarning('Failed to persist unchanged sync status', error);
        }
        logSyncInfo('Sync fast check found no changes', { backend: context.backend });
    }

    private static async trySkipUnchangedSync(run: SyncRun): Promise<SyncRunResult | null> {
        const { context } = run;
        const scope = buildFastSyncScope(context);
        if (!scope) return null;

        run.setStep('fast-check');
        await yieldToRenderer();
        const localData = await SyncService.readLocalDataForSyncCycle(context);
        run.ensureLocalSnapshotFresh();
        if (hasPendingSyncSideEffects(localData)) return null;

        const localFingerprint = computeSyncPayloadFingerprint(localData);
        const cached = readFastSyncState(scope);
        if (!cached || cached.localFingerprint !== localFingerprint) return null;

        let remoteFingerprint: string | null = null;
        try {
            remoteFingerprint = await SyncService.readRemoteFingerprintForFastCheck(run);
        } catch (error) {
            logSyncWarning('Sync fast check failed; falling back to full sync', error);
            return null;
        }
        if (!remoteFingerprint || remoteFingerprint !== cached.remoteFingerprint) return null;

        await SyncService.persistUnchangedSyncStatus(context, {
            scope,
            localFingerprint,
            remoteFingerprint,
            checkedAt: cached.checkedAt,
        });
        return { success: true, skipped: 'unchanged' };
    }

    private static async recordFastSyncState(run: SyncRun, data: AppData): Promise<void> {
        const { context } = run;
        const scope = buildFastSyncScope(context);
        if (!scope || hasPendingSyncSideEffects(data)) return;
        if (getStoreState().lastDataChangeAt > context.localSnapshotChangeAt) return;
        if (context.lastRemoteWriteMergedServerData) return;

        let remoteFingerprint: string | null = null;
        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && context.dropboxDataRev) {
            remoteFingerprint = `dropbox:v1:rev=${context.dropboxDataRev}`;
        } else if (context.lastRemoteWriteFingerprint) {
            remoteFingerprint = context.lastRemoteWriteFingerprint;
        } else {
            try {
                remoteFingerprint = await SyncService.readRemoteFingerprintForFastCheck(run);
            } catch (error) {
                logSyncWarning('Failed to refresh sync fast-check state', error);
                return;
            }
        }
        if (!remoteFingerprint) return;
        writeFastSyncState({
            scope,
            localFingerprint: computeSyncPayloadFingerprint(data),
            remoteFingerprint,
            checkedAt: new Date().toISOString(),
        }, logSyncWarning);
    }

    private static async persistPreSyncedLocalDataIfNeeded(run: SyncRun): Promise<void> {
        const { context } = run;
        if (!context.preSyncedLocalData || context.wroteLocal) return;
        const inMemorySnapshot = syncServiceDependencies.getInMemoryAppDataSnapshot();
        const reconciledData = mergeAppData(context.preSyncedLocalData, inMemorySnapshot);
        await run.persistLocalDataWithTracking(reconciledData);
    }

    private static async readLocalDataForSyncCycle(context: SyncExecutionContext): Promise<AppData> {
        const currentChangeAt = getStoreState().lastDataChangeAt;
        if (context.localDataCache && context.localDataCache.changeAt === currentChangeAt) {
            context.localSnapshotChangeAt = currentChangeAt;
            return context.localDataCache.data;
        }
        const inMemorySnapshot = syncServiceDependencies.getInMemoryAppDataSnapshot();
        const baseData = context.preSyncedLocalData
            ? mergeAppData(context.preSyncedLocalData, inMemorySnapshot)
            : mergeAppData(await readLocalDataForSync(), inMemorySnapshot);
        const data = await injectExternalCalendars(baseData);
        context.localSnapshotChangeAt = getStoreState().lastDataChangeAt;
        context.localDataCache = {
            changeAt: context.localSnapshotChangeAt,
            data,
        };
        return data;
    }

    private static async prepareSyncExecutionContext(run: SyncRun): Promise<void> {
        const { context, options } = run;
        context.backend = options.backendOverride ?? await SyncService.getSyncBackend();
        if (context.backend === 'off') {
            return;
        }

        if (
            (context.backend === 'cloud' || context.backend === 'webdav' || context.backend === 'cloudkit')
            && typeof window !== 'undefined'
        ) {
            const handleOffline = () => {
                context.networkWentOffline = true;
                context.requestAbortController.abort();
            };
            window.addEventListener('offline', handleOffline);
            context.removeNetworkListener = () => {
                window.removeEventListener('offline', handleOffline);
                context.removeNetworkListener = null;
            };
        }

        if (isTauriRuntimeEnv()) {
            run.setStep('snapshot');
            await yieldToRenderer();
            try {
                await tauriInvoke<string>('create_data_snapshot');
            } catch (error) {
                logSyncWarning('Failed to create pre-sync snapshot', error);
            }
        }

        if (
            (context.backend === 'cloud' || context.backend === 'webdav' || context.backend === 'cloudkit')
            && typeof navigator !== 'undefined'
            && navigator.onLine === false
        ) {
            throw new Error('Offline: network connection is unavailable for remote sync.');
        }

        context.webdavConfig = context.backend === 'webdav' ? await SyncService.getWebDavConfig() : null;
        context.cloudProvider = context.backend === 'cloud' ? await SyncService.getCloudProvider() : 'selfhosted';
        context.cloudConfig = context.backend === 'cloud' && context.cloudProvider === 'selfhosted'
            ? await SyncService.getCloudConfig()
            : null;
        context.dropboxAppKey = context.backend === 'cloud' && context.cloudProvider === 'dropbox'
            ? (await SyncService.getDropboxAppKey()).trim()
            : '';
        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && !context.dropboxAppKey) {
            throw new Error('Dropbox app key is not configured');
        }
        context.syncPath = context.backend === 'file' ? await SyncService.getSyncPath() : '';
        context.fileBaseDir = context.backend === 'file'
            ? getFileSyncDir(context.syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME)
            : '';
    }

    private static async runPreSyncAttachmentPhase(run: SyncRun): Promise<void> {
        const { context } = run;
        if (!isTauriRuntimeEnv() || (context.backend !== 'webdav' && context.backend !== 'file' && context.backend !== 'cloud' && context.backend !== 'cloudkit')) {
            return;
        }

        run.setStep('attachments_prepare');
        await yieldToRenderer();
        try {
            const localData = await SyncService.readLocalDataForSyncCycle(context);
            const result = await runCorePreSyncAttachmentPhase({
                backend: context.backend,
                cloudProvider: context.cloudProvider,
                data: localData,
                ensureNetworkStillAvailable: () => run.ensureNetworkStillAvailable(),
                webdav: context.webdavConfig?.url
                    ? async (data) => {
                        const baseUrl = getBaseSyncUrl(context.webdavConfig!.url);
                        return syncAttachments(data, context.webdavConfig!, baseUrl, attachmentBackendDeps);
                    }
                    : undefined,
                cloudkit: context.backend === 'cloudkit'
                    ? async (data) => syncCloudKitAttachments(data, attachmentBackendDeps)
                    : undefined,
                file: context.fileBaseDir
                    ? async (data) => syncFileAttachments(data, context.fileBaseDir, attachmentBackendDeps)
                    : undefined,
                selfHostedCloud: context.cloudProvider === 'selfhosted' && context.cloudConfig?.url
                    ? async (data) => {
                        const baseUrl = getCloudBaseUrl(context.cloudConfig!.url);
                        return syncCloudAttachments(data, context.cloudConfig!, baseUrl, attachmentBackendDeps);
                    }
                    : undefined,
                dropbox: context.cloudProvider === 'dropbox'
                    ? async (data) => syncDropboxAttachments(data, (forceRefresh) => run.resolveDropboxAccessToken(forceRefresh), attachmentBackendDeps)
                    : undefined,
            });

            if (result.mutated) {
                context.preSyncedLocalData = result.data ?? localData;
                context.localDataCache = null;
                run.ensureLocalSnapshotFresh();
            }
        } catch (error) {
            if (error instanceof LocalSyncAbort) {
                throw error;
            }
            context.hadAttachmentWarning = true;
            logSyncWarning('Attachment pre-sync warning', error);
        }
    }

    private static async readRemoteDataByBackend(run: SyncRun): Promise<AppData | null> {
        const { context } = run;
        run.ensureNetworkStillAvailable();
        if (context.backend === 'cloudkit') {
            const data = await syncServiceDependencies.readRemoteCloudKit();
            context.remoteDataForCompare = data ?? null;
            return data;
        }
        if (context.backend === 'webdav') {
            try {
                if (isTauriRuntimeEnv()) {
                    if (!context.webdavConfig?.url) {
                        throw new Error('WebDAV URL not configured');
                    }
                    context.syncUrl = context.webdavConfig.url;
                    const data = await withRetry(
                        () => tauriInvoke<AppData>('webdav_get_json'),
                        WEBDAV_READ_RETRY_OPTIONS,
                    );
                    context.webdavRemoteCorrupted = false;
                    context.remoteDataForCompare = data ?? null;
                    return data;
                }
                if (!context.webdavConfig?.url) {
                    throw new Error('WebDAV URL not configured');
                }
                const webdavConfig = context.webdavConfig;
                const normalizedUrl = normalizeWebdavUrl(webdavConfig.url);
                context.syncUrl = normalizedUrl;
                const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                const data = await withRetry(
                    () => webdavGetJson<AppData>(normalizedUrl, {
                        allowInsecureHttp: webdavConfig.allowInsecureHttp,
                        username: webdavConfig.username,
                        password: webdavConfig.password || '',
                        fetcher,
                    }),
                    WEBDAV_READ_RETRY_OPTIONS,
                );
                context.webdavRemoteCorrupted = false;
                context.remoteDataForCompare = data ?? null;
                return data;
            } catch (error) {
                if (isWebdavInvalidJsonError(error)) {
                    context.webdavRemoteCorrupted = true;
                    context.remoteDataForCompare = null;
                    logSyncWarning('WebDAV remote data.json appears corrupted; treating as missing for repair write', error);
                    return null;
                }
                throw error;
            }
        }
        if (context.backend === 'cloud') {
            if (context.cloudProvider === 'selfhosted') {
                if (!context.cloudConfig?.url) {
                    throw new Error('Self-hosted URL not configured');
                }
                const normalizedUrl = normalizeCloudUrl(context.cloudConfig.url);
                context.syncUrl = normalizedUrl;
                if (isTauriRuntimeEnv()) {
                    const data = await tauriInvoke<AppData | null>('cloud_get_json');
                    context.remoteDataForCompare = data ?? null;
                    return data;
                }
                const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                const data = await cloudGetJson<AppData>(normalizedUrl, {
                    allowInsecureHttp: context.cloudConfig.allowInsecureHttp,
                    token: context.cloudConfig.token,
                    fetcher,
                });
                context.remoteDataForCompare = data ?? null;
                return data;
            }
            if (!context.dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            context.syncUrl = 'dropbox:///Apps/Mindwtr/data.json';
            const remote = await SyncService.readDropboxRemoteData(run);
            context.dropboxDataRev = remote.rev;
            context.remoteDataForCompare = remote.data ?? null;
            return remote.data;
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('File sync is not available in the web app.');
        }
        const data = await tauriInvoke<AppData>('read_sync_file');
        context.remoteDataForCompare = data ?? null;
        return data;
    }

    private static async readDropboxRemoteData(run: SyncRun): Promise<{ data: AppData | null; rev: string | null }> {
        const nativeFetch = await getTauriFetch();
        const browserFetcher = run.createFetchWithAbort(fetch);

        if (!nativeFetch) {
            return run.runDropboxWithRetry((token) => downloadDropboxAppData(token, browserFetcher));
        }

        const nativeFetcher = run.createFetchWithAbort(nativeFetch);
        const nativeRemote = await run.runDropboxWithRetry((token) =>
            downloadDropboxAppData(token, nativeFetcher)
        );
        if (nativeRemote.data !== null) {
            return nativeRemote;
        }

        logSyncInfo('Retrying Dropbox remote read with browser fetch fallback');
        try {
            const browserRemote = await run.runDropboxWithRetry((token) =>
                downloadDropboxAppData(token, browserFetcher)
            );
            if (browserRemote.data !== null) {
                logSyncInfo('Recovered Dropbox remote read via browser fetch fallback');
                return browserRemote;
            }
            return nativeRemote;
        } catch (error) {
            logSyncWarning('Dropbox browser fetch fallback failed', error);
            return nativeRemote;
        }
    }

    private static async prepareRemoteWriteData(run: SyncRun, data: AppData): Promise<AppData> {
        const { context } = run;
        if (findPendingAttachmentUploads(data).length === 0) {
            return data;
        }

        run.setStep('attachments_finalize');
        await yieldToRenderer();

        if (context.backend === 'webdav' && context.webdavConfig?.url) {
            run.ensureNetworkStillAvailable();
            const baseUrl = getBaseSyncUrl(context.webdavConfig.url);
            const syncedData = await syncAttachments(data, context.webdavConfig, baseUrl, attachmentBackendDeps);
            return syncedData ?? data;
        }

        if (context.backend === 'file' && context.fileBaseDir) {
            await syncFileAttachments(data, context.fileBaseDir, attachmentBackendDeps);
            return data;
        }

        if (context.backend === 'cloudkit') {
            run.ensureNetworkStillAvailable();
            await syncCloudKitAttachments(data, attachmentBackendDeps);
            return data;
        }

        if (context.backend === 'cloud' && context.cloudProvider === 'selfhosted' && context.cloudConfig?.url) {
            run.ensureNetworkStillAvailable();
            const baseUrl = getCloudBaseUrl(context.cloudConfig.url);
            await syncCloudAttachments(data, context.cloudConfig, baseUrl, attachmentBackendDeps);
            return data;
        }

        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox') {
            run.ensureNetworkStillAvailable();
            await syncDropboxAttachments(data, (forceRefresh) => run.resolveDropboxAccessToken(forceRefresh), attachmentBackendDeps);
        }

        return data;
    }

    private static async writeRemoteDataByBackend(run: SyncRun, data: AppData): Promise<void> {
        const { context } = run;
        run.ensureNetworkStillAvailable();
        context.lastRemoteWriteFingerprint = null;
        context.lastRemoteWriteMergedServerData = false;
        if (context.backend === 'cloudkit') {
            logPendingAttachmentUploads(
                'CloudKit sync has local-only file attachments',
                context.backend,
                'cloudkit-write',
                findPendingAttachmentUploads(data)
            );
            const sanitized = sanitizeAppDataForRemote(data);
            const remoteSanitized = context.remoteDataForCompare
                ? sanitizeAppDataForRemote(context.remoteDataForCompare)
                : null;
            if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
                return;
            }
            await syncServiceDependencies.writeRemoteCloudKit(sanitized as AppData);
            context.remoteDataForCompare = sanitized;
            return;
        }

        logPendingAttachmentUploads(
            'Remote write blocked by pending attachment uploads',
            context.backend,
            'remote-write',
            findPendingAttachmentUploads(data)
        );
        assertNoPendingAttachmentUploads(data);
        const sanitized = sanitizeAppDataForRemote(data);
        const remoteSanitized = context.remoteDataForCompare
            ? sanitizeAppDataForRemote(context.remoteDataForCompare)
            : null;
        if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
            logSyncPayloadTrace('Sync trace remote write skipped unchanged payload', sanitized, {
                backend: context.backend,
            });
            return;
        }

        if (context.backend === 'webdav') {
            if (isTauriRuntimeEnv()) {
                if (context.webdavRemoteCorrupted) {
                    logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
                }
                const result = await tauriInvoke<RemoteJsonWriteResult | boolean>('webdav_put_json', { data: sanitized });
                const writeResult = normalizeRemoteWriteResult('webdav', result);
                context.lastRemoteWriteFingerprint = writeResult.fingerprint;
                context.remoteDataForCompare = sanitized;
                context.webdavRemoteCorrupted = false;
                logSyncPayloadTrace('Sync trace remote write completed', sanitized, {
                    backend: context.backend,
                    remoteFingerprint: writeResult.fingerprint ?? '',
                });
                return;
            }
            const config = await SyncService.getWebDavConfig();
            const { url, username, password } = config;
            const normalizedUrl = normalizeWebdavUrl(url);
            const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            if (context.webdavRemoteCorrupted) {
                logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
            }
            const result = await webdavPutJson(normalizedUrl, sanitized, {
                allowInsecureHttp: config.allowInsecureHttp,
                username,
                password: password || '',
                fetcher,
            });
            const writeResult = normalizeRemoteWriteResult('webdav', result);
            context.lastRemoteWriteFingerprint = writeResult.fingerprint;
            context.remoteDataForCompare = sanitized;
            context.webdavRemoteCorrupted = false;
            logSyncPayloadTrace('Sync trace remote write completed', sanitized, {
                backend: context.backend,
                remoteFingerprint: writeResult.fingerprint ?? '',
            });
            return;
        }

        if (context.backend === 'cloud') {
            if (context.cloudProvider === 'selfhosted') {
                const config = context.cloudConfig ?? await SyncService.getCloudConfig();
                const { url, token } = config;
                const normalizedUrl = normalizeCloudUrl(url);
                context.syncUrl = normalizedUrl;
                if (isTauriRuntimeEnv()) {
                    const result = await tauriInvoke<CloudJsonWriteResult | boolean>('cloud_put_json', { data: sanitized });
                    const writeResult = normalizeRemoteWriteResult('cloud', result);
                    context.lastRemoteWriteFingerprint = writeResult.fingerprint;
                    context.lastRemoteWriteMergedServerData = writeResult.serverMergedRemoteData;
                    if (writeResult.serverMergedRemoteData) {
                        context.remoteDataForCompare = null;
                        run.requestFollowUp();
                    } else {
                        context.remoteDataForCompare = sanitized;
                    }
                    return;
                }
                const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                const result = await cloudPutJson(normalizedUrl, sanitized, {
                    allowInsecureHttp: config.allowInsecureHttp,
                    token,
                    fetcher,
                });
                const writeResult = normalizeRemoteWriteResult('cloud', result);
                context.lastRemoteWriteFingerprint = writeResult.fingerprint;
                context.lastRemoteWriteMergedServerData = writeResult.serverMergedRemoteData;
                if (writeResult.serverMergedRemoteData) {
                    context.remoteDataForCompare = null;
                    run.requestFollowUp();
                } else {
                    context.remoteDataForCompare = sanitized;
                }
                return;
            }
            if (!context.dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            const fetcher = run.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            try {
                const uploaded = await run.runDropboxWithRetry((token) =>
                    uploadDropboxAppData(token, sanitized, context.dropboxDataRev, fetcher)
                );
                context.dropboxDataRev = uploaded.rev;
                context.remoteDataForCompare = sanitized;
                return;
            } catch (error) {
                if (error instanceof DropboxConflictError) {
                    run.requestFollowUp();
                    throw new LocalSyncAbort();
                }
                throw error;
            }
        }

        await SyncService.markSyncWrite(sanitized);
        await tauriInvoke('write_sync_file', { data: sanitized });
        context.remoteDataForCompare = sanitized;
    }

    private static logSyncMergeSummary(stats: MergeStats): void {
        const mergeLog = buildMergeSummaryLog(stats, { clockSkewThresholdMs: CLOCK_SKEW_THRESHOLD_MS });
        if (!isTauriRuntimeEnv() || !mergeLog) {
            return;
        }
        void syncServiceDependencies.logInfo(
            mergeLog.message,
            {
                scope: 'sync',
                extra: mergeLog.extra,
            }
        );
    }

    private static async runPostMergeAttachmentPhase(run: SyncRun, mergedData: AppData): Promise<AppData> {
        const { context } = run;
        if (!isTauriRuntimeEnv() || (context.backend !== 'webdav' && context.backend !== 'file' && context.backend !== 'cloud' && context.backend !== 'cloudkit')) {
            return mergedData;
        }

        run.setStep('attachments');
        await yieldToRenderer();
        try {
            let nextMergedData = mergedData;
            const applyAttachmentSyncMutation = async (
                syncAttachmentsOp: (candidateData: AppData) => Promise<AppData | boolean | null>
            ): Promise<void> => {
                const candidateData = cloneAppData(nextMergedData);
                const mutationResult = await syncAttachmentsOp(candidateData);
                const nextData = mutationResult && typeof mutationResult === 'object'
                    ? mutationResult
                    : mutationResult
                        ? candidateData
                        : null;
                if (!nextData) return;
                run.ensureLocalSnapshotFresh();
                nextMergedData = nextData;
                await run.persistLocalDataWithTracking(nextMergedData);
                await yieldToRenderer();
            };

            run.ensureLocalSnapshotFresh();
            if (context.backend === 'webdav') {
                run.ensureNetworkStillAvailable();
                const config = context.webdavConfig ?? await SyncService.getWebDavConfig();
                const baseUrl = config.url ? getBaseSyncUrl(config.url) : '';
                if (baseUrl) {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                    );
                }
            } else if (context.backend === 'file') {
                if (context.fileBaseDir) {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncFileAttachments(candidateData, context.fileBaseDir, attachmentBackendDeps)
                    );
                }
            } else if (context.backend === 'cloudkit') {
                run.ensureNetworkStillAvailable();
                await applyAttachmentSyncMutation((candidateData) =>
                    syncCloudKitAttachments(candidateData, attachmentBackendDeps)
                );
            } else if (context.backend === 'cloud') {
                run.ensureNetworkStillAvailable();
                if (context.cloudProvider === 'selfhosted') {
                    const config = context.cloudConfig ?? await SyncService.getCloudConfig();
                    const baseUrl = config.url ? getCloudBaseUrl(config.url) : '';
                    if (baseUrl) {
                        await applyAttachmentSyncMutation((candidateData) =>
                            syncCloudAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                        );
                    }
                } else if (context.cloudProvider === 'dropbox') {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncDropboxAttachments(candidateData, (forceRefresh) => run.resolveDropboxAccessToken(forceRefresh), attachmentBackendDeps)
                    );
                }
            }

            return nextMergedData;
        } catch (error) {
            if (error instanceof LocalSyncAbort) {
                throw error;
            }
            context.hadAttachmentWarning = true;
            logSyncWarning('Attachment sync warning', error);
            return mergedData;
        }
    }

    private static hasPendingLocalChangesForExternalSync(): boolean {
        const state = getStoreState();
        if (!state.settings?.lastSyncAt) return false;
        if (state.lastDataChangeAt <= 0) return false;
        return state.lastDataChangeAt > SyncService.lastSuccessfulSyncLocalChangeAt;
    }

    static hasPendingLocalChangesForAutoSync(): boolean {
        const state = getStoreState();
        if (state.lastDataChangeAt <= 0) return false;
        return state.lastDataChangeAt > SyncService.lastSuccessfulSyncLocalChangeAt;
    }

    static async resolveExternalSyncChange(
        resolution: ExternalSyncChangeResolution
    ): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        const backend = await SyncService.getSyncBackend();
        if (backend !== 'file') return { success: false, error: 'External file conflict handling is only available for file sync.' };

        const pendingChange = SyncService.pendingExternalSyncChange;
        SyncService.setPendingExternalSyncChange(null);

        try {
            if (resolution === 'merge') {
                return await SyncService.performSync();
            }

            if (resolution === 'keep-local') {
                await syncServiceDependencies.flushPendingSave();
                const localData = await injectExternalCalendars(await readLocalDataForSync());
                const sanitized = sanitizeAppDataForRemote(localData);
                await SyncService.markSyncWrite(sanitized);
                try {
                    await tauriInvoke('write_sync_file', { data: sanitized });
                    return await SyncService.performSync();
                } catch (error) {
                    SyncService.finalizeSyncWriteIgnoreWindow();
                    throw error;
                }
            }

            await syncServiceDependencies.flushPendingSave();
            const externalData = normalizeAppData(await tauriInvoke<AppData>('read_sync_file'));
            await persistLocalDataForSync(externalData);
            await getStoreState().fetchData({ silent: true });
            const now = new Date().toISOString();
            const nextHistory = appendSyncHistory(getStoreState().settings, {
                at: now,
                status: 'success',
                backend: 'file',
                type: 'pull',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
                details: 'external_override',
            });
            const persisted = await SyncService.persistSuccessfulSyncStatus('success', now, nextHistory);
            if (!persisted) {
                throw new Error('Failed to persist sync status');
            }
            if (pendingChange?.incomingHash) {
                SyncService.lastObservedHash = pendingChange.incomingHash;
            }
            return { success: true };
        } catch (error) {
            SyncService.setPendingExternalSyncChange(pendingChange);
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    private static async handleFileChange(paths: string[]) {
        if (!isTauriRuntimeEnv()) return;
        if (SyncService.getMonotonicNow() < SyncService.ignoreFileEventsUntil) return;

        const hasSyncFile = paths.some((path) => isSyncFilePath(path, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME));
        if (!hasSyncFile) return;

        try {
            const syncData = await tauriInvoke<AppData>('read_sync_file');
            const normalized = normalizeAppData(syncData);
            const hash = await hashString(toStableJson(normalized));
            if (hash === SyncService.lastWrittenHash) {
                return;
            }
            if (hash === SyncService.lastObservedHash) {
                return;
            }
            SyncService.lastObservedHash = hash;

            if (SyncService.hasPendingLocalChangesForExternalSync()) {
                if (SyncService.externalSyncTimer) {
                    clearTimeout(SyncService.externalSyncTimer);
                    SyncService.externalSyncTimer = null;
                }
                const localState = getStoreState();
                const syncPath = SyncService.fileWatcherPath ?? await SyncService.getSyncPath();
                const pending = SyncService.pendingExternalSyncChange;
                if (!pending || pending.incomingHash !== hash) {
                    SyncService.setPendingExternalSyncChange({
                        at: new Date().toISOString(),
                        incomingHash: hash,
                        syncPath,
                        hasLocalChanges: true,
                        localChangeAt: localState.lastDataChangeAt,
                        lastSyncAt: localState.settings?.lastSyncAt,
                    });
                }
                return;
            }

            if (SyncService.externalSyncTimer) {
                clearTimeout(SyncService.externalSyncTimer);
            }
            SyncService.externalSyncTimer = setTimeout(() => {
                SyncService.performSync()
                    .then((result) => {
                        if (result.success) {
                            SyncService.setPendingExternalSyncChange(null);
                            const conflicts = summarizeMergeStats(result.stats).conflicts;
                            const message = conflicts > 0
                                ? `Data updated from sync (${conflicts} conflict${conflicts === 1 ? '' : 's'} resolved).`
                                : 'Data updated from sync.';
                            try {
                                useUiStore.getState().showToast(message, 'info', 5000);
                            } catch {
                                // UI store may be unavailable during bootstrap/tests.
                            }
                        }
                    })
                    .catch((error) => syncServiceDependencies.reportError('Sync failed', error));
            }, 750);
        } catch (error) {
            logSyncWarning('Failed to process external sync change', error);
        }
    }

    private static resolveUnwatch(unwatch: unknown): (() => void) | null {
        if (typeof unwatch === 'function') return unwatch as () => void;
        if (unwatch && typeof (unwatch as any).stop === 'function') {
            return () => (unwatch as any).stop();
        }
        if (unwatch && typeof (unwatch as any).unwatch === 'function') {
            return () => (unwatch as any).unwatch();
        }
        return null;
    }

    static async startFileWatcher(): Promise<void> {
        if (!isTauriRuntimeEnv()) return;
        const backend = await SyncService.getSyncBackend();
        if (backend !== 'file') {
            await SyncService.stopFileWatcher();
            return;
        }
        const syncPath = await SyncService.getSyncPath();
        if (!syncPath) {
            await SyncService.stopFileWatcher();
            return;
        }
        const watchPath = syncPath;
        if (SyncService.fileWatcherStop && SyncService.fileWatcherPath === watchPath && SyncService.fileWatcherBackend === backend) {
            return;
        }

        await SyncService.stopFileWatcher();

        try {
            const { watch } = await import('@tauri-apps/plugin-fs');
            const unwatch = await watch(watchPath, (event: any) => {
                const paths = Array.isArray(event?.paths)
                    ? event.paths
                    : event?.path
                        ? [event.path]
                        : [];
                if (paths.length === 0) return;
                void SyncService.handleFileChange(paths);
            });
            SyncService.fileWatcherStop = SyncService.resolveUnwatch(unwatch);
            SyncService.fileWatcherPath = watchPath;
            SyncService.fileWatcherBackend = backend;
        } catch (error) {
            logSyncWarning('Failed to start sync file watcher', error);
        }
    }

    static async stopFileWatcher(): Promise<void> {
        if (SyncService.fileWatcherStop) {
            try {
                SyncService.fileWatcherStop();
            } catch (error) {
                logSyncWarning('Failed to stop sync watcher', error);
            }
        }
        if (SyncService.externalSyncTimer) {
            clearTimeout(SyncService.externalSyncTimer);
            SyncService.externalSyncTimer = null;
        }
        SyncService.fileWatcherStop = null;
        SyncService.fileWatcherPath = null;
        SyncService.fileWatcherBackend = null;
        SyncService.setPendingExternalSyncChange(null);
    }

    static async cleanupAttachmentsNow(): Promise<void> {
        if (!isTauriRuntimeEnv()) return;
        const backend = await SyncService.getSyncBackend();
        const data = await tauriInvoke<AppData>('get_data');
        const cleaned = await cleanupOrphanedAttachments(data, backend, getAttachmentCleanupDeps());
        await persistLocalDataForSync(cleaned);
        await getStoreState().fetchData({ silent: true });
    }

    static async listDataSnapshots(): Promise<string[]> {
        if (!isTauriRuntimeEnv()) return [];
        try {
            return await tauriInvoke<string[]>('list_data_snapshots');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to list snapshots', error);
            return [];
        }
    }

    static async createDataSnapshot(): Promise<string | null> {
        if (!isTauriRuntimeEnv()) return null;
        try {
            return await tauriInvoke<string>('create_data_snapshot');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to create snapshot', error);
            return null;
        }
    }

    static async restoreDataSnapshot(snapshotFileName: string): Promise<{ success: boolean; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        try {
            await tauriInvoke<boolean>('restore_data_snapshot', { snapshotFileName });
            await getStoreState().fetchData({ silent: true });
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    /**
     * Perform a full sync cycle:
     * 1. Read Local & Remote Data
     * 2. Merge (Last-Write-Wins)
     * 3. Write merged data back to both Local & Remote
     * 4. Refresh Core Store
     */
    static async performSync(options: SyncRunOptions = {}): Promise<SyncRunResult> {
        if (SyncService.syncOrchestrator.getState().inFlight) {
            SyncService.queuedSyncOptions = options;
        }
        return SyncService.syncOrchestrator.run(options);
    }

    private static async runSyncCycle(options: SyncRunOptions): Promise<SyncRunResult> {
        SyncService.queuedSyncOptions = null;
        const context = SyncService.createSyncExecutionContext();
        const persistLocalData = async (data: AppData): Promise<void> => {
            if (isTauriRuntimeEnv()) {
                await persistLocalDataForSync(data);
            } else {
                await webStorage.saveData(data);
            }
        };

        SyncService.updateSyncStatus({
            inFlight: true,
            step: context.step,
            lastResult: SyncService.syncStatus.lastResult,
            lastResultAt: SyncService.syncStatus.lastResultAt,
        });
        await yieldToRenderer();

        const run = new SyncRun(options, context, {
            updateSyncStep: (next) => SyncService.updateSyncStatus({ step: next }),
            requestFollowUp: () => SyncService.requestQueuedSyncRun(options, false),
            acceptCoveredLocalSnapshot: (data) => SyncService.acceptCoveredLocalSnapshot(context, data),
            applySyncedDataToStore: (data) => syncServiceDependencies.applySyncedDataToStore(data),
            persistLocalData,
            getDropboxAccessToken: (appKey, tokenOptions) => SyncService.getDropboxAccessToken(appKey, tokenOptions),
            runDropboxWithRetry: (resolveToken, operation) => SyncService.runDropboxWithRetry(resolveToken, operation),
        });

        const runSync = async (): Promise<SyncRunResult> => {
            // 1. Flush pending writes so disk reflects the latest state
            run.setStep('flush');
            await yieldToRenderer();
            await syncServiceDependencies.flushPendingSave();
            context.localSnapshotChangeAt = getStoreState().lastDataChangeAt;

            // 2. Read/merge/write via shared core orchestration.
            await SyncService.prepareSyncExecutionContext(run);
            if (context.backend === 'off') {
                return { success: true };
            }

            // CloudKit setup: ensure zone and subscription exist before syncing.
            if (context.backend === 'cloudkit') {
                run.setStep('cloudkit_setup');
                await yieldToRenderer();
                await syncServiceDependencies.ensureCloudKitReady();
            }

            const unchangedResult = await SyncService.trySkipUnchangedSync(run);
            if (unchangedResult) {
                return unchangedResult;
            }

            // Pre-sync local attachments so cloudKeys exist before writing remote data.
            await SyncService.runPreSyncAttachmentPhase(run);

            const syncResult = await syncServiceDependencies.performSyncCycle({
                readLocal: async () => {
                    const data = await SyncService.readLocalDataForSyncCycle(context);
                    logSyncPayloadTrace('Sync trace read local payload', data, {
                        backend: context.backend,
                    });
                    return data;
                },
                readRemote: async () => {
                    const data = await SyncService.readRemoteDataByBackend(run);
                    logSyncPayloadTrace('Sync trace read remote payload', data, {
                        backend: context.backend,
                    });
                    return data;
                },
                writeLocal: async (data) => {
                    logSyncPayloadTrace('Sync trace write local payload', data, {
                        backend: context.backend,
                        step: context.step,
                    });
                    run.ensureLocalSnapshotFresh(data);
                    await run.persistLocalDataWithTracking(data);
                },
                clearPendingRemoteWriteAfterLocalAbort: async (pendingAt) => {
                    const current = syncServiceDependencies.getInMemoryAppDataSnapshot();
                    if (current.settings.pendingRemoteWriteAt && current.settings.pendingRemoteWriteAt !== pendingAt) return;
                    await run.persistLocalDataWithTracking({
                        ...current,
                        settings: {
                            ...current.settings,
                            pendingRemoteWriteAt: undefined,
                            pendingRemoteWriteRetryAt: undefined,
                            pendingRemoteWriteAttempts: undefined,
                        },
                    });
                },
                flushPendingLocalBeforeRetryRead: syncServiceDependencies.flushPendingSave,
                prepareRemoteWrite: (data) => SyncService.prepareRemoteWriteData(run, data),
                writeRemote: async (data) => {
                    logSyncPayloadTrace('Sync trace write remote payload', data, {
                        backend: context.backend,
                    });
                    run.ensureLocalSnapshotFresh(data);
                    await SyncService.writeRemoteDataByBackend(run, data);
                },
                onStep: (next) => {
                    run.setStep(next);
                },
                yieldToUi: yieldToRenderer,
                historyContext: {
                    backend: context.backend,
                    type: 'merge',
                },
            });
            if (syncResult.status === 'skipped') {
                logSyncInfo('Sync skipped while pending remote write backoff is active', {
                    backend: context.backend,
                    retryInMs: String(Math.ceil(syncResult.retryInMs)),
                });
                return { success: true, skipped: 'pendingRemoteWriteBackoff' as const };
            }
            const stats = syncResult.stats;
            let mergedData = syncResult.data;
            logSyncPayloadTrace('Sync trace core result payload', mergedData, {
                backend: context.backend,
                areaStatsLocal: String(stats.areas.localTotal),
                areaStatsIncoming: String(stats.areas.incomingTotal),
                areaStatsMerged: String(stats.areas.mergedTotal),
                areaStatsIncomingOnly: String(stats.areas.incomingOnly),
            });
            let canRecordFastSyncState = true;
            const markFastSyncStateUnsafe = () => {
                canRecordFastSyncState = false;
            };
            await persistExternalCalendars(mergedData);
            SyncService.logSyncMergeSummary(stats);
            run.ensureLocalSnapshotFresh(mergedData);

            const preAttachmentMergedData = mergedData;
            mergedData = await SyncService.runPostMergeAttachmentPhase(run, mergedData);
            if (mergedData !== preAttachmentMergedData) {
                markFastSyncStateUnsafe();
            }
            logSyncPayloadTrace('Sync trace post-attachment payload', mergedData, {
                backend: context.backend,
            });

            await cleanupAttachmentTempFiles(getAttachmentCleanupDeps());

            if (isTauriRuntimeEnv() && shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
                const orphanedAttachments = findOrphanedAttachments(mergedData);
                const deletedAttachments = findDeletedAttachmentsForFileCleanup(mergedData);
                const pendingRemoteDeletes = mergedData.settings.attachments?.pendingRemoteDeletes ?? [];
                if (orphanedAttachments.length > 0 || deletedAttachments.length > 0 || pendingRemoteDeletes.length > 0) {
                    run.setStep('attachments_cleanup');
                    await yieldToRenderer();
                    run.ensureLocalSnapshotFresh(mergedData);
                    run.ensureNetworkStillAvailable();
                    mergedData = await cleanupOrphanedAttachments(mergedData, context.backend, getAttachmentCleanupDeps());
                    if (orphanedAttachments.length > 0) {
                        markFastSyncStateUnsafe();
                    }
                    await run.persistLocalDataWithTracking(mergedData);
                }
            }

            if (canRecordFastSyncState) {
                await SyncService.recordFastSyncState(run, mergedData);
            }

            // 7. Refresh UI Store
            run.setStep('refresh');
            await yieldToRenderer();
            run.ensureLocalSnapshotFresh(mergedData);
            syncServiceDependencies.applySyncedDataToStore(mergedData);
            SyncService.acceptCoveredLocalSnapshot(context, mergedData);
            SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;

            SyncService.setPendingExternalSyncChange(null);

            getStoreState().setError(null);
            SyncService.clearCoveredQueuedSyncRun(context, options);
            return { success: true, stats };
        };

        const resultPromise = runSync().catch(async (error) => {
            if (error instanceof LocalSyncAbort) {
                await SyncService.persistPreSyncedLocalDataIfNeeded(run);
                return { success: true, skipped: 'requeued' as const };
            }
            logSyncWarning('Sync failed', error);
            const now = new Date().toISOString();
            const safeMessage = formatSyncErrorMessage(error, context.backend);
            let logHint = '';
            try {
                const logPath = await syncServiceDependencies.logSyncError(error, {
                    backend: context.backend,
                    step: context.step,
                    url: context.syncUrl,
                });
                logHint = logPath ? ` (log: ${logPath})` : '';
            } catch (logError) {
                logSyncWarning('Failed to write sync error log', logError);
            }
            const finalErrorMessage = `${safeMessage}${logHint}`;
            const nextHistory = appendSyncHistory(getStoreState().settings, {
                at: now,
                status: 'error',
                backend: context.backend,
                type: 'merge',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
                details: context.step,
                error: finalErrorMessage,
            });
            getStoreState().setError(finalErrorMessage);
            try {
                await getStoreState().fetchData({ silent: true });
                await persistSyncSettings({
                    lastSyncAt: now,
                    lastSyncStatus: 'error',
                    lastSyncError: finalErrorMessage,
                    lastSyncHistory: nextHistory,
                });
            } catch (e) {
                logSyncWarning('Failed to persist sync error', e);
            }
            return { success: false, error: finalErrorMessage };
        });

        let result: SyncRunResult;
        try {
            result = await resultPromise;
        } finally {
            context.requestAbortController.abort();
            try {
                const releaseNetworkListener = context.removeNetworkListener as (() => void) | null;
                if (typeof releaseNetworkListener === 'function') {
                    releaseNetworkListener();
                }
                context.removeNetworkListener = null;
            } catch (error) {
                logSyncWarning('Failed to unsubscribe network listener after sync', error);
            }
            SyncService.finalizeSyncWriteIgnoreWindow();
        }
        const skippedRequeue = result.skipped === 'requeued';
        if (!skippedRequeue) {
            SyncService.finalizeAttachmentWarningState(context, result);
        }
        SyncService.updateSyncStatus({
            inFlight: false,
            step: null,
            lastResult: skippedRequeue
                ? SyncService.syncStatus.lastResult
                : result.success
                    ? 'success'
                    : 'error',
            lastResultAt: skippedRequeue
                ? SyncService.syncStatus.lastResultAt
                : new Date().toISOString(),
        });

        if (!SyncService.syncOrchestrator.getState().queued) {
            SyncService.queuedSyncOptions = null;
        }

        return result;
    }
}

export const __syncServiceTestUtils = {
    setDependenciesForTests(overrides: Partial<SyncServiceDependencies>) {
        syncServiceDependencies = {
            ...syncServiceDependencies,
            ...overrides,
        };
    },
    resetDependenciesForTests() {
        syncServiceDependencies = {
            ...defaultSyncServiceDependencies,
        };
    },
    async persistLocalDataForTests(data: AppData) {
        await persistLocalDataForSync(data);
    },
    clearWebdavDownloadBackoff() {
        clearAttachmentSyncState();
    },
    clearAttachmentValidationFailures() {
        clearAttachmentValidationFailures();
    },
    simulateAttachmentValidationFailure(attachment: Attachment, error?: string) {
        return handleAttachmentValidationFailure(attachment, error);
    },
    getAttachmentValidationFailureAttempts(attachmentId: string) {
        return getAttachmentValidationFailureAttempts(attachmentId);
    },
};
