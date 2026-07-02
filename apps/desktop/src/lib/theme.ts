import type { AppData } from '@mindwtr/core';

export type DesktopThemeMode = 'system' | 'light' | 'dark' | 'eink' | 'nord' | 'sepia';
export type SystemThemePreference = 'light' | 'dark' | null;
type NativeThemePreference = Exclude<SystemThemePreference, null>;
type NativeThemeSetter = (theme?: NativeThemePreference | null) => Promise<void>;
type NativeThemeAppModule = {
    setTheme: NativeThemeSetter;
};
type TauriCoreModule = {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};
type NativeThemeWindow = {
    theme: () => Promise<SystemThemePreference>;
    setTheme?: NativeThemeSetter;
    onThemeChanged: (
        listener: (event: { payload: NativeThemePreference }) => void
    ) => Promise<() => void>;
};
type NativeThemeWindowModule = {
    getCurrentWindow: () => NativeThemeWindow;
};

export const THEME_STORAGE_KEY = 'mindwtr-theme';
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const COMMAND_THEME_POLL_INTERVAL_MS = 2000;
let cachedSystemThemePreference: SystemThemePreference = null;

const isDesktopThemeMode = (value: string | null | undefined): value is DesktopThemeMode => (
    value === 'system'
    || value === 'light'
    || value === 'dark'
    || value === 'eink'
    || value === 'nord'
    || value === 'sepia'
);

export const coerceDesktopThemeMode = (value: string | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    if (value === 'material3-dark' || value === 'oled') return 'dark';
    if (value === 'material3-light') return 'light';
    return null;
};

export const mapSyncedThemeToDesktop = (value: AppData['settings']['theme'] | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    if (value === 'material3-dark' || value === 'oled') return 'dark';
    if (value === 'material3-light') return 'light';
    return null;
};

export const resolveDesktopThemeMode = (
    syncedTheme: AppData['settings']['theme'] | null | undefined,
    storedTheme: string | null | undefined,
): DesktopThemeMode => (
    mapSyncedThemeToDesktop(syncedTheme)
    ?? coerceDesktopThemeMode(storedTheme)
    ?? 'system'
);

export const resolveSystemThemePreference = (override?: SystemThemePreference): SystemThemePreference => {
    if (override === 'light' || override === 'dark') {
        cachedSystemThemePreference = override;
        return override;
    }
    if (cachedSystemThemePreference) return cachedSystemThemePreference;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
};

export const coerceSystemThemePreference = (value: unknown): SystemThemePreference => {
    if (value === 'light' || value === 'dark') return value;
    return null;
};

export const resolveSystemThemeCommandPreference = async (
    loadCoreModule: () => Promise<TauriCoreModule>,
    onError?: (step: 'resolveSystem', error: unknown) => void,
): Promise<SystemThemePreference> => {
    try {
        const coreModule = await loadCoreModule();
        return coerceSystemThemePreference(await coreModule.invoke('get_system_theme_preference'));
    } catch (error) {
        onError?.('resolveSystem', error);
        return null;
    }
};

export const watchSystemThemePreference = (
    onChange: (theme: NativeThemePreference) => void
): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => { };

    const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent | { matches: boolean }) => {
        onChange(event.matches ? 'dark' : 'light');
    };

    if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handler as EventListener);
        return () => mediaQuery.removeEventListener('change', handler as EventListener);
    }

    if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handler as (event: MediaQueryListEvent) => void);
        return () => mediaQuery.removeListener(handler as (event: MediaQueryListEvent) => void);
    }

    return () => { };
};

export const watchNativeSystemThemePreference = (
    loadWindowModule: () => Promise<NativeThemeWindowModule>,
    onChange: (theme: NativeThemePreference) => void,
    onError?: (step: 'resolveSystem' | 'watch', error: unknown) => void,
): (() => void) => {
    let cancelled = false;
    let stopWatchingNativeTheme = () => { };

    void loadWindowModule()
        .then(async ({ getCurrentWindow }) => {
            if (cancelled) return;
            const currentWindow = getCurrentWindow();

            try {
                const nativeTheme = await currentWindow.theme();
                if (!cancelled && nativeTheme) {
                    onChange(nativeTheme);
                }
            } catch (error) {
                if (!cancelled) {
                    onError?.('resolveSystem', error);
                }
            }

            if (cancelled) return;

            try {
                const unlisten = await currentWindow.onThemeChanged(({ payload }) => {
                    onChange(payload);
                });
                if (cancelled) {
                    unlisten();
                    return;
                }
                stopWatchingNativeTheme = unlisten;
            } catch (error) {
                if (!cancelled) {
                    onError?.('watch', error);
                }
            }
        })
        .catch((error) => {
            if (!cancelled) {
                onError?.('watch', error);
            }
        });

    return () => {
        cancelled = true;
        stopWatchingNativeTheme();
    };
};

export const watchSystemThemeCommandPreference = (
    loadCoreModule: () => Promise<TauriCoreModule>,
    onChange: (theme: NativeThemePreference) => void,
    onError?: (step: 'resolveSystem' | 'watch', error: unknown) => void,
    pollIntervalMs = COMMAND_THEME_POLL_INTERVAL_MS,
): (() => void) => {
    if (typeof window === 'undefined') return () => { };

    let cancelled = false;
    let coreModule: TauriCoreModule | null = null;
    let lastTheme: SystemThemePreference = null;
    let pollTimer: number | null = null;
    let pollInFlight = false;

    const emitIfChanged = (theme: SystemThemePreference) => {
        if (!theme || theme === lastTheme) return;
        lastTheme = theme;
        onChange(theme);
    };

    const poll = async () => {
        if (cancelled || !coreModule || pollInFlight) return;
        pollInFlight = true;
        try {
            const theme = coerceSystemThemePreference(
                await coreModule.invoke('get_system_theme_preference')
            );
            if (!cancelled) {
                emitIfChanged(theme);
            }
        } catch (error) {
            if (!cancelled) {
                onError?.('resolveSystem', error);
            }
        } finally {
            pollInFlight = false;
        }
    };

    void loadCoreModule()
        .then((loadedCoreModule) => {
            if (cancelled) return;
            coreModule = loadedCoreModule;
            void poll();
            pollTimer = window.setInterval(() => {
                void poll();
            }, pollIntervalMs);
        })
        .catch((error) => {
            if (!cancelled) {
                onError?.('watch', error);
            }
        });

    return () => {
        cancelled = true;
        if (pollTimer !== null) {
            window.clearInterval(pollTimer);
        }
    };
};

export const applyThemeMode = (mode: DesktopThemeMode | null, systemTheme?: SystemThemePreference) => {
    const root = document.documentElement;
    root.classList.remove('theme-eink', 'theme-nord', 'theme-sepia');

    const prefersDark = resolveSystemThemePreference(systemTheme) === 'dark';
    if (mode === 'system' || mode === null) {
        root.classList.toggle('dark', prefersDark);
    } else if (mode === 'dark' || mode === 'nord') {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }

    if (mode === 'eink') root.classList.add('theme-eink');
    if (mode === 'nord') root.classList.add('theme-nord');
    if (mode === 'sepia') root.classList.add('theme-sepia');
};

export const resolveNativeTheme = (mode: DesktopThemeMode | null): 'light' | 'dark' | null => {
    if (!mode || mode === 'system') return null;
    if (mode === 'dark' || mode === 'nord') return 'dark';
    return 'light';
};

export const applyNativeTheme = async (
    theme: ReturnType<typeof resolveNativeTheme>,
    loadAppModule: () => Promise<NativeThemeAppModule>,
    loadWindowModule: () => Promise<NativeThemeWindowModule>,
    onError?: (step: 'app' | 'window', error: unknown) => void,
): Promise<void> => {
    await Promise.all([
        loadAppModule()
            .then(({ setTheme }) => setTheme(theme))
            .catch((error) => onError?.('app', error)),
        loadWindowModule()
            .then(({ getCurrentWindow }) => {
                const currentWindow = getCurrentWindow();
                if (typeof currentWindow.setTheme !== 'function') return undefined;
                return currentWindow.setTheme(theme);
            })
            .catch((error) => onError?.('window', error)),
    ]);
};
