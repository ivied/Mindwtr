import type { AppData, Attachment } from '@mindwtr/core';
import { buildCloudKitAttachmentKey, parseCloudKitAttachmentKey, validateAttachmentForUpload } from '@mindwtr/core';
import {
    deleteCloudKitAttachmentAssets,
    fetchCloudKitAttachmentAsset,
    saveCloudKitAttachmentAsset,
    type CloudKitAttachmentMetadata,
} from '../cloudkit-sync';
import {
    collectAttachments,
    createAttachmentLocalMigrationLimiter,
    extractExtension,
    fileExists,
    getAttachmentByteSize,
    getAttachmentLocalStatus,
    getAttachmentsDir,
    isContentAttachmentUri,
    isHttpAttachmentUri,
    logAttachmentWarn,
    readAttachmentBytesForUpload,
    readFileAsBytes,
    reportProgress,
    validateAttachmentHash,
    writeBytesSafely,
} from '../attachment-sync-utils';
import { assertAttachmentSyncNotAborted, isAttachmentSyncAbortError } from './common';

type OwnedAttachment = {
    ownerType: 'task' | 'project';
    ownerId: string;
    attachment: Attachment;
};

const collectOwnedAttachments = (appData: AppData): OwnedAttachment[] => {
    const owned: OwnedAttachment[] = [];
    for (const task of appData.tasks) {
        if (task.deletedAt) continue;
        for (const attachment of task.attachments ?? []) {
            owned.push({ ownerType: 'task', ownerId: task.id, attachment });
        }
    }
    for (const project of appData.projects) {
        if (project.deletedAt) continue;
        for (const attachment of project.attachments ?? []) {
            owned.push({ ownerType: 'project', ownerId: project.id, attachment });
        }
    }
    return owned;
};

const buildTargetUri = (attachmentsDir: string, attachment: Attachment): string => {
    const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
    return `${attachmentsDir}${attachment.id}${ext}`;
};

const ensureCloudKitAssetFile = async (
    attachment: Attachment,
    uri: string,
    attachmentsDir: string,
    signal?: AbortSignal,
): Promise<{ uri: string; size: number | null; mutated: boolean }> => {
    if (!isContentAttachmentUri(uri)) {
        return {
            uri,
            size: await getAttachmentByteSize(attachment, uri),
            mutated: false,
        };
    }

    assertAttachmentSyncNotAborted(signal);
    const result = await readAttachmentBytesForUpload(uri);
    if (result.readFailed) throw result.error;

    const targetUri = buildTargetUri(attachmentsDir, attachment);
    await writeBytesSafely(targetUri, result.data);
    attachment.uri = targetUri;
    attachment.size = result.data.byteLength;
    attachment.localStatus = 'available';
    return { uri: targetUri, size: result.data.byteLength, mutated: true };
};

const buildMetadata = (owned: OwnedAttachment, fileSize: number | null): CloudKitAttachmentMetadata => ({
    attachmentId: owned.attachment.id,
    ownerType: owned.ownerType,
    ownerId: owned.ownerId,
    title: owned.attachment.title,
    ...(owned.attachment.mimeType ? { mimeType: owned.attachment.mimeType } : {}),
    ...(Number.isFinite(fileSize ?? NaN) ? { size: fileSize as number } : {}),
    ...(owned.attachment.fileHash ? { fileHash: owned.attachment.fileHash } : {}),
    updatedAt: owned.attachment.updatedAt,
    ...(owned.attachment.deletedAt ? { deletedAt: owned.attachment.deletedAt } : {}),
});

const applyFetchedMetadata = (attachment: Attachment, metadata: CloudKitAttachmentMetadata): boolean => {
    let mutated = false;
    if (metadata.title && attachment.title !== metadata.title) {
        attachment.title = metadata.title;
        mutated = true;
    }
    if (metadata.mimeType && attachment.mimeType !== metadata.mimeType) {
        attachment.mimeType = metadata.mimeType;
        mutated = true;
    }
    if (Number.isFinite(metadata.size ?? NaN) && attachment.size !== metadata.size) {
        attachment.size = metadata.size;
        mutated = true;
    }
    if (metadata.fileHash && attachment.fileHash !== metadata.fileHash) {
        attachment.fileHash = metadata.fileHash;
        mutated = true;
    }
    return mutated;
};

const flushPendingCloudKitDeletes = async (appData: AppData, signal?: AbortSignal): Promise<boolean> => {
    const pendingDeletes = appData.settings.attachments?.pendingRemoteDeletes ?? [];
    const recordNames: string[] = [];
    const remaining = [];

    for (const pending of pendingDeletes) {
        const recordName = parseCloudKitAttachmentKey(pending.cloudKey);
        if (recordName) recordNames.push(recordName);
        else remaining.push(pending);
    }

    if (recordNames.length === 0) return false;
    assertAttachmentSyncNotAborted(signal);
    await deleteCloudKitAttachmentAssets(recordNames, { signal });

    appData.settings.attachments = {
        ...(appData.settings.attachments ?? {}),
        pendingRemoteDeletes: remaining.length > 0 ? remaining : undefined,
    };
    return true;
};

export const syncCloudKitAttachments = async (appData: AppData, signal?: AbortSignal): Promise<boolean> => {
    assertAttachmentSyncNotAborted(signal);
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return false;

    let didMutate = await flushPendingCloudKitDeletes(appData, signal);
    const attachmentsById = collectAttachments(appData);
    if (attachmentsById.size === 0) return didMutate;
    const migrateAttachmentLocally = createAttachmentLocalMigrationLimiter();

    for (const owned of collectOwnedAttachments(appData)) {
        const attachment = owned.attachment;
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
        const hasLocalPath = Boolean(uri) && !isHttp;
        const existsLocally = hasLocalPath ? await fileExists(uri) : false;
        const localStatus = getAttachmentLocalStatus(uri, existsLocally);
        if (attachment.localStatus !== localStatus) {
            attachment.localStatus = localStatus;
            didMutate = true;
        }

        const recordName = parseCloudKitAttachmentKey(attachment.cloudKey);

        if (!recordName && hasLocalPath && localStatus === 'available') {
            try {
                const assetFile = await ensureCloudKitAssetFile(attachment, uri, attachmentsDir, signal);
                didMutate = assetFile.mutated || didMutate;
                const validation = await validateAttachmentForUpload(attachment, assetFile.size ?? attachment.size);
                if (!validation.valid) {
                    reportProgress(attachment.id, 'upload', 0, attachment.size ?? 0, 'failed', validation.error);
                    logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.title}`);
                    continue;
                }

                const totalBytes = Math.max(0, Number(assetFile.size ?? attachment.size ?? 0));
                reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
                await saveCloudKitAttachmentAsset(attachment.id, assetFile.uri, buildMetadata(owned, assetFile.size), {
                    signal,
                });
                attachment.cloudKey = buildCloudKitAttachmentKey(attachment.id);
                attachment.localStatus = 'available';
                if (Number.isFinite(assetFile.size ?? NaN)) attachment.size = assetFile.size ?? undefined;
                didMutate = true;
                reportProgress(attachment.id, 'upload', totalBytes, totalBytes, 'completed');
            } catch (error) {
                if (isAttachmentSyncAbortError(error, signal)) throw error;
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? 0,
                    'failed',
                    error instanceof Error ? error.message : String(error),
                );
                logAttachmentWarn(`Failed to upload CloudKit attachment ${attachment.title}`, error);
            }
        }

        const nextRecordName = parseCloudKitAttachmentKey(attachment.cloudKey);
        if (nextRecordName && (!hasLocalPath || attachment.localStatus === 'missing')) {
            try {
                const targetUri = buildTargetUri(attachmentsDir, attachment);
                reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
                const metadata = await fetchCloudKitAttachmentAsset(nextRecordName, targetUri, { signal });
                const bytes = await readFileAsBytes(targetUri);
                await validateAttachmentHash(attachment, bytes);
                attachment.uri = targetUri;
                attachment.localStatus = 'available';
                applyFetchedMetadata(attachment, metadata);
                didMutate = true;
                reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            } catch (error) {
                if (isAttachmentSyncAbortError(error, signal)) throw error;
                reportProgress(
                    attachment.id,
                    'download',
                    0,
                    attachment.size ?? 0,
                    'failed',
                    error instanceof Error ? error.message : String(error),
                );
                logAttachmentWarn(`Failed to download CloudKit attachment ${attachment.title}`, error);
            }
        }
    }

    return didMutate;
};
