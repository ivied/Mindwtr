import { invoke } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { isLocalAttachmentPath, resolveAttachmentOpenTarget, toAttachmentBrowserUrl } from './attachment-paths';
import { isTauriRuntime } from './runtime';

export async function openAttachmentTarget(uri: string): Promise<void> {
    const trimmed = uri.trim();
    if (!trimmed) return;

    if (isTauriRuntime()) {
        if (!isLocalAttachmentPath(trimmed)) {
            await openShell(trimmed);
            return;
        }

        await invoke('open_path', { path: resolveAttachmentOpenTarget(trimmed) });
        return;
    }

    window.open(toAttachmentBrowserUrl(trimmed), '_blank');
}
