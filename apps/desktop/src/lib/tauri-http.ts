import { useTaskStore, type AppSettings } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';

type TauriHttpFetch = typeof fetch;
type TauriFetchInit = RequestInit & {
    proxy?: {
        all?: string;
    };
};

export const normalizeProxyUrl = (value: unknown): string => (
    typeof value === 'string' ? value.trim() : ''
);

export const isSupportedProxyUrl = (value: string): boolean => {
    const trimmed = normalizeProxyUrl(value);
    if (!trimmed) return true;
    try {
        const protocol = new URL(trimmed).protocol;
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

export const getConfiguredProxyUrl = (settings?: AppSettings): string => (
    normalizeProxyUrl(settings?.network?.proxyUrl)
);

export const withTauriHttpProxy = (
    baseFetch: TauriHttpFetch,
    proxyUrl: string,
): TauriHttpFetch => {
    const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) return baseFetch;

    return ((input: Parameters<TauriHttpFetch>[0], init?: Parameters<TauriHttpFetch>[1]) => {
        const nextInit: TauriFetchInit = {
            ...(init ?? {}),
            proxy: {
                ...((init as TauriFetchInit | undefined)?.proxy ?? {}),
                all: normalizedProxyUrl,
            },
        };
        return baseFetch(input, nextInit);
    }) as TauriHttpFetch;
};

export const getTauriHttpFetch = async (): Promise<TauriHttpFetch | undefined> => {
    if (!isTauriRuntime()) return undefined;
    const mod = await import('@tauri-apps/plugin-http');
    const proxyUrl = getConfiguredProxyUrl(useTaskStore.getState().settings);
    return withTauriHttpProxy(mod.fetch as unknown as TauriHttpFetch, proxyUrl);
};
