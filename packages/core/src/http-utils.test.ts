import { describe, expect, it } from 'vitest';
import {
    fetchWithTimeout,
    isAllowedInsecureUrl,
    isConnectionAllowed,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
} from './http-utils';

describe('isAllowedInsecureUrl', () => {
    it('allows HTTPS URLs', () => {
        expect(isAllowedInsecureUrl('https://example.com/data.json')).toBe(true);
    });

    it('rejects HTTP(S) URLs without a hostname', () => {
        expect(isAllowedInsecureUrl('https://')).toBe(false);
        expect(isAllowedInsecureUrl('http:///data.json')).toBe(false);
    });

    it('allows loopback hosts for HTTP', () => {
        expect(isAllowedInsecureUrl('http://localhost/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://127.0.0.1/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://127.255.255.254/data.json')).toBe(true);
        expect(isAllowedInsecureUrl('http://[::1]/data.json')).toBe(true);
    });

    it('blocks private ranges unless explicitly enabled', () => {
        expect(isAllowedInsecureUrl('http://10.1.2.3/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://172.16.5.9/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://192.168.1.50/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://100.64.10.2/data.json')).toBe(false);
    });

    it('allows RFC1918 and CGNAT ranges when enabled', () => {
        const options = { allowPrivateIpRanges: true };
        expect(isAllowedInsecureUrl('http://10.1.2.3/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://172.16.0.1/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://172.31.255.255/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://192.168.1.50/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://100.64.0.1/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://100.127.255.255/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://[fd00::1]/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://[fe80::1]/data.json', options)).toBe(true);
    });

    it('allows clearly local hostnames when enabled', () => {
        const options = { allowLocalHostnames: true };
        expect(isAllowedInsecureUrl('http://nas/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://omvnas/webdav/alice/mindwtr', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://nas.local/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://router.home.arpa/data.json', options)).toBe(true);
        expect(isAllowedInsecureUrl('http://example.com/data.json', options)).toBe(false);
    });

    it('keeps private range boundaries strict', () => {
        const options = { allowPrivateIpRanges: true };
        expect(isAllowedInsecureUrl('http://172.15.255.255/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://172.32.0.1/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://100.63.255.255/data.json', options)).toBe(false);
        expect(isAllowedInsecureUrl('http://100.128.0.1/data.json', options)).toBe(false);
    });

    it('preserves Android emulator override behavior', () => {
        expect(isAllowedInsecureUrl('http://10.0.2.2/data.json')).toBe(false);
        expect(isAllowedInsecureUrl('http://10.0.2.2/data.json', { allowAndroidEmulator: true })).toBe(true);
    });
});

describe('isConnectionAllowed', () => {
    it('allows local sync HTTP targets without a manual override', () => {
        expect(isConnectionAllowed('http://192.168.1.50/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
        expect(isConnectionAllowed('http://omvnas/webdav/alice/mindwtr', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
        expect(isConnectionAllowed('http://nas.local/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
    });

    it('blocks public HTTP even when manually overridden', () => {
        expect(isConnectionAllowed('http://example.com/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(false);
        expect(isConnectionAllowed('http://example.com/data.json', {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp: true,
        })).toBe(false);
    });

    it('falls back to raw host parsing when URL lacks hostname support', () => {
        const originalUrl = globalThis.URL;

        class ProtocolOnlyURL {
            hostname = undefined;
            protocol: string;

            constructor(value: string) {
                const match = value.match(/^([a-z][a-z0-9.+-]*:)/i);
                if (!match) throw new TypeError('Invalid URL');
                this.protocol = match[1].toLowerCase();
            }
        }

        globalThis.URL = ProtocolOnlyURL as unknown as typeof URL;
        try {
            expect(isConnectionAllowed('http://omvnas/webdav/alice/mindwtr', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
            expect(isConnectionAllowed('http://192.168.1.50/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(true);
            expect(isConnectionAllowed('http://example.com/data.json', SYNC_LOCAL_INSECURE_URL_OPTIONS)).toBe(false);
        } finally {
            globalThis.URL = originalUrl;
        }
    });
});

describe('fetchWithTimeout', () => {
    it('adds duplex=half for ReadableStream request bodies', async () => {
        let receivedInit: (RequestInit & { duplex?: 'half' }) | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
            },
        });

        await fetchWithTimeout(
            'https://example.com/upload',
            { method: 'PUT', body },
            1_000,
            async (_input, init) => {
                receivedInit = init as RequestInit & { duplex?: 'half' };
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        );

        expect(receivedInit?.duplex).toBe('half');
    });

    it('does not add duplex for non-stream bodies', async () => {
        let receivedInit: (RequestInit & { duplex?: 'half' }) | undefined;

        await fetchWithTimeout(
            'https://example.com/upload',
            { method: 'PUT', body: JSON.stringify({ ok: true }) },
            1_000,
            async (_input, init) => {
                receivedInit = init as RequestInit & { duplex?: 'half' };
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        );

        expect(receivedInit?.duplex).toBeUndefined();
    });

    it('preserves caller abort reasons instead of reporting a timeout', async () => {
        const controller = new AbortController();
        const reason = new Error('Sync cancelled');
        reason.name = 'AbortError';
        controller.abort(reason);

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Sync cancelled');
    });

    it('falls back to a cancellation message for non-Error abort reasons', async () => {
        const controller = new AbortController();
        controller.abort({ name: 'AbortError', message: 'Native cancellation' });

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Request cancelled');
    });

    it('preserves DOMException abort reasons', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('Native cancellation', 'AbortError'));

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Native cancellation');
    });

    it.each([
        ['blank string', ' '],
        ['number', 42],
        ['null', null],
        ['symbol', Symbol('abort')],
    ])('falls back to a cancellation message for %s abort reasons', async (_label, reason) => {
        const controller = new AbortController();
        controller.abort(reason);

        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            { signal: controller.signal },
            1_000,
            async (_input, init) => {
                expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(true);
                const error = new Error('Fetch aborted');
                error.name = 'AbortError';
                throw error;
            },
            'Request timed out',
        )).rejects.toThrow('Request cancelled');
    });

    it('reports timeout when its own timer aborts the request', async () => {
        await expect(fetchWithTimeout(
            'https://example.com/data.json',
            {},
            1,
            async (_input, init) => {
                const signal = init?.signal as AbortSignal | undefined;
                await new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => {
                        const error = new Error('Fetch aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
                return new Response(null, { status: 200 });
            },
            'Request timed out',
        )).rejects.toThrow('Request timed out');
    });
});
