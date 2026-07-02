import { describe, expect, it, vi } from 'vitest';
import { isSupportedProxyUrl, normalizeProxyUrl, withTauriHttpProxy } from './tauri-http';

describe('tauri http proxy helpers', () => {
    it('normalizes proxy URLs from settings input', () => {
        expect(normalizeProxyUrl('  http://proxy.local:8080  ')).toBe('http://proxy.local:8080');
        expect(normalizeProxyUrl(undefined)).toBe('');
        expect(normalizeProxyUrl(42)).toBe('');
    });

    it('accepts blank, http, and https proxy URLs only', () => {
        expect(isSupportedProxyUrl('')).toBe(true);
        expect(isSupportedProxyUrl(' http://proxy.local:8080 ')).toBe(true);
        expect(isSupportedProxyUrl('https://proxy.local:8443')).toBe(true);
        expect(isSupportedProxyUrl('socks5://proxy.local:1080')).toBe(false);
        expect(isSupportedProxyUrl('proxy.local:8080')).toBe(false);
    });

    it('leaves fetch unchanged when no proxy is configured', () => {
        const baseFetch = vi.fn() as unknown as typeof fetch;

        expect(withTauriHttpProxy(baseFetch, '   ')).toBe(baseFetch);
    });

    it('adds the proxy to Tauri fetch options while preserving existing init fields', async () => {
        const response = new Response('ok');
        const baseFetch = vi.fn(async () => response) as unknown as typeof fetch;
        const proxiedFetch = withTauriHttpProxy(baseFetch, ' http://proxy.local:8080 ');

        await proxiedFetch('https://example.com/data.ics', {
            method: 'GET',
            headers: { Accept: 'text/calendar' },
        });

        expect(baseFetch).toHaveBeenCalledWith('https://example.com/data.ics', {
            method: 'GET',
            headers: { Accept: 'text/calendar' },
            proxy: { all: 'http://proxy.local:8080' },
        });
    });
});
