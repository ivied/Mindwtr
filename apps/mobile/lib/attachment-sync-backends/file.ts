import type { AppData } from '@mindwtr/core';
import { validateAttachmentForUpload } from '@mindwtr/core';
import * as FileSystem from '../file-system';
import {
  buildCloudKey,
  bytesToBase64,
  collectAttachments,
  copyFileSafely,
  createAttachmentLocalMigrationLimiter,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  FILE_BACKEND_VALIDATION_CONFIG,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentWarn,
  readSafDirectoryEntriesByName,
  readFileAsBytes,
  resolveFileSyncDir,
  StorageAccessFramework,
  writeBytesSafely,
} from '../attachment-sync-utils';
import { assertAttachmentSyncNotAborted, isAttachmentSyncAbortError } from './common';

export const syncFileAttachments = async (
  appData: AppData,
  syncPath: string,
  signal?: AbortSignal
): Promise<boolean> => {
  assertAttachmentSyncNotAborted(signal);
  const syncDir = await resolveFileSyncDir(syncPath);
  if (!syncDir) return false;

  assertAttachmentSyncNotAborted(signal);
  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return false;

  const attachmentsById = collectAttachments(appData);
  const migrateAttachmentLocally = createAttachmentLocalMigrationLimiter();
  let safEntriesByName: Map<string, string> | null = null;
  const getSafEntriesByName = async (): Promise<Map<string, string>> => {
    if (!safEntriesByName) {
      safEntriesByName = await readSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
    }
    return safEntriesByName;
  };

  let didMutate = false;
  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;
    assertAttachmentSyncNotAborted(signal);
    const localMigration = await migrateAttachmentLocally(attachment);
    if (localMigration.migrated) {
      didMutate = true;
    }
    if (localMigration.skipped) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocal = Boolean(uri) && !isHttp;
    const existsLocally = hasLocal ? await fileExists(uri) : false;
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      didMutate = true;
    }

    if (hasLocal && existsLocally && !isHttp) {
      const cloudKey = attachment.cloudKey || buildCloudKey(attachment);
      const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
      let remoteExists = false;
      if (syncDir.type === 'file') {
        const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
        remoteExists = await fileExists(targetUri);
      } else {
        const safEntries = await getSafEntriesByName();
        remoteExists = safEntries.has(filename);
      }
      if (!remoteExists) {
        try {
          assertAttachmentSyncNotAborted(signal);
          const size = await getAttachmentByteSize(attachment, uri);
          if (size != null) {
            const validation = await validateAttachmentForUpload(attachment, size, FILE_BACKEND_VALIDATION_CONFIG);
            if (!validation.valid) {
              logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.title}`);
              continue;
            }
          }
          if (syncDir.type === 'file') {
            const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
            if (isContentAttachmentUri(uri)) {
              const bytes = await readFileAsBytes(uri);
              assertAttachmentSyncNotAborted(signal);
              await writeBytesSafely(targetUri, bytes);
            } else {
              assertAttachmentSyncNotAborted(signal);
              await copyFileSafely(uri, targetUri);
            }
          } else {
            const base64 = await readFileAsBytes(uri).then(bytesToBase64);
            assertAttachmentSyncNotAborted(signal);
            const safEntries = await getSafEntriesByName();
            let targetUri = safEntries.get(filename) ?? null;
            if (!targetUri && StorageAccessFramework?.createFileAsync) {
              assertAttachmentSyncNotAborted(signal);
              targetUri = await StorageAccessFramework.createFileAsync(syncDir.attachmentsDirUri, filename, attachment.mimeType || DEFAULT_CONTENT_TYPE);
              if (targetUri) {
                safEntries.set(filename, targetUri);
              }
            }
            if (targetUri && StorageAccessFramework?.writeAsStringAsync) {
              assertAttachmentSyncNotAborted(signal);
              await StorageAccessFramework.writeAsStringAsync(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
            }
          }
        } catch (error) {
          if (isAttachmentSyncAbortError(error, signal)) throw error;
          logAttachmentWarn(`Failed to copy attachment ${attachment.title} to sync folder`, error);
          continue;
        }
      }
      if (!attachment.cloudKey) {
        attachment.cloudKey = cloudKey;
        attachment.localStatus = 'available';
        didMutate = true;
      }
    }
  }

  return didMutate;
};
