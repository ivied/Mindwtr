import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { QuickAddWindowApp } from './QuickAddWindowApp.tsx';
import './index.css';

import { type AppData, consoleLogger, setLogger, setStorageAdapter, SQLITE_SCHEMA_VERSION } from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { isTauriRuntime } from './lib/runtime';
import { reportError } from './lib/report-error';
import { webStorage } from './lib/storage-adapter-web';
import { isDiagnosticsEnabled, logError, logInfo, logWarn, setupGlobalErrorLogging } from './lib/app-log';
import { THEME_STORAGE_KEY, applyThemeMode, coerceDesktopThemeMode, resolveNativeTheme } from './lib/theme';
import { TEXT_SIZE_STORAGE_KEY, applyDesktopTextSize, coerceDesktopTextSize } from './lib/text-size';
import { loadStoredFullscreen } from './lib/window-state';
import { isQuickAddWindowLocation } from './lib/quick-add-window';
import {
    detectDesktopPlatform,
    getDesktopChannel,
    getDesktopLocale,
    getDesktopOsMajor,
    getDesktopVersion,
    sendDesktopDailyHeartbeat,
} from './lib/analytics-heartbeat';

let coreLoggerBridgeInstalled = false;

const buildCoreLogExtra = (payload: {
    category?: string;
    context?: Record<string, unknown>;
    error?: unknown;
}): Record<string, unknown> | undefined => {
    const extra: Record<string, unknown> = {
        ...(payload.context ?? {}),
    };
    if (payload.category) {
        extra.category = payload.category;
    }
    if (payload.error) {
        extra.error = payload.error instanceof Error ? payload.error.message : String(payload.error);
        if (payload.error instanceof Error && payload.error.name) {
            extra.errorName = payload.error.name;
        }
        if (payload.error instanceof Error && payload.error.stack) {
            extra.errorStack = payload.error.stack;
        }
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
};

const installCoreLoggerBridge = () => {
    if (coreLoggerBridgeInstalled) return;
    coreLoggerBridgeInstalled = true;
    setLogger((payload) => {
        consoleLogger(payload);
        const scope = payload.scope ?? 'core';
        const extra = buildCoreLogExtra(payload);
        if (payload.level === 'error') {
            void logError(payload.error ?? payload.message, {
                scope,
                extra,
                message: payload.message,
            });
            return;
        }
        if (payload.level === 'warn') {
            void logWarn(payload.message, { scope, extra });
            return;
        }
        void logInfo(payload.message, { scope, extra });
    });
};

const getLoggingReason = (loggingEnabled: boolean): string => {
    if (isDiagnosticsEnabled()) return 'diagnostics-build';
    return loggingEnabled ? 'user-enabled' : 'startup-force';
};

const getStartupLoggingEnabled = async (): Promise<boolean> => {
    if (isTauriRuntime()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const data = await invoke<AppData>('get_data');
            return data?.settings?.diagnostics?.loggingEnabled === true;
        } catch {
            return false;
        }
    }
    try {
        const data = await webStorage.getData();
        return data.settings.diagnostics?.loggingEnabled === true;
    } catch {
        return false;
    }
};

const logDesktopStartupContext = async (): Promise<void> => {
    const platform = detectDesktopPlatform();
    const [channel, version, loggingEnabled, syncBackend] = await Promise.all([
        getDesktopChannel(),
        getDesktopVersion(),
        getStartupLoggingEnabled(),
        isTauriRuntime()
            ? import('./lib/sync-service')
                .then(({ SyncService }) => SyncService.getSyncBackend())
                .catch(() => 'off')
            : Promise.resolve('off'),
    ]);

    void logInfo('App started', {
        scope: 'startup',
        force: true,
        extra: {
            version,
            platform,
            osMajor: getDesktopOsMajor(platform),
            locale: getDesktopLocale(),
            channel,
            syncBackend,
            schemaVersion: String(SQLITE_SCHEMA_VERSION),
            loggingReason: getLoggingReason(loggingEnabled),
        },
    });
};

// Initialize theme immediately before React renders to prevent flash
const savedTheme = coerceDesktopThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
applyThemeMode(savedTheme);
const savedTextSize = coerceDesktopTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
applyDesktopTextSize(savedTextSize);

installCoreLoggerBridge();

const diagnosticsEnabled = isDiagnosticsEnabled();
if (diagnosticsEnabled) {
    setupGlobalErrorLogging();
}
const isQuickAddWindow = isQuickAddWindowLocation();

const nativeTheme = resolveNativeTheme(savedTheme);
if (isTauriRuntime()) {
    import('@tauri-apps/api/app')
        .then(({ setTheme }) => setTheme(nativeTheme))
        .catch(() => undefined);
}

async function initStorage() {
    if (isTauriRuntime()) {
        const { tauriStorage } = await import('./lib/storage-adapter');
        setStorageAdapter(tauriStorage);
        return;
    }

    setStorageAdapter(webStorage);
}

async function restoreFullscreenState() {
    if (!isTauriRuntime()) return;
    if (!loadStoredFullscreen(localStorage)) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const current = getCurrentWindow();
        if (await current.isFullscreen()) return;
        await current.setFullscreen(true);
    } catch (error) {
        void logWarn('Failed to restore fullscreen state', {
            scope: 'window',
            extra: {
                step: 'restoreFullscreen',
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

async function bootstrap() {
    await initStorage();
    setupGlobalErrorLogging();
    if (!isQuickAddWindow) {
        await logDesktopStartupContext().catch(() => undefined);
        await restoreFullscreenState();
    }

    if (!isQuickAddWindow && !isTauriRuntime() && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    const RootApp = isQuickAddWindow ? QuickAddWindowApp : App;

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <LanguageProvider>
                <RootApp />
            </LanguageProvider>
        </React.StrictMode>,
    );

    if (!isQuickAddWindow) {
        void sendDesktopDailyHeartbeat().catch((error) => {
            void logWarn('Desktop analytics heartbeat failed', {
                scope: 'analytics',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        });
    }
}

bootstrap().catch((error) => reportError('Failed to start app', error));
