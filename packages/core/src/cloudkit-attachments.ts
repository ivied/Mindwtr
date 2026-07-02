export const CLOUDKIT_ATTACHMENT_RECORD_TYPE = 'MindwtrAttachment';
export const CLOUDKIT_ATTACHMENT_ASSET_FIELD = 'asset';
export const CLOUDKIT_ATTACHMENT_KEY_PREFIX = 'cloudkit:';

export const buildCloudKitAttachmentKey = (attachmentId: string): string =>
    `${CLOUDKIT_ATTACHMENT_KEY_PREFIX}${attachmentId}`;

export const parseCloudKitAttachmentKey = (cloudKey: string | undefined): string | null => {
    if (!cloudKey?.startsWith(CLOUDKIT_ATTACHMENT_KEY_PREFIX)) return null;
    const recordName = cloudKey.slice(CLOUDKIT_ATTACHMENT_KEY_PREFIX.length).trim();
    return recordName || null;
};
