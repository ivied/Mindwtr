/**
 * Screenshots for a reply to an agent: read a pasted or picked image, shrink
 * it if it is large, and hand back base64 for the JSON request.
 */
import type { ReplyImage } from '../../lib/agent-runs-client';

export const MAX_REPLY_IMAGES = 6;
/** Larger images are re-encoded; the server refuses anything above 8 MB. */
const KEEP_AS_IS_BYTES = 1_500_000;
const MAX_SIDE_PX = 2200;
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface PickedImage extends ReplyImage {
    /** Object URL for the thumbnail; revoke it when the image is dropped. */
    preview: string;
}

/** Image files in a paste or drop, in order. */
export function imageFiles(items: DataTransfer | null): File[] {
    if (!items) return [];
    return Array.from(items.files).filter((f) => f.type.startsWith('image/'));
}

/** Target size that fits within `maxSide` without upscaling. */
export function fitWithin(width: number, height: number, maxSide = MAX_SIDE_PX): { width: number; height: number } {
    const scale = Math.min(1, maxSide / Math.max(width, height, 1));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(blob);
    });

async function shrink(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.88),
    );
}

export async function prepareImage(file: File): Promise<PickedImage> {
    const keep = ACCEPTED.has(file.type) && file.size <= KEEP_AS_IS_BYTES;
    const blob = keep ? file : await shrink(file);
    return {
        name: file.name || 'screenshot',
        mime: keep ? file.type : 'image/jpeg',
        data: await toBase64(blob),
        preview: URL.createObjectURL(blob),
    };
}
