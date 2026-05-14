export type InsecureUrlOptions = {
    allowAndroidEmulator?: boolean;
    allowAndroidEmulatorInDev?: boolean;
    allowLocalHostnames?: boolean;
    allowPrivateIpRanges?: boolean;
};

export type ConnectionAllowedOptions = InsecureUrlOptions & {
    allowInsecureHttp?: boolean;
};

export const DEFAULT_TIMEOUT_MS = 30_000;

export const SYNC_LOCAL_INSECURE_URL_OPTIONS: InsecureUrlOptions = {
    allowAndroidEmulatorInDev: true,
    allowLocalHostnames: true,
    allowPrivateIpRanges: true,
};

type Ipv4Octets = [number, number, number, number];

type UrlSecurityParts = {
    hostname: string;
    protocol: string;
};

export const isAbortError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null || !('name' in error)) return false;
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError';
};

const createAbortError = (message: string): Error => {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
};

const getAbortSignalReason = (signal: AbortSignal, fallbackMessage: string): Error => {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.trim()) return createAbortError(reason);
    return createAbortError(fallbackMessage);
};

const parseIpv4Host = (host: string): Ipv4Octets | null => {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null;
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 255) return null;
        octets.push(value);
    }
    return [octets[0], octets[1], octets[2], octets[3]];
};

const extractHostnameFromAuthority = (authority: string): string => {
    const atIndex = authority.lastIndexOf('@');
    const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
    if (hostPort.startsWith('[')) {
        const endBracket = hostPort.indexOf(']');
        return endBracket > 0 ? hostPort.slice(1, endBracket).toLowerCase() : '';
    }
    return (hostPort.split(':')[0] ?? '').toLowerCase();
};

const parseUrlSecurityParts = (rawUrl: string): UrlSecurityParts | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    let protocol = '';
    let hostname = '';
    try {
        const parsed = new URL(trimmed);
        protocol = String(parsed.protocol || '').toLowerCase();
        hostname = typeof parsed.hostname === 'string' ? parsed.hostname.toLowerCase() : '';
    } catch {
        // Fall back below. Some React Native URL shims parse the protocol but
        // do not expose hostname for plain local HTTP names.
    }

    const authorityMatch = trimmed.match(/^([a-z][a-z0-9.+-]*:)?\/\/([^/?#]*)/i);
    if (!protocol && authorityMatch?.[1]) {
        protocol = authorityMatch[1].toLowerCase();
    }
    if (!hostname && authorityMatch) {
        hostname = extractHostnameFromAuthority(authorityMatch[2] ?? '');
    }

    if ((protocol === 'http:' || protocol === 'https:') && !hostname) return null;
    return protocol ? { hostname, protocol } : null;
};

const isLikelyLocalHostname = (host: string): boolean => {
    if (!host) return false;
    if (host.includes('.')) {
        return host.endsWith('.local')
            || host.endsWith('.localdomain')
            || host.endsWith('.home.arpa');
    }
    return /^[a-z0-9-]+$/i.test(host);
};

const isPrivateIpv6Host = (host: string): boolean => {
    const normalized = host.toLowerCase();
    return normalized === '::1'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:');
};

export const isAllowedInsecureUrl = (rawUrl: string, options: InsecureUrlOptions = {}): boolean => {
    const parsed = parseUrlSecurityParts(rawUrl);
    if (!parsed) return false;
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const host =
        parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
            ? parsed.hostname.slice(1, -1)
            : parsed.hostname;
    if (host === 'localhost' || host === '::1') return true;
    const ipv4 = parseIpv4Host(host);
    if (ipv4 && ipv4[0] === 127) return true;
    if (options.allowPrivateIpRanges && ipv4) {
        const [first, second] = ipv4;
        if (first === 10) return true;
        if (first === 172 && second >= 16 && second <= 31) return true;
        if (first === 192 && second === 168) return true;
        if (first === 100 && second >= 64 && second <= 127) return true;
    }
    if (options.allowPrivateIpRanges && host.includes(':') && isPrivateIpv6Host(host)) return true;
    if (options.allowLocalHostnames && !ipv4 && isLikelyLocalHostname(host)) return true;
    if (host === '10.0.2.2') {
        if (options.allowAndroidEmulator) return true;
        if (options.allowAndroidEmulatorInDev) {
            const isDev =
                typeof globalThis !== 'undefined' && (globalThis as { __DEV__?: boolean }).__DEV__ === true;
            return isDev;
        }
    }
    return false;
};

export const isConnectionAllowed = (rawUrl: string, options: ConnectionAllowedOptions = {}): boolean => {
    return isAllowedInsecureUrl(rawUrl, options);
};

export const assertConnectionAllowed = (url: string, message: string, options?: ConnectionAllowedOptions) => {
    if (!isConnectionAllowed(url, options)) {
        throw new Error(message);
    }
};

export const assertSecureUrl = assertConnectionAllowed;

export const toUint8Array = async (
    data: ArrayBuffer | Uint8Array | Blob
): Promise<Uint8Array<ArrayBuffer>> => {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(await data.arrayBuffer());
};

export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    if (bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return new Uint8Array(bytes).buffer;
};

export const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
    if (total <= 0) {
        total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
};

export const createProgressStream = (bytes: Uint8Array, onProgress: (loaded: number, total: number) => void) => {
    if (typeof ReadableStream !== 'function') return null;
    const total = bytes.length;
    const chunkSize = 64 * 1024;
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= total) {
                controller.close();
                return;
            }
            const nextChunk = bytes.slice(offset, Math.min(total, offset + chunkSize));
            offset += nextChunk.length;
            controller.enqueue(nextChunk);
            onProgress(offset, total);
        },
    });
};

export const fetchWithTimeout = async (
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fetcher: typeof fetch,
    timeoutMessage: string,
): Promise<Response> => {
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    let didTimeout = false;
    const timeoutId = abortController
        ? setTimeout(() => {
            didTimeout = true;
            abortController.abort(createAbortError(timeoutMessage));
        }, timeoutMs)
        : null;

    const signal = abortController ? abortController.signal : init.signal;
    const externalSignal = init.signal;
    if (abortController && externalSignal) {
        if (externalSignal.aborted) {
            abortController.abort(getAbortSignalReason(externalSignal, 'Request cancelled'));
        } else {
            externalSignal.addEventListener('abort', () => {
                abortController.abort(getAbortSignalReason(externalSignal, 'Request cancelled'));
            }, { once: true });
        }
    }

    try {
        const requestInit: RequestInit & { duplex?: 'half' } = { ...init, signal };
        const body = requestInit.body;
        const isReadableStreamBody = typeof ReadableStream === 'function'
            && body instanceof ReadableStream;
        if (isReadableStreamBody) {
            requestInit.duplex = 'half';
        }
        return await fetcher(url, requestInit);
    } catch (error) {
        if (isAbortError(error)) {
            if (didTimeout) {
                throw new Error(timeoutMessage);
            }
            if (externalSignal?.aborted) {
                throw getAbortSignalReason(externalSignal, 'Request cancelled');
            }
            throw new Error(timeoutMessage);
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};
