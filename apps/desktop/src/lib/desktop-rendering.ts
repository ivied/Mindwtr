import { isTauriRuntime } from './runtime';

export type DesktopRenderingConfig = {
    disableHardwareAcceleration: boolean;
};

const fallbackConfig = (): DesktopRenderingConfig => ({
    disableHardwareAcceleration: false,
});

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime is unavailable.');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
}

export async function getDesktopRenderingConfig(): Promise<DesktopRenderingConfig> {
    if (!isTauriRuntime()) return fallbackConfig();
    return tauriInvoke<DesktopRenderingConfig>('get_desktop_rendering_config');
}

export async function setDesktopRenderingConfig({
    disableHardwareAcceleration,
}: DesktopRenderingConfig): Promise<DesktopRenderingConfig> {
    if (!isTauriRuntime()) return fallbackConfig();
    return tauriInvoke<DesktopRenderingConfig>('set_desktop_rendering_config', {
        disableHardwareAcceleration,
    });
}
