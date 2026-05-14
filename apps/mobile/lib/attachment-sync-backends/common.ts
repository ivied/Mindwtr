import * as FileSystem from '../file-system';
import { bytesToBase64, DEFAULT_CONTENT_TYPE } from '../attachment-sync-utils';

const encodeBase64Utf8 = (value: string): string => {
  const Encoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
  if (Encoder) {
    return bytesToBase64(new Encoder().encode(value));
  }
  try {
    const encoded = encodeURIComponent(value);
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i += 1) {
      const ch = encoded[i];
      if (ch === '%') {
        const hex = encoded.slice(i + 1, i + 3);
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0));
      }
    }
    return bytesToBase64(new Uint8Array(bytes));
  } catch {
    const bytes = new Uint8Array(value.split('').map((ch) => ch.charCodeAt(0) & 0xff));
    return bytesToBase64(bytes);
  }
};

const buildBasicAuthHeader = (username?: string, password?: string): string | null => {
  if (!username && !password) return null;
  return `Basic ${encodeBase64Utf8(`${username || ''}:${password || ''}`)}`;
};

const buildBearerAuthHeader = (token?: string): string | null => {
  if (!token) return null;
  return `Bearer ${token}`;
};

const resolveUploadType = (): any => {
  const types = (FileSystem as any).FileSystemUploadType;
  return types?.BINARY_CONTENT ?? types?.BINARY ?? undefined;
};

export const createAttachmentAbortError = (
  message = 'Attachment sync aborted',
  signal?: AbortSignal
): Error => {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason.trim() ? reason : message);
  error.name = 'AbortError';
  return error;
};

const createUploadAbortError = (signal?: AbortSignal): Error =>
  createAttachmentAbortError('Attachment upload aborted', signal);

export const assertAttachmentSyncNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createAttachmentAbortError('Attachment sync aborted', signal);
};

export const isAttachmentSyncAbortError = (error: unknown, signal?: AbortSignal): boolean => (
  Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
);

export const waitForAttachmentSyncDelay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  assertAttachmentSyncNotAborted(signal);
  if (ms <= 0) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAttachmentAbortError('Attachment sync aborted', signal));
    };
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const assertUploadNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createUploadAbortError(signal);
};

const cancelUploadTask = async (task: unknown): Promise<void> => {
  const cancelAsync = (task as { cancelAsync?: unknown } | null)?.cancelAsync;
  if (typeof cancelAsync !== 'function') return;
  await cancelAsync.call(task);
};

const runUploadTask = async <T,>(task: { uploadAsync: () => Promise<T> }, signal?: AbortSignal): Promise<T> => {
  assertUploadNotAborted(signal);
  if (!signal) {
    return task.uploadAsync();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    onAbort = () => {
      void cancelUploadTask(task).catch(() => undefined);
      finish(() => reject(createUploadAbortError(signal)));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    task.uploadAsync().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error))
    );
  });
};

export const uploadWebdavFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  username: string,
  password: string,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number,
  signal?: AbortSignal
): Promise<boolean> => {
  assertUploadNotAborted(signal);
  const uploadAsync = (FileSystem as any).uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBasicAuthHeader(username, password);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;

  const uploadType = resolveUploadType();
  const createUploadTask = (FileSystem as any).createUploadTask;
  if (typeof createUploadTask === 'function' && (onProgress || signal)) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        if (!onProgress) return;
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await runUploadTask(task, signal);
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`WebDAV File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  if (signal) return false;

  const result = await uploadAsync(url, fileUri, { httpMethod: 'PUT', headers, uploadType });
  const status = Number((result as { status?: number } | null)?.status ?? 0);
  if (status && (status < 200 || status >= 300)) {
    const error = new Error(`WebDAV File PUT failed (${status})`);
    (error as { status?: number }).status = status;
    throw error;
  }
  if (onProgress && Number.isFinite(totalBytes ?? NaN) && (totalBytes ?? 0) > 0) {
    onProgress(totalBytes ?? 0, totalBytes ?? 0);
  }
  return true;
};

export const uploadCloudFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  token: string,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number,
  signal?: AbortSignal
): Promise<boolean> => {
  assertUploadNotAborted(signal);
  const uploadAsync = (FileSystem as any).uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBearerAuthHeader(token);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;

  const uploadType = resolveUploadType();
  const createUploadTask = (FileSystem as any).createUploadTask;
  if (typeof createUploadTask === 'function' && (onProgress || signal)) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        if (!onProgress) return;
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await runUploadTask(task, signal);
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`Cloud File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  if (signal) return false;

  const result = await uploadAsync(url, fileUri, { httpMethod: 'PUT', headers, uploadType });
  const status = Number((result as { status?: number } | null)?.status ?? 0);
  if (status && (status < 200 || status >= 300)) {
    const error = new Error(`Cloud File PUT failed (${status})`);
    (error as { status?: number }).status = status;
    throw error;
  }
  if (onProgress && Number.isFinite(totalBytes ?? NaN) && (totalBytes ?? 0) > 0) {
    onProgress(totalBytes ?? 0, totalBytes ?? 0);
  }
  return true;
};
