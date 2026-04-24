export type DesktopAudioCaptureBackend = 'native' | 'web';

export function getPreferredDesktopAudioCaptureBackend(options: {
    isTauriRuntime: boolean;
    isFlatpakRuntime: boolean;
}): DesktopAudioCaptureBackend {
    if (options.isTauriRuntime && !options.isFlatpakRuntime) {
        return 'native';
    }
    return 'web';
}
