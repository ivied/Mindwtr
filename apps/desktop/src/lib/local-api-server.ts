import { isTauriRuntime } from './runtime';

export const DEFAULT_LOCAL_API_PORT = 3456;

export type LocalApiServerStatus = {
    enabled: boolean;
    running: boolean;
    port: number;
    url?: string | null;
    token?: string | null;
    error?: string | null;
};

const fallbackStatus = (): LocalApiServerStatus => ({
    enabled: false,
    running: false,
    port: DEFAULT_LOCAL_API_PORT,
    url: null,
    token: null,
    error: null,
});

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime is unavailable.');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
}

export async function getLocalApiServerStatus(): Promise<LocalApiServerStatus> {
    if (!isTauriRuntime()) return fallbackStatus();
    return tauriInvoke<LocalApiServerStatus>('get_local_api_server_status');
}

export async function setLocalApiServerConfig({
    enabled,
    port,
}: {
    enabled: boolean;
    port: number;
}): Promise<LocalApiServerStatus> {
    if (!isTauriRuntime()) return fallbackStatus();
    return tauriInvoke<LocalApiServerStatus>('set_local_api_server_config', {
        enabled,
        port,
    });
}

export function normalizeLocalApiPortInput(value: string): number | null {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return null;
    }
    return port;
}
