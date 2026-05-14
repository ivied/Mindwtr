import { describe, expect, it, vi } from 'vitest';
import { cloudDeleteFile, cloudGetJson, cloudHeadJson, cloudPutJson } from './cloud';

const okResponse = (text: string) =>
    ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => text,
    }) as unknown as Response;

const headResponse = (headers: Record<string, string>) =>
    ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
            get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
        text: async () => '',
    }) as unknown as Response;

const errorResponse = (status: number, statusText: string) =>
    ({
        ok: false,
        status,
        statusText,
        text: async () => '',
    }) as unknown as Response;

describe('cloud sync http helpers', () => {
    it('returns null on 404 when fetching json', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        const result = await cloudGetJson('https://example.com/v1/data', { fetcher });
        expect(result).toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('parses json payload', async () => {
        const fetcher = vi.fn(async () => okResponse(JSON.stringify({ ok: true })));
        const result = await cloudGetJson<{ ok: boolean }>('https://example.com/v1/data', { fetcher });
        expect(result).toEqual({ ok: true });
    });

    it('throws on invalid json', async () => {
        const fetcher = vi.fn(async () => okResponse('not-json'));
        await expect(cloudGetJson('https://example.com/v1/data', { fetcher })).rejects.toThrow(
            'invalid JSON',
        );
    });

    it('allows local HTTP targets without manual override', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        await expect(cloudGetJson('http://192.168.1.50:8787/v1/data', { fetcher })).resolves.toBeNull();
    });

    it('blocks public HTTP targets even when manually overridden', async () => {
        const fetcher = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response));
        await expect(cloudGetJson('http://example.com/v1/data', { fetcher })).rejects.toThrow(
            'Cloud sync requires HTTPS for public URLs',
        );
        await expect(cloudGetJson('http://example.com/v1/data', {
            fetcher,
            allowInsecureHttp: true,
        })).rejects.toThrow('Cloud sync requires HTTPS for public URLs');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('sends auth and content type on put json', async () => {
        const fetcher = vi.fn(async () => okResponse(''));
        await cloudPutJson('https://example.com/v1/data', { hello: 'world' }, { fetcher, token: 'abc123' });
        const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('PUT');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('reads HEAD metadata for fast sync checks', async () => {
        const fetcher = vi.fn(async () => headResponse({
            etag: '"sha256-abc"',
            'last-modified': 'Thu, 07 May 2026 10:00:00 GMT',
            'content-length': '42',
        }));

        const metadata = await cloudHeadJson('https://example.com/v1/data', { fetcher, token: 'abc123' });

        expect(metadata).toMatchObject({
            exists: true,
            fingerprint: 'cloud:v1:etag="sha256-abc":mtime=Thu, 07 May 2026 10:00:00 GMT:len=42',
            etag: '"sha256-abc"',
        });
        const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('HEAD');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123');
    });

    it('treats 404 delete as success', async () => {
        const fetcher = vi.fn(async () => errorResponse(404, 'Not Found'));
        await expect(cloudDeleteFile('https://example.com/v1/file', { fetcher })).resolves.toBeUndefined();
    });

    it('throws on delete failures', async () => {
        const fetcher = vi.fn(async () => errorResponse(500, 'Server Error'));
        await expect(cloudDeleteFile('https://example.com/v1/file', { fetcher })).rejects.toThrow(
            'Cloud DELETE failed (500)',
        );
    });
});
