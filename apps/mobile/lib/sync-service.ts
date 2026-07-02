import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { AppData, MergeStats, createSyncOrchestrator, ensureFreshLocalSyncSnapshot, runPreSyncAttachmentPhase, useTaskStore, webdavGetJson, webdavHeadFile, webdavPutJson, cloudGetJson, cloudHeadJson, cloudPutJson, flushPendingSave, performSyncCycle, CLOCK_SKEW_THRESHOLD_MS, appendSyncHistory, withRetry, isRetryableWebdavReadError, isWebdavInvalidJsonError, normalizeWebdavUrl, normalizeCloudUrl, sanitizeAppDataForRemote, buildHttpRemoteFileFingerprint, computeStableValueFingerprint, computeSyncPayloadFingerprint, areSyncPayloadsEqual, assertNoPendingAttachmentUploads, buildFastSyncScope, buildMergeSummaryLog, buildPendingAttachmentUploadLogExtra, findPendingAttachmentUploads, hasPendingSyncSideEffects, injectExternalCalendars as injectExternalCalendarsForSync, persistExternalCalendars as persistExternalCalendarsForSync, mergeAppData, cloneAppData, LocalSyncAbort, getInMemoryAppDataSnapshot, shouldRunAttachmentCleanup, createAbortableFetch, normalizeCloudProvider as normalizeCoreCloudProvider, isDropboxUnauthorizedError, parseFastSyncState, serializeFastSyncState, decodeUriSafe, SYNC_FILE_NAME, CLOUD_PROVIDER_DROPBOX, CLOUD_PROVIDER_SELF_HOSTED, type Attachment, type CloudJsonWriteResult, type CloudProvider, type FastSyncState, type PendingAttachmentUpload, type RemoteJsonWriteResult } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { readSyncFile, resolveSyncFileUri, writeSyncFile } from './storage-file';
import { isSyncPathBookmarksAvailable, resolveSyncPathBookmark } from './sync-path-bookmarks';
import { getBaseSyncUrl, getCloudBaseUrl, syncCloudAttachments, syncCloudKitAttachments, syncDropboxAttachments, syncFileAttachments, syncWebdavAttachments, cleanupAttachmentTempFiles, hasPendingAttachmentSyncWork } from './attachment-sync';
import { runMobileAttachmentCleanup } from './sync-attachment-cleanup';
import { getExternalCalendars, saveExternalCalendars } from './external-calendar';
import { forceRefreshDropboxAccessToken, getValidDropboxAccessToken, isDropboxConnected } from './dropbox-auth';
import {
  DropboxConflictError,
  DropboxFileNotFoundError,
  DropboxUnauthorizedError,
  deleteDropboxFile,
  downloadDropboxAppData,
  getDropboxAppDataMetadata,
  uploadDropboxAppData,
} from './dropbox-sync';
import * as Network from 'expo-network';
import { coerceSupportedBackend, formatSyncErrorMessage, isLikelyFilePath, isLikelyOfflineSyncError, isRemoteSyncBackend, normalizeFileSyncPath, resolveBackend, type SyncBackend } from './sync-service-utils';
import { ensureCloudKitReady, readRemoteCloudKit, writeRemoteCloudKit, isCloudKitAvailable } from './cloudkit-sync';
import { createWebdavSyncRateLimitController } from './sync-rate-limit';
import {
  SYNC_PATH_KEY,
  SYNC_BACKEND_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_ALLOW_INSECURE_HTTP_KEY,
  WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
  CLOUD_URL_KEY,
  CLOUD_TOKEN_KEY,
  CLOUD_PROVIDER_KEY,
  CLOUD_ALLOW_INSECURE_HTTP_KEY,
  SYNC_PATH_BOOKMARK_KEY,
  DROPBOX_LAST_REV_KEY,
} from './sync-constants';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const WEBDAV_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 30_000 };
const WEBDAV_READ_RETRY_OPTIONS = { ...WEBDAV_RETRY_OPTIONS, shouldRetry: isRetryableWebdavReadError };
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_CONFIG_CACHE_TTL_MS = 30_000;
const FAST_SYNC_STATE_KEY = '@mindwtr_fast_sync_state_v1';
const LOCAL_SYNC_STATUS_KEY = '@mindwtr_local_sync_status_v1';
const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();

type RemoteWriteResultLike = Partial<RemoteJsonWriteResult & CloudJsonWriteResult>;
type LocalSyncStatus = Pick<AppData['settings'], 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'>;

const normalizeRemoteWriteResult = (
  source: 'cloud' | 'webdav',
  result: RemoteWriteResultLike | null | undefined
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
const IOS_TEMP_INBOX_PATH_PATTERN = /\/tmp\/[^/]*-Inbox\//i;
const INVALID_CONFIG_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
type MobileSyncActivityState = 'idle' | 'syncing';
type MobileSyncActivityListener = (state: MobileSyncActivityState) => void;
type MobileSyncSkipReason = 'offline' | 'requeued' | 'unchanged' | 'pendingRemoteWriteBackoff';
type MobileSyncResult = { success: boolean; stats?: MergeStats; error?: string; skipped?: MobileSyncSkipReason };
type MobileWebDavSyncConfig = { url: string; username: string; password: string; allowInsecureHttp?: boolean; allowWeakFingerprint?: boolean };
type MobileCloudSyncConfig = { url: string; token: string; allowInsecureHttp?: boolean };
const isFossBuild = (() => {
  const extra = Constants.expoConfig?.extra as { isFossBuild?: unknown } | undefined;
  return extra?.isFossBuild === true || extra?.isFossBuild === 'true';
})();
const DROPBOX_SYNC_ENABLED = !isFossBuild;

const logSyncWarning = (message: string, error?: unknown) => {
  const extra = error ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) } : undefined;
  void logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
  void logInfo(message, { scope: 'sync', extra });
};

const logPendingAttachmentUploads = (message: string, backend: string, phase: string, pending: PendingAttachmentUpload[]): void => {
  if (pending.length === 0) return;
  void logWarn(message, {
    scope: 'sync',
    extra: buildPendingAttachmentUploadLogExtra(backend, phase, pending, sanitizeLogMessage),
  });
};

const sanitizeConfigValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (!value) return null;
  if (INVALID_CONFIG_CHAR_PATTERN.test(value)) return null;
  return value;
};

const resolveCloudProvider = (value: string | null): CloudProvider => (
  normalizeCoreCloudProvider(value, { allowDropbox: DROPBOX_SYNC_ENABLED })
);

const getDropboxAppKey = (): string => {
  const extra = Constants.expoConfig?.extra as { dropboxAppKey?: unknown } | undefined;
  return typeof extra?.dropboxAppKey === 'string' ? extra.dropboxAppKey.trim() : '';
};

const externalCalendarProvider = {
  load: () => getExternalCalendars(),
  save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
    saveExternalCalendars(calendars ?? []),
  onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
  injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
  persistExternalCalendarsForSync(data, externalCalendarProvider);

const readFastSyncState = async (scope: string): Promise<FastSyncState | null> => {
  try {
    const raw = await AsyncStorage.getItem(FAST_SYNC_STATE_KEY);
    return parseFastSyncState(raw, scope);
  } catch {
    return null;
  }
};

const writeFastSyncState = async (state: FastSyncState): Promise<void> => {
  try {
    await AsyncStorage.setItem(FAST_SYNC_STATE_KEY, serializeFastSyncState(state));
  } catch (error) {
    logSyncWarning('Failed to cache sync fast-check state', error);
  }
};

const sanitizeLocalSyncStatus = (value: Partial<LocalSyncStatus>): Partial<LocalSyncStatus> => {
  const next: Partial<LocalSyncStatus> = {};
  if (typeof value.lastSyncAt === 'string') next.lastSyncAt = value.lastSyncAt;
  if (
    value.lastSyncStatus === 'idle'
    || value.lastSyncStatus === 'syncing'
    || value.lastSyncStatus === 'success'
    || value.lastSyncStatus === 'error'
    || value.lastSyncStatus === 'conflict'
  ) {
    next.lastSyncStatus = value.lastSyncStatus;
  }
  if (typeof value.lastSyncError === 'string') next.lastSyncError = value.lastSyncError;
  if (value.lastSyncStats && typeof value.lastSyncStats === 'object') next.lastSyncStats = value.lastSyncStats;
  if (Array.isArray(value.lastSyncHistory)) next.lastSyncHistory = value.lastSyncHistory;
  return next;
};

const readLocalSyncStatus = async (): Promise<Partial<LocalSyncStatus> | null> => {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_SYNC_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalSyncStatus>;
    const status = sanitizeLocalSyncStatus(parsed);
    return Object.keys(status).length > 0 ? status : null;
  } catch {
    return null;
  }
};

const writeLocalSyncStatus = async (updates: Partial<LocalSyncStatus>): Promise<void> => {
  try {
    const next = sanitizeLocalSyncStatus({
      ...(await readLocalSyncStatus() ?? {}),
      ...updates,
    });
    await AsyncStorage.setItem(LOCAL_SYNC_STATUS_KEY, JSON.stringify(next));
  } catch (error) {
    logSyncWarning('Failed to cache local sync status', error);
  }
};

const applyLocalSyncStatus = async (updates: Partial<LocalSyncStatus>): Promise<void> => {
  await writeLocalSyncStatus(updates);
  useTaskStore.setState((state) => ({
    settings: {
      ...(state.settings ?? {}),
      ...updates,
    },
  }));
};

const mergeLocalSyncStatus = async (data: AppData): Promise<AppData> => {
  const status = await readLocalSyncStatus();
  if (!status) return data;
  return {
    ...data,
    settings: {
      ...(data.settings ?? {}),
      ...status,
    },
  };
};

let mobileSyncActivityState: MobileSyncActivityState = 'idle';
const mobileSyncActivityListeners = new Set<MobileSyncActivityListener>();
const webdavSyncRateLimitController = createWebdavSyncRateLimitController();
let activeMobileSyncAbortController: AbortController | null = null;
let activeMobileSyncAbortReason: 'lifecycle' | null = null;

const setMobileSyncActivityState = (next: MobileSyncActivityState) => {
  if (mobileSyncActivityState === next) return;
  mobileSyncActivityState = next;
  mobileSyncActivityListeners.forEach((listener) => {
    try {
      listener(next);
    } catch (error) {
      logSyncWarning('Failed to notify sync activity listener', error);
    }
  });
};

export const getMobileSyncActivityState = (): MobileSyncActivityState => mobileSyncActivityState;

export const subscribeMobileSyncActivityState = (listener: MobileSyncActivityListener): (() => void) => {
  mobileSyncActivityListeners.add(listener);
  listener(mobileSyncActivityState);
  return () => {
    mobileSyncActivityListeners.delete(listener);
  };
};

const readConfigValue = async (key: string, useCache = true): Promise<string | null> => {
  if (!useCache) {
    return sanitizeConfigValue(await AsyncStorage.getItem(key));
  }
  const now = Date.now();
  const cached = syncConfigCache.get(key);
  if (cached && now - cached.readAt <= SYNC_CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = sanitizeConfigValue(await AsyncStorage.getItem(key));
  syncConfigCache.set(key, { value, readAt: now });
  return value;
};

export const clearMobileSyncConfigCache = (): void => {
  syncConfigCache.clear();
};

const getCachedConfigValue = async (key: string): Promise<string | null> => {
  return readConfigValue(key, true);
};

const getPathLeaf = (path: string): string => {
  const stripped = path.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') ?? '';
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
};

const SYNC_BOOKMARK_EXPIRED_MESSAGE =
  'Sync location access expired. Please re-select the sync folder or file in Settings -> Data & Sync.';

const resolveBookmarkedFileSyncPath = async (
  syncPath: string | null
): Promise<{ path: string | null; bookmark: string | null }> => {
  if (Platform.OS !== 'ios') return { path: syncPath, bookmark: null };

  const bookmark = (await getCachedConfigValue(SYNC_PATH_BOOKMARK_KEY))?.trim() ?? null;
  if (!bookmark) return { path: syncPath, bookmark: null };

  const resolved = await resolveSyncPathBookmark(bookmark);
  if (!resolved?.uri) {
    if (isSyncPathBookmarksAvailable()) {
      throw new Error(SYNC_BOOKMARK_EXPIRED_MESSAGE);
    }
    return { path: syncPath, bookmark };
  }

  let activeBookmark = bookmark;
  if (resolved.refreshedBookmark && resolved.refreshedBookmark !== bookmark) {
    await AsyncStorage.setItem(SYNC_PATH_BOOKMARK_KEY, resolved.refreshedBookmark);
    syncConfigCache.set(SYNC_PATH_BOOKMARK_KEY, { value: resolved.refreshedBookmark, readAt: Date.now() });
    activeBookmark = resolved.refreshedBookmark;
    logSyncInfo('Refreshed stale iOS sync-path bookmark');
  }

  const bookmarkUri = resolved.uri;
  let resolvedPath = bookmarkUri;
  if (syncPath && isLikelyFilePath(syncPath) && !isLikelyFilePath(bookmarkUri)) {
    const leafName = getPathLeaf(syncPath) || SYNC_FILE_NAME;
    resolvedPath = `${bookmarkUri.replace(/\/+$/, '')}/${leafName}`;
  }

  if (!syncPath || resolvedPath !== syncPath) {
    await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
    syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
    logSyncInfo('Resolved iOS sync-folder bookmark', {
      bookmarkPath: bookmarkUri,
      filePath: resolvedPath,
    });
  }

  return { path: resolvedPath, bookmark: activeBookmark };
};

const getSupportedBackend = (rawBackend: string | null): SyncBackend =>
  coerceSupportedBackend(resolveBackend(rawBackend), isCloudKitAvailable());

export async function getMobileSyncConfigurationStatus(): Promise<{ backend: SyncBackend; configured: boolean }> {
  const rawBackend = (await readConfigValue(SYNC_BACKEND_KEY, false))?.trim() ?? null;
  const backend: SyncBackend = getSupportedBackend(rawBackend);

  if (backend === 'off') {
    return { backend, configured: false };
  }
  if (backend === 'file') {
    const syncPath = (await readConfigValue(SYNC_PATH_KEY, false))?.trim();
    return { backend, configured: Boolean(syncPath) };
  }
  if (backend === 'webdav') {
    const webdavUrl = (await readConfigValue(WEBDAV_URL_KEY, false))?.trim();
    return { backend, configured: Boolean(webdavUrl) };
  }
  if (backend === 'cloudkit') {
    // CloudKit is always "configured" if the module is available — no user credentials needed.
    return { backend, configured: isCloudKitAvailable() };
  }

  const cloudProvider = resolveCloudProvider((await readConfigValue(CLOUD_PROVIDER_KEY, false))?.trim() ?? null);
  if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
    const dropboxConnected = await isDropboxConnected().catch(() => false);
    return {
      backend,
      configured: DROPBOX_SYNC_ENABLED && getDropboxAppKey().length > 0 && dropboxConnected,
    };
  }

  const cloudUrl = (await readConfigValue(CLOUD_URL_KEY, false))?.trim();
  const cloudToken = (await readConfigValue(CLOUD_TOKEN_KEY, false))?.trim();
  return {
    backend,
    configured: Boolean(cloudUrl && cloudToken),
  };
}

const getAttachmentsArray = (attachments: Attachment[] | undefined): Attachment[] => (
  Array.isArray(attachments) ? attachments : []
);

const getSyncDiagnosticAttachmentCount = (data: AppData): number => {
  const taskAttachments = data.tasks.reduce(
    (count, task) => count + getAttachmentsArray(task.attachments).length,
    0
  );
  const projectAttachments = data.projects.reduce(
    (count, project) => count + getAttachmentsArray(project.attachments).length,
    0
  );
  return taskAttachments + projectAttachments;
};

const buildSyncDataDiagnostics = (data: AppData | null | undefined): Record<string, string> => {
  if (!data) return { hasData: 'false' };
  const contexts = new Set<string>();
  const tags = new Set<string>();
  for (const task of data.tasks) {
    for (const context of task.contexts) contexts.add(context);
    for (const tag of task.tags) tags.add(tag);
  }
  return {
    hasData: 'true',
    tasks: String(data.tasks.length),
    projects: String(data.projects.length),
    areas: String(data.areas.length),
    contexts: String(contexts.size),
    tags: String(tags.size),
    checklistItems: String(data.tasks.reduce(
      (count, task) => count + (Array.isArray(task.checklist) ? task.checklist.length : 0),
      0
    )),
    attachments: String(getSyncDiagnosticAttachmentCount(data)),
  };
};

const getSyncDiagnosticElapsedMs = (startedAt: number): string => (
  String(Math.max(0, Date.now() - startedAt))
);

const logSyncDiagnostic = (
  message: string,
  startedAt: number,
  extra?: Record<string, string>
) => {
  logSyncInfo(message, {
    elapsedMs: getSyncDiagnosticElapsedMs(startedAt),
    ...(extra ?? {}),
  });
};

const buildOfflineSkipResult = (): MobileSyncResult => ({
  success: true,
  skipped: 'offline',
});

const buildRequeuedSkipResult = (): MobileSyncResult => ({
  success: true,
  skipped: 'requeued',
});

type MobileNetworkStatus = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  isAirplaneModeEnabled: boolean;
};

const getMobileNetworkStatus = (state: {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  isAirplaneModeEnabled?: unknown;
}): MobileNetworkStatus => ({
  isConnected: typeof state.isConnected === 'boolean' ? state.isConnected : null,
  isInternetReachable: typeof state.isInternetReachable === 'boolean' ? state.isInternetReachable : null,
  isAirplaneModeEnabled: typeof state.isAirplaneModeEnabled === 'boolean' ? state.isAirplaneModeEnabled : false,
});

const isDefinitelyOfflineNetworkStatus = (status: MobileNetworkStatus): boolean => (
  status.isAirplaneModeEnabled
  || status.isConnected === false
  || (status.isConnected !== true && status.isInternetReachable === false)
);

const formatNetworkStatusForLog = (status: MobileNetworkStatus): Record<string, string> => ({
  isConnected: status.isConnected === null ? 'unknown' : String(status.isConnected),
  isInternetReachable: status.isInternetReachable === null ? 'unknown' : String(status.isInternetReachable),
  isAirplaneModeEnabled: String(status.isAirplaneModeEnabled),
});

const shouldSkipSyncForOfflineState = async (
  backend: SyncBackend,
  onOffline?: (status: MobileNetworkStatus) => void
): Promise<boolean> => {
  if (!isRemoteSyncBackend(backend)) return false;
  try {
    const state = await Network.getNetworkStateAsync();
    const status = getMobileNetworkStatus(state);

    if (isDefinitelyOfflineNetworkStatus(status)) {
      onOffline?.(status);
      logSyncInfo('Sync skipped: offline/airplane mode', {
        backend,
        ...formatNetworkStatusForLog(status),
      });
      return true;
    }
  } catch (error) {
    logSyncWarning('Failed to read network state before sync', error);
  }
  return false;
};

const mobileSyncOrchestrator = createSyncOrchestrator<string | undefined, MobileSyncResult>({
  runCycle: async (syncPathOverride, { requestFollowUp }) => {
    const rawBackend = (await getCachedConfigValue(SYNC_BACKEND_KEY))?.trim() ?? null;
    const backend: SyncBackend = getSupportedBackend(rawBackend);

    if (backend === 'off') {
      return { success: true };
    }
    if (await shouldSkipSyncForOfflineState(backend)) {
      return buildOfflineSkipResult();
    }

    logSyncInfo('Sync start', { backend });

    let step = 'init';
    const syncDiagnosticStartedAt = Date.now();
    let syncDiagnosticPhaseStartedAt = syncDiagnosticStartedAt;
    const logSyncPhaseDiagnostic = (phase: string, extra?: Record<string, string>) => {
      logSyncDiagnostic('Sync diagnostic phase', syncDiagnosticPhaseStartedAt, {
        backend,
        phase,
        step,
        ...(extra ?? {}),
      });
      syncDiagnosticPhaseStartedAt = Date.now();
    };
    logSyncInfo('Sync diagnostic start', { backend });
    let visibleActivityStarted = false;
    let syncUrl: string | undefined;
    let wroteLocal = false;
    let localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
    let networkWentOffline = false;
    let offlineDetectionCause: string | null = null;
    let lastOfflineNetworkStatus: MobileNetworkStatus | null = null;
    let networkSubscription: { remove?: () => void } | null = null;
    let preSyncedLocalData: AppData | null = null;
    const requestAbortController = new AbortController();
    activeMobileSyncAbortController = requestAbortController;
    activeMobileSyncAbortReason = null;
    const fetchWithAbort = createAbortableFetch(fetch, { baseSignal: requestAbortController.signal });
    const startVisibleSyncActivity = () => {
      if (visibleActivityStarted) return;
      visibleActivityStarted = true;
      setMobileSyncActivityState('syncing');
    };
    const ensureLocalSnapshotFresh = () => {
      ensureFreshLocalSyncSnapshot({
        localSnapshotChangeAt,
        getCurrentChangeAt: () => useTaskStore.getState().lastDataChangeAt,
        requestFollowUp: () => requestFollowUp(syncPathOverride),
        onStale: ({ localSnapshotChangeAt: snapshotChangeAt, currentChangeAt }) => {
          logSyncInfo('Sync detected local data changes during cycle; queued follow-up', {
            backend,
            step,
            snapshotChangeAt: String(snapshotChangeAt),
            currentChangeAt: String(currentChangeAt),
          });
        },
      });
    };
    const ensureWebdavSyncNotRateLimited = () => {
      webdavSyncRateLimitController.assertReady(backend);
    };
    const handleWebdavRateLimit = (error: unknown) => {
      if (!webdavSyncRateLimitController.noteError(backend, error)) return;
      logSyncWarning('WebDAV rate limited; pausing remote sync', error);
    };
    const markNetworkOffline = (cause: string, status?: MobileNetworkStatus) => {
      networkWentOffline = true;
      offlineDetectionCause = cause;
      lastOfflineNetworkStatus = status ?? lastOfflineNetworkStatus;
    };
    const ensureNetworkStillAvailable = async () => {
      if (!isRemoteSyncBackend(backend)) return;
      if (networkWentOffline) {
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
      if (await shouldSkipSyncForOfflineState(backend, (status) => markNetworkOffline('network-check', status))) {
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
    };
    try {
      if (isRemoteSyncBackend(backend)) {
        try {
          networkSubscription = Network.addNetworkStateListener((state) => {
            const status = getMobileNetworkStatus(state);
            if (isDefinitelyOfflineNetworkStatus(status)) {
              markNetworkOffline('network-listener', status);
              requestAbortController.abort();
            }
          });
        } catch (error) {
          logSyncWarning('Failed to subscribe to network state during sync', error);
        }
      }
      let webdavConfig: MobileWebDavSyncConfig | null = null;
      let cloudConfig: MobileCloudSyncConfig | null = null;
      let cloudProvider: CloudProvider = CLOUD_PROVIDER_SELF_HOSTED;
      let dropboxClientId = '';
      let dropboxLastRev: string | null = null;
      let fileSyncPath: string | null = null;
      let fileSyncBookmark: string | null = null;
      let remoteDataForCompare: AppData | null = null;
      let lastRemoteWriteFingerprint: string | null = null;
      let lastRemoteWriteMergedServerData = false;
      let localDataCache: { changeAt: number; data: AppData } | null = null;
      let readCheckRemoteData: AppData | null | undefined;
      let webdavRemoteCorrupted = false;
      step = 'flush';
      await flushPendingSave();
      logSyncPhaseDiagnostic('flush');
      localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
      if (backend === 'file') {
        const configuredSyncPath = (await getCachedConfigValue(SYNC_PATH_KEY))?.trim() ?? null;
        fileSyncPath = syncPathOverride || configuredSyncPath;
        const bookmarkResolution = await resolveBookmarkedFileSyncPath(fileSyncPath);
        fileSyncPath = bookmarkResolution.path;
        fileSyncBookmark = bookmarkResolution.bookmark;
        if (!fileSyncPath) {
          return { success: true };
        }
        const normalizedPath = normalizeFileSyncPath(fileSyncPath, Platform.OS);
        if (normalizedPath && normalizedPath !== fileSyncPath) {
          fileSyncPath = normalizedPath;
          await AsyncStorage.setItem(SYNC_PATH_KEY, normalizedPath);
          syncConfigCache.set(SYNC_PATH_KEY, { value: normalizedPath, readAt: Date.now() });
          logSyncInfo('Normalized file sync path to iOS file URI');
        }
        if (fileSyncPath.startsWith('file://') && IOS_TEMP_INBOX_PATH_PATTERN.test(decodeUriSafe(fileSyncPath))) {
          throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Sync.');
        }
        if (fileSyncPath.startsWith('content://')) {
          try {
            const resolvedPath = await resolveSyncFileUri(fileSyncPath, { createIfMissing: true });
            if (resolvedPath && resolvedPath !== fileSyncPath) {
              await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
              syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
              logSyncInfo('Normalized SAF sync path');
              fileSyncPath = resolvedPath;
            }
          } catch (error) {
            logSyncWarning('Failed to normalize SAF sync path', error);
          }
        } else if (!isLikelyFilePath(fileSyncPath)) {
          const trimmed = fileSyncPath.replace(/\/+$/, '');
          fileSyncPath = `${trimmed}/${SYNC_FILE_NAME}`;
        }
      }
      if (backend === 'webdav') {
        const url = (await getCachedConfigValue(WEBDAV_URL_KEY))?.trim() ?? null;
        if (!url) throw new Error('WebDAV URL not configured');
        syncUrl = normalizeWebdavUrl(url);
        const username = (await getCachedConfigValue(WEBDAV_USERNAME_KEY)) ?? '';
        const password = (await getCachedConfigValue(WEBDAV_PASSWORD_KEY)) ?? '';
        const allowInsecureHttp = (await getCachedConfigValue(WEBDAV_ALLOW_INSECURE_HTTP_KEY)) === 'true';
        const allowWeakFingerprint = (await getCachedConfigValue(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY)) !== 'false';
        webdavConfig = { url: syncUrl, username, password, allowInsecureHttp, allowWeakFingerprint };
      }
      if (backend === 'cloud') {
        const storedCloudProvider = (await getCachedConfigValue(CLOUD_PROVIDER_KEY))?.trim() ?? null;
        cloudProvider = resolveCloudProvider(storedCloudProvider);
        if (!DROPBOX_SYNC_ENABLED && storedCloudProvider === CLOUD_PROVIDER_DROPBOX) {
          throw new Error('Dropbox sync is unavailable in this build. Choose Self-hosted Cloud or install the Dropbox-enabled build.');
        }
        if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          dropboxClientId = getDropboxAppKey();
          if (!dropboxClientId) {
            throw new Error('Dropbox app key is not configured');
          }
          dropboxLastRev = (await getCachedConfigValue(DROPBOX_LAST_REV_KEY))?.trim() ?? null;
          syncUrl = 'dropbox://Apps/Mindwtr/data.json';
        } else {
          const url = (await getCachedConfigValue(CLOUD_URL_KEY))?.trim() ?? null;
          if (!url) throw new Error('Self-hosted URL not configured');
          syncUrl = normalizeCloudUrl(url);
          const token = (await getCachedConfigValue(CLOUD_TOKEN_KEY))?.trim() ?? '';
          const allowInsecureHttp = (await getCachedConfigValue(CLOUD_ALLOW_INSECURE_HTTP_KEY)) === 'true';
          cloudConfig = { url: syncUrl, token, allowInsecureHttp };
        }
      }
      const runDropboxOperation = async <T,>(
        operation: (accessToken: string) => Promise<T>
      ): Promise<T> => {
        let accessToken = await getValidDropboxAccessToken(dropboxClientId, fetchWithAbort);
        try {
          return await operation(accessToken);
        } catch (error) {
          if (!isDropboxUnauthorizedError(error)) throw error;
          accessToken = await forceRefreshDropboxAccessToken(dropboxClientId, fetchWithAbort);
          return operation(accessToken);
        }
      };

      // CloudKit setup — ensure zone and subscription exist before sync cycle.
      if (backend === 'cloudkit') {
        if (!isCloudKitAvailable()) {
          throw new Error('CloudKit is not available on this platform');
        }
        step = 'cloudkit_setup';
        logSyncInfo('Sync step', { step });
        await ensureCloudKitReady({ signal: requestAbortController.signal });
      }

      const readLocalDataForSyncCycle = async (): Promise<AppData> => {
        const currentChangeAt = useTaskStore.getState().lastDataChangeAt;
        if (localDataCache && localDataCache.changeAt === currentChangeAt) {
          localSnapshotChangeAt = currentChangeAt;
          return localDataCache.data;
        }
        const inMemorySnapshot = getInMemoryAppDataSnapshot();
        const baseData = preSyncedLocalData
          ? mergeAppData(preSyncedLocalData, inMemorySnapshot)
          : mergeAppData(await mergeLocalSyncStatus(await mobileStorage.getData()), inMemorySnapshot);
        const data = await injectExternalCalendars(baseData);
        localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
        localDataCache = {
          changeAt: localSnapshotChangeAt,
          data,
        };
        return data;
      };

      // Pre-sync local attachments only when attachment metadata shows real work.
      const attachmentPrepareStartedAt = Date.now();
      try {
        const localData = await readLocalDataForSyncCycle();
        const hasAttachmentWork = await hasPendingAttachmentSyncWork(localData);
        if (hasPendingSyncSideEffects(localData) || hasAttachmentWork) {
          startVisibleSyncActivity();
        }
        if (!hasAttachmentWork) {
          logSyncInfo('Attachment pre-sync skipped', {
            backend,
            reason: 'no-pending-work',
          });
          logSyncDiagnostic('Sync diagnostic attachment prepare skipped', attachmentPrepareStartedAt, {
            backend,
            ...buildSyncDataDiagnostics(localData),
          });
        } else {
          step = 'attachments_prepare';
          logSyncInfo('Sync step', { step });
          const preSyncResult = await runPreSyncAttachmentPhase({
            backend,
            cloudProvider,
            data: localData,
            ensureNetworkStillAvailable,
            webdav: webdavConfig?.url
              ? async (data) => {
                const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
                return syncWebdavAttachments(data, webdavConfig, baseSyncUrl, requestAbortController.signal);
              }
              : undefined,
            cloudkit: backend === 'cloudkit'
              ? async (data) => syncCloudKitAttachments(data, requestAbortController.signal)
              : undefined,
            selfHostedCloud: cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfig?.url
              ? async (data) => {
                const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
                return syncCloudAttachments(data, cloudConfig, baseSyncUrl, {
                  assertCurrent: ensureLocalSnapshotFresh,
                  signal: requestAbortController.signal,
                });
              }
              : undefined,
            dropbox: cloudProvider === CLOUD_PROVIDER_DROPBOX
              ? async (data) => syncDropboxAttachments(data, dropboxClientId, fetchWithAbort, {
                signal: requestAbortController.signal,
              })
              : undefined,
            file: fileSyncPath
              ? async (data) => syncFileAttachments(data, fileSyncPath, requestAbortController.signal)
              : undefined,
          });
          if (preSyncResult.mutated) {
            // Capture pre-sync attachment mutations before stale-snapshot checks so we can persist them on abort.
            preSyncedLocalData = preSyncResult.data ?? localData;
            localDataCache = null;
            ensureLocalSnapshotFresh();
          }
          logSyncInfo('Attachment pre-sync complete', {
            backend,
            mutated: preSyncResult.mutated ? 'true' : 'false',
          });
          logSyncDiagnostic('Sync diagnostic attachment prepare complete', attachmentPrepareStartedAt, {
            backend,
            mutated: preSyncResult.mutated ? 'true' : 'false',
            ...buildSyncDataDiagnostics(preSyncResult.data ?? localData),
          });
        }
      } catch (error) {
        if (error instanceof LocalSyncAbort) {
          throw error;
        }
        if (requestAbortController.signal.aborted) {
          throw error;
        }
        logSyncWarning('Attachment pre-sync warning; continuing sync merge', error);
      }

      const readRemoteDataByBackend = async (): Promise<AppData | null> => {
        if (readCheckRemoteData !== undefined) {
          const data = readCheckRemoteData;
          readCheckRemoteData = undefined;
          remoteDataForCompare = data;
          return data;
        }
        await ensureNetworkStillAvailable();
        if (backend === 'webdav' && webdavConfig?.url) {
          ensureWebdavSyncNotRateLimited();
          try {
            const data = await withRetry(
              () =>
                webdavGetJson<AppData>(webdavConfig.url, {
                  ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                  allowWeakFingerprint: webdavConfig.allowWeakFingerprint,
                }),
              WEBDAV_READ_RETRY_OPTIONS
            );
            webdavRemoteCorrupted = false;
            remoteDataForCompare = data ?? null;
            return data;
          } catch (error) {
            if (isWebdavInvalidJsonError(error)) {
              webdavRemoteCorrupted = true;
              remoteDataForCompare = null;
              logSyncWarning('WebDAV remote data.json appears corrupted; treating as missing for repair write', error);
              return null;
            }
            handleWebdavRateLimit(error);
            throw error;
          }
        }
        if (backend === 'cloud' && cloudConfig?.url) {
          const data = await cloudGetJson<AppData>(cloudConfig.url, {
            ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: fetchWithAbort,
          });
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          const { data, rev } = await runDropboxOperation((accessToken) =>
            downloadDropboxAppData(accessToken, fetchWithAbort)
          );
          dropboxLastRev = rev;
          if (rev) {
            await AsyncStorage.setItem(DROPBOX_LAST_REV_KEY, rev);
            syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: rev, readAt: Date.now() });
          } else {
            await AsyncStorage.removeItem(DROPBOX_LAST_REV_KEY);
            syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
          }
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (backend === 'cloudkit') {
          const data = await readRemoteCloudKit({ signal: requestAbortController.signal });
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (!fileSyncPath) {
          throw new Error('No sync folder configured');
        }
        const data = await readSyncFile(fileSyncPath, { bookmark: fileSyncBookmark });
        remoteDataForCompare = data ?? null;
        return data;
      };

      const prepareRemoteWriteData = async (data: AppData): Promise<AppData> => {
        const pendingUploads = findPendingAttachmentUploads(data);
        if (pendingUploads.length === 0) {
          return data;
        }

        step = 'attachments_finalize';
        logSyncInfo('Sync step', { step });
        logSyncInfo('Attachment final sync start', {
          backend,
          pending: String(pendingUploads.length),
        });

        if (backend === 'webdav' && webdavConfig?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
          await syncWebdavAttachments(data, webdavConfig, baseSyncUrl, requestAbortController.signal);
        } else if (backend === 'cloudkit') {
          await ensureNetworkStillAvailable();
          await syncCloudKitAttachments(data, requestAbortController.signal);
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfig?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
          await syncCloudAttachments(data, cloudConfig, baseSyncUrl, {
            assertCurrent: ensureLocalSnapshotFresh,
            signal: requestAbortController.signal,
          });
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          await ensureNetworkStillAvailable();
          await syncDropboxAttachments(data, dropboxClientId, fetchWithAbort, {
            signal: requestAbortController.signal,
          });
        } else if (backend === 'file' && fileSyncPath) {
          await syncFileAttachments(data, fileSyncPath, requestAbortController.signal);
        }

        const remainingUploads = findPendingAttachmentUploads(data);
        logSyncInfo('Attachment final sync done', {
          backend,
          pending: String(remainingUploads.length),
        });
        logPendingAttachmentUploads(
          'Attachment uploads still pending after final sync',
          backend,
          'attachments-finalize',
          remainingUploads
        );

        return data;
      };

      const writeRemoteDataByBackend = async (data: AppData): Promise<void> => {
        await ensureNetworkStillAvailable();
        lastRemoteWriteFingerprint = null;
        lastRemoteWriteMergedServerData = false;
        logPendingAttachmentUploads(
          'Remote write blocked by pending attachment uploads',
          backend,
          'remote-write',
          findPendingAttachmentUploads(data)
        );
        assertNoPendingAttachmentUploads(data);
        const sanitized = sanitizeAppDataForRemote(data);
        const remoteSanitized = remoteDataForCompare
          ? sanitizeAppDataForRemote(remoteDataForCompare)
          : null;
        if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
          return;
        }
        if (backend === 'webdav') {
          if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
          ensureWebdavSyncNotRateLimited();
          if (webdavRemoteCorrupted) {
            logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
          }
          let result: RemoteJsonWriteResult;
          try {
            result = await withRetry(
              () =>
                webdavPutJson(webdavConfig.url, sanitized, {
                  ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_RETRY_OPTIONS
            );
          } catch (error) {
            handleWebdavRateLimit(error);
            throw error;
          }
          const writeResult = normalizeRemoteWriteResult('webdav', result);
          lastRemoteWriteFingerprint = writeResult.fingerprint;
          remoteDataForCompare = sanitized;
          webdavRemoteCorrupted = false;
          return;
        }
        if (backend === 'cloud') {
          if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
            try {
              const result = await runDropboxOperation((accessToken) =>
                uploadDropboxAppData(accessToken, sanitized, dropboxLastRev, fetchWithAbort)
              );
              dropboxLastRev = result.rev;
              if (result.rev) {
                await AsyncStorage.setItem(DROPBOX_LAST_REV_KEY, result.rev);
                syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: result.rev, readAt: Date.now() });
              } else {
                await AsyncStorage.removeItem(DROPBOX_LAST_REV_KEY);
                syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
              }
              remoteDataForCompare = sanitized;
              return;
            } catch (error) {
              if (error instanceof DropboxConflictError) {
                // Another device wrote between readRemote and writeRemote; retry next cycle.
                requestFollowUp(syncPathOverride);
                throw new LocalSyncAbort();
              }
              throw error;
            }
          }
          if (!cloudConfig?.url) throw new Error('Self-hosted URL not configured');
          const result = await cloudPutJson(cloudConfig.url, sanitized, {
            ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: fetchWithAbort,
          });
          const writeResult = normalizeRemoteWriteResult('cloud', result);
          lastRemoteWriteFingerprint = writeResult.fingerprint;
          lastRemoteWriteMergedServerData = writeResult.serverMergedRemoteData;
          if (writeResult.serverMergedRemoteData) {
            remoteDataForCompare = null;
            requestFollowUp(syncPathOverride);
          } else {
            remoteDataForCompare = sanitized;
          }
          return;
        }
        if (backend === 'cloudkit') {
          await writeRemoteCloudKit(sanitized as AppData, { signal: requestAbortController.signal });
          remoteDataForCompare = sanitized;
          return;
        }
        if (!fileSyncPath) throw new Error('No sync folder configured');
        await writeSyncFile(fileSyncPath, sanitized, { bookmark: fileSyncBookmark });
        remoteDataForCompare = sanitized;
      };

      const readRemoteFingerprintForFastCheck = async (): Promise<string | null> => {
        await ensureNetworkStillAvailable();
        if (backend === 'webdav' && webdavConfig?.url) {
          ensureWebdavSyncNotRateLimited();
          try {
            const metadata = await withRetry(
              () =>
                webdavHeadFile(webdavConfig.url, {
                  ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_READ_RETRY_OPTIONS
            );
            if (!metadata?.exists) return null;
            return metadata.fingerprint;
          } catch (error) {
            handleWebdavRateLimit(error);
            throw error;
          }
        }
        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfig?.url) {
          const metadata = await cloudHeadJson(cloudConfig.url, {
            ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: fetchWithAbort,
          });
          if (!metadata?.exists) return null;
          return metadata.fingerprint;
        }
        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          const metadata = await runDropboxOperation((accessToken) =>
            getDropboxAppDataMetadata(accessToken, fetchWithAbort)
          );
          dropboxLastRev = metadata.rev;
          return metadata.rev ? `dropbox:v1:rev=${metadata.rev}` : null;
        }
        return null;
      };

      const fastSyncScope = buildFastSyncScope({
        backend,
        webdavConfig,
        cloudProvider,
        cloudConfig,
        dropboxClientId,
      });

      const recordFastSyncState = async (
        data: AppData,
        options: { allowRemoteFingerprintRead?: boolean } = {}
      ): Promise<void> => {
        if (!fastSyncScope || hasPendingSyncSideEffects(data)) return;
        if (useTaskStore.getState().lastDataChangeAt > localSnapshotChangeAt) return;
        if (lastRemoteWriteMergedServerData) return;
        let remoteFingerprint: string | null = null;
        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX && dropboxLastRev) {
          remoteFingerprint = `dropbox:v1:rev=${dropboxLastRev}`;
        } else if (lastRemoteWriteFingerprint) {
          remoteFingerprint = lastRemoteWriteFingerprint;
        } else {
          if (options.allowRemoteFingerprintRead === false) return;
          try {
            remoteFingerprint = await readRemoteFingerprintForFastCheck();
          } catch (error) {
            logSyncWarning('Failed to refresh sync fast-check state', error);
            return;
          }
        }
        if (!remoteFingerprint) return;
        await writeFastSyncState({
          scope: fastSyncScope,
          localFingerprint: computeSyncPayloadFingerprint(data),
          remoteFingerprint,
          checkedAt: new Date().toISOString(),
        });
      };

      const trySkipUnchangedFastSync = async (): Promise<MobileSyncResult | null> => {
        if (!fastSyncScope) return null;
        const fastCheckStartedAt = Date.now();
        step = 'fast-check';
        logSyncInfo('Sync step', { step });
        if (preSyncedLocalData) return null;
        const localDataForFastCheck = await readLocalDataForSyncCycle();
        ensureLocalSnapshotFresh();
        if (hasPendingSyncSideEffects(localDataForFastCheck)) return null;

        const localFingerprint = computeSyncPayloadFingerprint(localDataForFastCheck);
        const cached = await readFastSyncState(fastSyncScope);
        if (!cached || cached.localFingerprint !== localFingerprint) return null;

        let remoteFingerprint: string | null = null;
        try {
          remoteFingerprint = await readRemoteFingerprintForFastCheck();
        } catch (error) {
          logSyncWarning('Sync fast check failed; falling back to read-only comparison', error);
          return null;
        }
        if (!remoteFingerprint || remoteFingerprint !== cached.remoteFingerprint) return null;

        await writeFastSyncState({
          scope: fastSyncScope,
          localFingerprint,
          remoteFingerprint,
          checkedAt: new Date().toISOString(),
        });
        await applyLocalSyncStatus({
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: 'success',
          lastSyncError: undefined,
        });
        useTaskStore.getState().setError(null);
        logSyncInfo('Sync fast check found no changes', {
          backend,
          elapsedMs: getSyncDiagnosticElapsedMs(fastCheckStartedAt),
          ...buildSyncDataDiagnostics(localDataForFastCheck),
        });
        return { success: true, skipped: 'unchanged' };
      };

      const trySkipUnchangedReadSync = async (): Promise<MobileSyncResult | null> => {
        const readCheckStartedAt = Date.now();
        step = 'read-check';
        logSyncInfo('Sync step', { step });
        if (preSyncedLocalData) return null;
        const localDataForReadCheck = await readLocalDataForSyncCycle();
        ensureLocalSnapshotFresh();
        if (hasPendingSyncSideEffects(localDataForReadCheck)) return null;

        const remoteData = await readRemoteDataByBackend();
        ensureLocalSnapshotFresh();
        if (!remoteData) return null;
        readCheckRemoteData = remoteData;

        const localSanitized = sanitizeAppDataForRemote(localDataForReadCheck);
        const remoteSanitized = sanitizeAppDataForRemote(remoteData);
        if (!areSyncPayloadsEqual(remoteSanitized, localSanitized)) return null;

        await recordFastSyncState(localDataForReadCheck, { allowRemoteFingerprintRead: false });
        await applyLocalSyncStatus({
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: 'success',
          lastSyncError: undefined,
        });
        readCheckRemoteData = undefined;
        useTaskStore.getState().setError(null);
        logSyncInfo('Sync read check found no changes', {
          backend,
          elapsedMs: getSyncDiagnosticElapsedMs(readCheckStartedAt),
          ...buildSyncDataDiagnostics(localDataForReadCheck),
        });
        return { success: true, skipped: 'unchanged' };
      };

      const unchangedFastResult = await trySkipUnchangedFastSync();
      const unchangedResult = unchangedFastResult ?? await trySkipUnchangedReadSync();
      if (unchangedResult) {
        return unchangedResult;
      }

      startVisibleSyncActivity();
      const syncCycleStartedAt = Date.now();
      const syncResult = await performSyncCycle({
        readLocal: readLocalDataForSyncCycle,
        readRemote: readRemoteDataByBackend,
        writeLocal: async (data) => {
          ensureLocalSnapshotFresh();
          await mobileStorage.saveData(data);
          wroteLocal = true;
        },
        clearPendingRemoteWriteAfterLocalAbort: async (pendingAt) => {
          const current = getInMemoryAppDataSnapshot();
          if (current.settings.pendingRemoteWriteAt && current.settings.pendingRemoteWriteAt !== pendingAt) return;
          await mobileStorage.saveData({
            ...current,
            settings: {
              ...current.settings,
              pendingRemoteWriteAt: undefined,
              pendingRemoteWriteRetryAt: undefined,
              pendingRemoteWriteAttempts: undefined,
            },
          });
          wroteLocal = true;
        },
        flushPendingLocalBeforeRetryRead: flushPendingSave,
        prepareRemoteWrite: prepareRemoteWriteData,
        writeRemote: async (data) => {
          ensureLocalSnapshotFresh();
          await writeRemoteDataByBackend(data);
        },
        onStep: (next) => {
          step = next;
          logSyncInfo('Sync step', { step });
        },
        historyContext: {
          backend,
          type: 'merge',
        },
      });
      if (syncResult.status === 'skipped') {
        logSyncInfo('Sync skipped while pending remote write backoff is active', {
          backend,
          retryInMs: String(Math.ceil(syncResult.retryInMs)),
        });
        logSyncDiagnostic('Sync diagnostic skipped', syncCycleStartedAt, {
          backend,
          step,
          success: 'true',
          skipped: syncResult.skipped,
          retryInMs: String(Math.ceil(syncResult.retryInMs)),
          ...buildSyncDataDiagnostics(syncResult.data),
        });
        return { success: true, skipped: 'pendingRemoteWriteBackoff' };
      }
      logSyncDiagnostic('Sync diagnostic merge cycle complete', syncCycleStartedAt, {
        backend,
        status: syncResult.status,
        ...buildSyncDataDiagnostics(syncResult.data),
      });

      const stats = syncResult.stats;
      const mergeLog = buildMergeSummaryLog(stats, { clockSkewThresholdMs: CLOCK_SKEW_THRESHOLD_MS });
      if (mergeLog) {
        void logInfo(
          mergeLog.message,
          {
            scope: 'sync',
            extra: mergeLog.extra,
          }
        );
      }
      let mergedData = syncResult.data;
      let canRecordFastSyncState = true;
      const markFastSyncStateUnsafe = () => {
        canRecordFastSyncState = false;
      };
      ensureLocalSnapshotFresh();
      await persistExternalCalendars(mergedData);

      const webdavConfigValue = webdavConfig as MobileWebDavSyncConfig | null;
      const cloudConfigValue = cloudConfig as MobileCloudSyncConfig | null;
      const applyAttachmentSyncMutation = async (
        syncAttachments: (candidateData: AppData) => Promise<boolean>
      ): Promise<void> => {
        const attachmentSyncStartedAt = Date.now();
        const candidateData = cloneAppData(mergedData);
        const mutated = await syncAttachments(candidateData);
        logSyncDiagnostic('Sync diagnostic attachment sync complete', attachmentSyncStartedAt, {
          backend,
          mutated: mutated ? 'true' : 'false',
          ...buildSyncDataDiagnostics(candidateData),
        });
        if (!mutated) return;
        ensureLocalSnapshotFresh();
        mergedData = candidateData;
        markFastSyncStateUnsafe();
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      };

      if (await hasPendingAttachmentSyncWork(mergedData)) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        if (backend === 'webdav' && webdavConfigValue?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getBaseSyncUrl(webdavConfigValue.url);
          await applyAttachmentSyncMutation((candidateData) =>
            syncWebdavAttachments(candidateData, webdavConfigValue, baseSyncUrl, requestAbortController.signal)
          );
        }

        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfigValue?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getCloudBaseUrl(cloudConfigValue.url);
          await applyAttachmentSyncMutation((candidateData) =>
            syncCloudAttachments(candidateData, cloudConfigValue, baseSyncUrl, {
              assertCurrent: ensureLocalSnapshotFresh,
              signal: requestAbortController.signal,
            })
          );
        }

        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          await ensureNetworkStillAvailable();
          await applyAttachmentSyncMutation((candidateData) =>
            syncDropboxAttachments(candidateData, dropboxClientId, fetchWithAbort, {
              signal: requestAbortController.signal,
            })
          );
        }

        if (backend === 'file' && fileSyncPath) {
          await applyAttachmentSyncMutation((candidateData) =>
            syncFileAttachments(candidateData, fileSyncPath, requestAbortController.signal)
          );
        }
      } else {
        logSyncInfo('Attachment sync skipped', {
          backend,
          reason: 'no-pending-work',
        });
      }

      await cleanupAttachmentTempFiles();

      if (shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
        step = 'attachments_cleanup';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const cleanupResult = await runMobileAttachmentCleanup({
          appData: mergedData,
          backend,
          webdavConfig: webdavConfigValue,
          cloudConfig: cloudConfigValue,
          cloudProvider,
          fileSyncPath,
          fetcher: fetchWithAbort,
          ensureLocalSnapshotFresh,
          deleteDropboxAttachment: (cloudKey) =>
            runDropboxOperation((accessToken) => deleteDropboxFile(accessToken, cloudKey, fetchWithAbort)),
          isRemoteMissingError: (error) => error instanceof DropboxFileNotFoundError,
          logSyncInfo,
          logSyncWarning,
        });
        mergedData = cleanupResult.appData;
        if (cleanupResult.shouldInvalidateFastSyncState) {
          markFastSyncStateUnsafe();
        }
        ensureLocalSnapshotFresh();
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      }

      if (canRecordFastSyncState) {
        await recordFastSyncState(mergedData);
      }

      step = 'refresh';
      ensureLocalSnapshotFresh();
      await useTaskStore.getState().fetchData({ silent: true });
      logSyncDiagnostic('Sync diagnostic complete', syncDiagnosticStartedAt, {
        backend,
        step,
        status: syncResult.status,
        success: 'true',
        wroteLocal: String(wroteLocal),
        ...buildSyncDataDiagnostics(mergedData),
      });
      return { success: true, stats: syncResult.stats };
    } catch (error) {
      if (requestAbortController.signal.aborted && activeMobileSyncAbortReason === 'lifecycle') {
        logSyncInfo('Sync aborted by app lifecycle transition', { backend, step });
        logSyncDiagnostic('Sync diagnostic lifecycle abort', syncDiagnosticStartedAt, {
          backend,
          step,
          success: 'true',
          aborted: 'lifecycle',
        });
        requestFollowUp(syncPathOverride);
        return { success: true };
      }
      if (error instanceof LocalSyncAbort) {
        if (preSyncedLocalData && !wroteLocal) {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const reconciledData = mergeAppData(preSyncedLocalData, inMemorySnapshot);
          await mobileStorage.saveData(reconciledData);
          wroteLocal = true;
        }
        logSyncInfo('Sync requeued after local data changed', {
          backend,
          step,
          wroteLocal: String(wroteLocal),
        });
        logSyncDiagnostic('Sync diagnostic requeued', syncDiagnosticStartedAt, {
          backend,
          step,
          success: 'true',
          wroteLocal: String(wroteLocal),
        });
        return buildRequeuedSkipResult();
      }
      const likelyOfflineRequestError = isLikelyOfflineSyncError(error);
      if (isRemoteSyncBackend(backend) && (networkWentOffline || likelyOfflineRequestError)) {
        if (!offlineDetectionCause && likelyOfflineRequestError) {
          offlineDetectionCause = 'request-error';
        }
        if (preSyncedLocalData && !wroteLocal) {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const reconciledData = mergeAppData(preSyncedLocalData, inMemorySnapshot);
          await mobileStorage.saveData(reconciledData);
          wroteLocal = true;
        }
        if (wroteLocal) {
          try {
            await useTaskStore.getState().fetchData({ silent: true });
          } catch (fetchError) {
            logSyncWarning('[Mobile] Failed to refresh store after offline sync skip', fetchError);
          }
        }
        logSyncInfo('Sync skipped after offline detection', {
          backend,
          step,
          reason: offlineDetectionCause ?? 'unknown',
          ...(lastOfflineNetworkStatus ? formatNetworkStatusForLog(lastOfflineNetworkStatus) : {}),
        });
        logSyncDiagnostic('Sync diagnostic offline skip', syncDiagnosticStartedAt, {
          backend,
          step,
          success: 'true',
          skipped: 'offline',
          reason: offlineDetectionCause ?? 'unknown',
        });
        return buildOfflineSkipResult();
      }
      const now = new Date().toISOString();
      const logPath = await logSyncError(error, { backend, step, url: syncUrl });
      const logHint = logPath ? ` (log: ${logPath})` : '';
      const safeMessage = formatSyncErrorMessage(error, backend);
      logSyncDiagnostic('Sync diagnostic error', syncDiagnosticStartedAt, {
        backend,
        step,
        success: 'false',
        error: safeMessage,
      });
      const nextHistory = appendSyncHistory(useTaskStore.getState().settings, {
        at: now,
        status: 'error',
        backend,
        type: 'merge',
        conflicts: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        timestampAdjustments: 0,
        details: step,
        error: `${safeMessage}${logHint}`,
      });
      try {
        if (wroteLocal) {
          await useTaskStore.getState().fetchData({ silent: true });
        }
        await applyLocalSyncStatus({
          lastSyncAt: now,
          lastSyncStatus: 'error',
          lastSyncError: `${safeMessage}${logHint}`,
          lastSyncStats: undefined,
          lastSyncHistory: nextHistory,
        });
      } catch (e) {
        logSyncWarning('[Mobile] Failed to persist sync error', e);
      }

      return { success: false, error: `${safeMessage}${logHint}` };
    } finally {
      if (activeMobileSyncAbortController === requestAbortController) {
        activeMobileSyncAbortController = null;
        activeMobileSyncAbortReason = null;
      }
      try {
        networkSubscription?.remove?.();
      } catch (error) {
        logSyncWarning('Failed to unsubscribe network listener after sync', error);
      }
    }
  },
  onQueuedRunComplete: (queuedResult) => {
    if (!queuedResult.success) {
      logSyncWarning('[Mobile] Queued sync failed', queuedResult.error);
    }
  },
  onQueuedRunError: (error) => {
    logSyncWarning('[Mobile] Queued sync crashed', error);
  },
  onDrained: () => {
    setMobileSyncActivityState('idle');
  },
});

export async function performMobileSync(syncPathOverride?: string): Promise<MobileSyncResult> {
  return mobileSyncOrchestrator.run(syncPathOverride);
}

export function abortMobileSync(): boolean {
  if (!activeMobileSyncAbortController) return false;
  activeMobileSyncAbortReason = 'lifecycle';
  activeMobileSyncAbortController.abort();
  return true;
}

export const __mobileSyncTestUtils = {
  reset() {
    mobileSyncOrchestrator.reset();
    clearMobileSyncConfigCache();
    mobileSyncActivityListeners.clear();
    mobileSyncActivityState = 'idle';
    webdavSyncRateLimitController.reset();
    activeMobileSyncAbortController = null;
    activeMobileSyncAbortReason = null;
  },
  getWebdavSyncBlockedUntil() {
    return webdavSyncRateLimitController.getBlockedUntil();
  },
};
