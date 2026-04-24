import { describe, expect, it } from 'vitest';
import { fetchWithTimeout, isAllowedInsecureUrl } from './http-utils';

describe('isAllowedInsecureUrl', () => {
    it('allows HTTPS URLs', () => {
        expect(isAllowedInsecureUrl('https://example.com/data.json')).toBe(true);
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
    });

    it('allows clearly local hostnames when enabled', () => {
        const options = { allowLocalHostnames: true };
        expect(isAllowedInsecureUrl('http://nas/data.json', options)).toBe(true);
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
});
