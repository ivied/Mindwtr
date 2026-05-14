import { invoke } from '@tauri-apps/api/core';

export const getLaunchAtStartupEnabled = async (): Promise<boolean> => (
    invoke<boolean>('get_launch_at_startup_enabled' as never)
);

export const setLaunchAtStartupEnabled = async (enabled: boolean): Promise<boolean> => (
    invoke<boolean>('set_launch_at_startup_enabled' as never, { enabled } as never)
);
