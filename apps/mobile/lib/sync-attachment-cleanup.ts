import {
  AppData,
  Attachment,
  applyAttachmentCleanupResult,
  findDeletedAttachmentsForFileCleanup,
  findLiveAttachmentResourceReferences,
  findOrphanedAttachments,
  getErrorStatus,
  isAttachmentCloudResourceReferenced,
  isAttachmentLocalResourceReferenced,
  sanitizeAttachmentCloudKeyForSyncMerge,
  sanitizeAttachmentUriForSyncMerge,
  webdavDeleteFile,
  cloudDeleteFile,
  decodeUriSafe,
  type CloudProvider,
  type PendingRemoteAttachmentDelete,
} from '@mindwtr/core';
import { getBaseSyncUrl, getCloudBaseUrl } from './attachment-sync';
import { ATTACHMENTS_DIR_NAME } from './attachment-sync-utils';
import * as FileSystem from './file-system';
import { getFileSyncBaseDir, type SyncBackend } from './sync-service-utils';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';

const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;

type MobileWebDavCleanupConfig = {
  url: string;
  username: string;
  password: string;
  allowInsecureHttp?: boolean;
};

type MobileCloudCleanupConfig = {
  url: string;
  token: string;
  allowInsecureHttp?: boolean;
};

type MobileAttachmentCleanupOptions = {
  appData: AppData;
  backend: SyncBackend;
  webdavConfig: MobileWebDavCleanupConfig | null;
  cloudConfig: MobileCloudCleanupConfig | null;
  cloudProvider: CloudProvider;
  fileSyncPath: string | null;
  fetcher: typeof fetch;
  ensureLocalSnapshotFresh: () => void;
  deleteDropboxAttachment: (cloudKey: string) => Promise<void>;
  isRemoteMissingError: (error: unknown) => boolean;
  logSyncInfo: (message: string, extra?: Record<string, string>) => void;
  logSyncWarning: (message: string, error?: unknown) => void;
};

type MobileAttachmentCleanupResult = {
  appData: AppData;
  shouldInvalidateFastSyncState: boolean;
};

const getManagedAttachmentCleanupPrefixes = (): string[] => {
  return [FileSystem.documentDirectory, FileSystem.cacheDirectory]
    .filter((base): base is string => typeof base === 'string' && base.length > 0)
    .map((base) => {
      const normalized = base.endsWith('/') ? base : `${base}/`;
      return `${normalized}${ATTACHMENTS_DIR_NAME}/`;
    });
};

const deleteAttachmentFile = async (
  uri: string | undefined,
  logSyncWarning: MobileAttachmentCleanupOptions['logSyncWarning']
): Promise<void> => {
  const safeUri = sanitizeAttachmentUriForSyncMerge(uri);
  if (!safeUri) return;
  if (safeUri.startsWith('content://') || /^https?:\/\//i.test(safeUri)) return;
  const decodedUri = decodeUriSafe(safeUri);
  const managedPrefixes = getManagedAttachmentCleanupPrefixes();
  if (!managedPrefixes.some((prefix) => safeUri.startsWith(prefix) || decodedUri.startsWith(prefix))) {
    return;
  }
  try {
    await FileSystem.deleteAsync(safeUri, { idempotent: true });
  } catch (error) {
    logSyncWarning('Failed to delete attachment file', error);
  }
};

export const runMobileAttachmentCleanup = async (
  options: MobileAttachmentCleanupOptions
): Promise<MobileAttachmentCleanupResult> => {
  const orphaned = findOrphanedAttachments(options.appData);
  const deletedAttachments = findDeletedAttachmentsForFileCleanup(options.appData);
  const cleanupTargets = new Map<string, Attachment>();
  for (const attachment of orphaned) cleanupTargets.set(attachment.id, attachment);
  for (const attachment of deletedAttachments) cleanupTargets.set(attachment.id, attachment);

  const previousPendingRemoteDeletes = options.appData.settings.attachments?.pendingRemoteDeletes ?? [];
  const liveResourceReferences = findLiveAttachmentResourceReferences(options.appData);
  const lastCleanupAt = new Date().toISOString();
  let reachedBatchLimit = false;
  let processedOrphanedIds = new Set<string>();
  let pendingRemoteDeletes: PendingRemoteAttachmentDelete[] = [];

  if (cleanupTargets.size > 0 || previousPendingRemoteDeletes.length > 0) {
    const isFileBackend = options.backend === 'file';
    const isWebdavBackend = options.backend === 'webdav' && options.webdavConfig?.url;
    const isCloudBackend = options.backend === 'cloud'
      && options.cloudProvider === 'selfhosted'
      && options.cloudConfig?.url;
    const isDropboxBackend = options.backend === 'cloud'
      && options.cloudProvider === 'dropbox';
    const fileBaseDir = isFileBackend && options.fileSyncPath && !options.fileSyncPath.startsWith('content://')
      ? getFileSyncBaseDir(options.fileSyncPath)
      : null;
    let processedCount = 0;
    reachedBatchLimit = cleanupTargets.size > ATTACHMENT_CLEANUP_BATCH_LIMIT;
    const orphanedIds = new Set(orphaned.map((attachment) => attachment.id));
    processedOrphanedIds = new Set<string>();
    const previousPendingByCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const entry of previousPendingRemoteDeletes) {
      const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(entry.cloudKey);
      if (!cloudKey) continue;
      previousPendingByCloudKey.set(cloudKey, { ...entry, cloudKey });
    }
    const remoteCleanupTargets = new Map<string, { cloudKey: string; title: string }>();
    const nextPendingRemoteDeletesByCloudKey = new Map<string, PendingRemoteAttachmentDelete>();

    for (const pending of previousPendingRemoteDeletes) {
      const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(pending.cloudKey);
      if (!cloudKey) continue;
      if (isAttachmentCloudResourceReferenced({ cloudKey }, liveResourceReferences)) {
        continue;
      }
      remoteCleanupTargets.set(cloudKey, {
        cloudKey,
        title: pending.title || cloudKey,
      });
    }

    for (const attachment of cleanupTargets.values()) {
      if (processedCount >= ATTACHMENT_CLEANUP_BATCH_LIMIT) {
        break;
      }
      processedCount += 1;
      if (orphanedIds.has(attachment.id)) {
        processedOrphanedIds.add(attachment.id);
      }
      options.ensureLocalSnapshotFresh();
      if (!isAttachmentLocalResourceReferenced(attachment, liveResourceReferences)) {
        await deleteAttachmentFile(attachment.uri, options.logSyncWarning);
      }
      const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(attachment.cloudKey);
      if (cloudKey && !isAttachmentCloudResourceReferenced({ cloudKey }, liveResourceReferences)) {
        remoteCleanupTargets.set(cloudKey, {
          cloudKey,
          title: attachment.title || cloudKey,
        });
      }
    }

    const canAttemptRemoteDelete = Boolean(
      (isWebdavBackend && options.webdavConfig)
      || (isCloudBackend && options.cloudConfig)
      || isDropboxBackend
      || fileBaseDir
    );
    for (const target of remoteCleanupTargets.values()) {
      const previous = previousPendingByCloudKey.get(target.cloudKey);
      if (!canAttemptRemoteDelete) {
        nextPendingRemoteDeletesByCloudKey.set(target.cloudKey, {
          cloudKey: target.cloudKey,
          title: target.title,
          attempts: previous?.attempts ?? 0,
          lastErrorAt: previous?.lastErrorAt,
        });
        continue;
      }
      try {
        if (isWebdavBackend && options.webdavConfig) {
          const baseSyncUrl = getBaseSyncUrl(options.webdavConfig.url);
          await webdavDeleteFile(`${baseSyncUrl}/${target.cloudKey}`, {
            ...getMobileWebDavRequestOptions(options.webdavConfig.allowInsecureHttp),
            username: options.webdavConfig.username,
            password: options.webdavConfig.password,
            timeoutMs: 30_000,
            fetcher: options.fetcher,
          });
        } else if (isCloudBackend && options.cloudConfig) {
          const baseSyncUrl = getCloudBaseUrl(options.cloudConfig.url);
          await cloudDeleteFile(`${baseSyncUrl}/${target.cloudKey}`, {
            ...getMobileCloudRequestOptions(options.cloudConfig.allowInsecureHttp),
            token: options.cloudConfig.token,
            timeoutMs: 30_000,
            fetcher: options.fetcher,
          });
        } else if (isDropboxBackend) {
          await options.deleteDropboxAttachment(target.cloudKey);
        } else if (fileBaseDir) {
          const targetPath = `${fileBaseDir}/${target.cloudKey}`;
          await FileSystem.deleteAsync(targetPath, { idempotent: true });
        }
      } catch (error) {
        const status = getErrorStatus(error);
        if (status === 404 || options.isRemoteMissingError(error)) {
          options.logSyncInfo('Remote attachment already missing during cleanup', {
            cloudKey: target.cloudKey,
          });
          continue;
        }
        options.logSyncWarning('Failed to delete remote attachment', error);
        nextPendingRemoteDeletesByCloudKey.set(target.cloudKey, {
          cloudKey: target.cloudKey,
          title: target.title,
          attempts: (previous?.attempts ?? 0) + 1,
          lastErrorAt: lastCleanupAt,
        });
      }
    }
    if (reachedBatchLimit) {
      options.logSyncInfo('Attachment cleanup batch limit reached', {
        limit: String(ATTACHMENT_CLEANUP_BATCH_LIMIT),
        total: String(cleanupTargets.size),
      });
    }
    pendingRemoteDeletes = Array.from(nextPendingRemoteDeletesByCloudKey.values());
  }

  return {
    appData: applyAttachmentCleanupResult(options.appData, {
      lastCleanupAt,
      orphanedAttachments: orphaned,
      pendingRemoteDeletes,
      processedOrphanedIds,
      reachedBatchLimit,
    }),
    shouldInvalidateFastSyncState: orphaned.length > 0 && (!reachedBatchLimit || processedOrphanedIds.size > 0),
  };
};
