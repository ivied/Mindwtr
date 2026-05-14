import {
    DEFAULT_TIMEOUT_MS,
    assertConnectionAllowed,
    concatChunks,
    createProgressStream,
    fetchWithTimeout,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    toArrayBuffer,
    toUint8Array,
} from './http-utils';
import { buildHttpRemoteFileFingerprint, type RemoteFileMetadata } from './webdav';

export interface CloudOptions {
    token?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    onProgress?: (loaded: number, total: number) => void;
    allowInsecureHttp?: boolean;
}

function buildHeaders(options: CloudOptions): Record<string, string> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
}

const CLOUD_HTTPS_ERROR = 'Cloud sync requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).';
const CLOUD_TIMEOUT_ERROR = 'Cloud request timed out';

const assertCloudUrl = (url: string, options: CloudOptions): void => {
    assertConnectionAllowed(url, CLOUD_HTTPS_ERROR, {
        ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
        allowAndroidEmulator: true,
        allowInsecureHttp: options.allowInsecureHttp,
    });
};

export async function cloudGetJson<T>(
    url: string,
    options: CloudOptions = {},
): Promise<T | null> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'GET',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`Cloud GET failed (${res.status}): ${res.statusText}`);
    }

    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new Error(`Cloud GET failed: invalid JSON (${(error as Error).message})`);
    }
}

export async function cloudHeadJson(
    url: string,
    options: CloudOptions = {},
): Promise<RemoteFileMetadata> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'HEAD',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (res.status === 404) {
        return {
            exists: false,
            fingerprint: null,
            etag: null,
            lastModified: null,
            contentLength: null,
        };
    }
    if (!res.ok) {
        throw new Error(`Cloud HEAD failed (${res.status}): ${res.statusText}`);
    }

    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    const contentLength = res.headers.get('content-length');
    return {
        exists: true,
        fingerprint: buildHttpRemoteFileFingerprint('cloud', { etag, lastModified, contentLength }),
        etag,
        lastModified,
        contentLength,
    };
}

export async function cloudPutJson(
    url: string,
    data: unknown,
    options: CloudOptions = {},
): Promise<void> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    const res = await fetchWithTimeout(
        url,
        {
            method: 'PUT',
            headers,
            body: JSON.stringify(data, null, 2),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (!res.ok) {
        throw new Error(`Cloud PUT failed (${res.status}): ${res.statusText}`);
    }
}

export async function cloudPutFile(
    url: string,
    data: ArrayBuffer | Uint8Array | Blob,
    contentType: string,
    options: CloudOptions = {},
): Promise<void> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const headers = buildHeaders(options);
    headers['Content-Type'] = contentType || 'application/octet-stream';

    let body: BodyInit = data instanceof Uint8Array ? new Uint8Array(data) : data;
    if (options.onProgress) {
        const bytes = await toUint8Array(data);
        const stream = createProgressStream(bytes, options.onProgress);
        body = stream ?? bytes;
        if (!headers['Content-Length']) {
            headers['Content-Length'] = String(bytes.length);
        }
    }

    const res = await fetchWithTimeout(
        url,
        {
            method: 'PUT',
            headers,
            body,
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (!res.ok) {
        throw new Error(`Cloud File PUT failed (${res.status}): ${res.statusText}`);
    }
}

export async function cloudGetFile(
    url: string,
    options: CloudOptions = {},
): Promise<ArrayBuffer> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'GET',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (!res.ok) {
        throw new Error(`Cloud File GET failed (${res.status}): ${res.statusText}`);
    }

    const onProgress = options.onProgress;
    if (!onProgress || !res.body || typeof res.body.getReader !== 'function') {
        return await res.arrayBuffer();
    }

    const reader = res.body.getReader();
    const total = Number(res.headers.get('content-length') || 0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.length;
            onProgress(received, total);
        }
    }
    const merged = concatChunks(chunks, total || received);
    return toArrayBuffer(merged);
}

export async function cloudDeleteFile(
    url: string,
    options: CloudOptions = {},
): Promise<void> {
    assertCloudUrl(url, options);
    const fetcher = options.fetcher ?? fetch;
    const res = await fetchWithTimeout(
        url,
        {
            method: 'DELETE',
            headers: buildHeaders(options),
            signal: options.signal,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetcher,
        CLOUD_TIMEOUT_ERROR,
    );

    if (!res.ok && res.status !== 404) {
        throw new Error(`Cloud DELETE failed (${res.status}): ${res.statusText}`);
    }
}
