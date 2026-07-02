import { useEffect, useState, useRef, useTransition, useCallback, useMemo, Suspense, lazy } from 'react';
import { Layout } from './components/Layout';
import { ListView } from './components/views/ListView';
import { CalendarView } from './components/views/CalendarView';
const BoardView = lazy(() => import('./components/views/BoardView').then((m) => ({ default: m.BoardView })));
const ObsidianView = lazy(() => import('./components/views/ObsidianView').then((m) => ({ default: m.ObsidianView })));
import { ContextsView } from './components/views/ContextsView';
import { ProjectsView as ProjectsViewEager } from './components/views/ProjectsView';
const ReviewView = lazy(() => import('./components/views/ReviewView').then((m) => ({ default: m.ReviewView })));
const ProceduralPlaybookView = lazy(() =>
    import('./components/views/ProceduralPlaybookView').then((m) => ({ default: m.ProceduralPlaybookView }))
);
const GlossaryOnboardingView = lazy(() =>
    import('./components/views/GlossaryOnboardingView').then((m) => ({ default: m.GlossaryOnboardingView }))
);
const ControlCenterView = lazy(() =>
    import('./components/views/ControlCenterView').then((m) => ({ default: m.ControlCenterView }))
);
import { ArchiveView } from './components/views/ArchiveView';
import { TrashView } from './components/views/TrashView';
import { AgendaView } from './components/views/AgendaView';
import { SearchView } from './components/views/SearchView';
import {
    ACTIVE_APP_ANNOUNCEMENT,
    APP_ANNOUNCEMENT_DISMISSED_VALUE,
    DONATION_PROMPT_ANNOUNCEMENT,
    addBreadcrumb,
    configureDateFormatting,
    flushPendingSave,
    getAnnouncementDismissalStorageKey,
    isSupportedLanguage,
    recordDonationPromptShown,
    recordDonationPromptSupportClicked,
    recordUpdateReminderChecked,
    recordUpdateReminderDismissed,
    recordUpdateReminderShown,
    shouldShowAppAnnouncement,
    shouldShowDonationPrompt,
    shouldCheckUpdateReminder,
    shouldShowUpdateReminder,
    summarizeMergeStats,
    translateWithFallback,
    useTaskStore,
    type AppAnnouncement,
    type AppAnnouncementAction,
} from '@mindwtr/core';
import { GlobalSearch } from './components/GlobalSearch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppAnnouncementModal } from './components/AppAnnouncementModal';
import { DesktopOnboardingFlow } from './components/DesktopOnboardingFlow';
import { ModalPortal } from './components/ModalPortal';
import { useLanguage } from './contexts/language-context';
import { KeybindingProvider } from './contexts/keybinding-context';
import { QuickAddModal } from './components/QuickAddModal';
import { CloseBehaviorModal } from './components/CloseBehaviorModal';
import { startDesktopNotifications, stopDesktopNotifications } from './lib/notification-service';
import {
    runFullDesktopCalendarPushSync,
    startDesktopCalendarPushSync,
    stopDesktopCalendarPushSync,
} from './lib/desktop-calendar-push-sync';
import { SyncService } from './lib/sync-service';
import type { ExternalSyncChange, ExternalSyncChangeResolution } from './lib/sync-service';
import * as LocalDataWatcher from './lib/local-data-watcher';
import { getInstallSourceOrFallback, isFlatpakRuntime, isTauriRuntime } from './lib/runtime';
import { logError, logInfo } from './lib/app-log';
import { createDesktopAutoSyncController } from './lib/auto-sync-controller';
import { canDesktopAutoSync } from './lib/desktop-auto-sync-eligibility';
import { beginSettingsOpenTrace, markSettingsOpenTrace, wrapSettingsOpenImport } from './lib/settings-open-diagnostics';
import {
    THEME_STORAGE_KEY,
    applyNativeTheme,
    applyThemeMode,
    resolveDesktopThemeMode,
    resolveNativeTheme,
    resolveSystemThemeCommandPreference,
    watchSystemThemeCommandPreference,
    watchNativeSystemThemePreference,
    watchSystemThemePreference,
} from './lib/theme';
import {
    DEFAULT_DESKTOP_TEXT_SIZE_MODE,
    TEXT_SIZE_STORAGE_KEY,
    applyDesktopTextSize,
    coerceDesktopTextSize,
} from './lib/text-size';
import { saveStoredFullscreen } from './lib/window-state';
import { installWebviewZoomShortcuts } from './lib/webview-zoom';
import { isEditableManualSyncShortcutTarget, isManualSyncShortcut } from './lib/manual-sync-shortcut';
import {
    isDesktopSyncRuntimeActive,
    resolveVisibilitySyncAction,
    shouldHandleDesktopManualSyncShortcut,
} from './lib/desktop-sync-runtime';
import { resolveCloseBehavior } from './lib/window-behavior';
import { handleDesktopCloseRequest } from './lib/close-request-handler';
import { subscribeNavigateEvent } from './lib/navigation-events';
import { shouldOpenDesktopFirstRunOnboarding, subscribeDesktopOnboardingEvent } from './lib/desktop-onboarding-events';
import { QUICK_ADD_SAVED_EVENT } from './lib/quick-add-saved-event';
import {
    readLocalUserPromptState,
    recordLocalPromptActivity,
    updateLocalUserPromptState,
} from './lib/user-prompt-state';
import {
    checkForUpdates,
    normalizeInstallSource,
    type InstallSource,
} from './lib/update-service';
import { getDesktopUpdateTarget, isDesktopUpdateReminderAllowed } from './lib/desktop-update-targets';
import {
    PROMPT_TEST_CONTROLS_ENABLED,
    subscribePromptTest,
} from './lib/prompt-test-controls';
import { useUiStore } from './store/ui-store';
import { useObsidianStore } from './store/obsidian-store';
import type { SettingsOnboardingHintPage, SettingsPage } from './components/views/SettingsView';

const ProjectsView = import.meta.env.DEV
    ? ProjectsViewEager
    : lazy(() => import('./components/views/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const SettingsView = lazy(wrapSettingsOpenImport(
    'settings-view-chunk',
    () => import('./components/views/SettingsView').then((m) => ({ default: m.SettingsView }))
));

const DEFAULT_DESKTOP_VIEW = 'agenda';
const DESKTOP_ONBOARDING_STORAGE_KEY = 'mindwtr:desktop:first-run-onboarding:v1';
const DONATION_PROMPT_ENABLED = (
    import.meta.env.VITE_DONATION_PROMPT_ENABLED === '1'
    || import.meta.env.VITE_DONATION_PROMPT_ENABLED === 'true'
);
const DONATION_PROMPT_STARTUP_DELAY_MS = 2000;
const MS_STORE_REVIEW_URL = 'ms-windows-store://review/?ProductId=9N0V5B0B6FRX';
const MAC_APP_STORE_REVIEW_URL = 'macappstore://itunes.apple.com/app/id6758597144?action=write-review';

type DesktopUpdateReminderInfo = {
    currentVersion: string;
    latestVersion: string;
    latestReleasedAt: string | null;
    releaseUrl: string;
    actionLabel?: string;
    testOnly?: boolean;
};

const isDesktopDonationPromptAllowed = (installSource: string | null | undefined): boolean => (
    DONATION_PROMPT_ENABLED && normalizeInstallSource(installSource) !== 'unknown'
);

const readDesktopOnboardingDismissed = () => {
    if (typeof window === 'undefined') return true;
    try {
        return window.localStorage.getItem(DESKTOP_ONBOARDING_STORAGE_KEY) === 'dismissed';
    } catch {
        return false;
    }
};

const writeDesktopOnboardingDismissed = () => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(DESKTOP_ONBOARDING_STORAGE_KEY, 'dismissed');
    } catch {
        // If localStorage is unavailable, keep the in-memory dismissal for this session.
    }
};

const buildUpdateReminderAnnouncement = (info: DesktopUpdateReminderInfo): AppAnnouncement => ({
    id: `update-reminder-${info.latestVersion}`,
    title: 'Update available',
    body: `Mindwtr ${info.latestVersion} is available. You are using ${info.currentVersion}. Update when you have a minute to keep fixes and improvements current.`,
    action: {
        type: 'url',
        label: info.actionLabel ?? 'View release',
        url: info.releaseUrl,
    },
});

const PROMPT_TEST_ANNOUNCEMENT: AppAnnouncement = {
    id: 'prompt-test-announcement',
    title: 'Test announcement',
    body: 'This is the temporary announcement template test. It uses the same popup surface as a real maintainer announcement.',
};

const getDesktopPlatform = (): 'windows' | 'macos' | 'linux' | 'other' => {
    const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) return 'windows';
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
    return 'other';
};

const getDesktopReviewTarget = (installSource: InstallSource | null): { label: string; url: string } | null => {
    const platform = getDesktopPlatform();
    if (platform === 'linux') return null;
    if (installSource === 'microsoft-store' || platform === 'windows') {
        return { label: 'Rate Mindwtr', url: MS_STORE_REVIEW_URL };
    }
    if (installSource === 'mac-app-store' || platform === 'macos') {
        return { label: 'Rate Mindwtr', url: MAC_APP_STORE_REVIEW_URL };
    }
    return {
        label: 'Open GitHub',
        url: 'https://github.com/dongdongbh/Mindwtr',
    };
};

const buildPromptTestReviewAnnouncement = (installSource: InstallSource | null): AppAnnouncement | null => {
    const target = getDesktopReviewTarget(installSource);
    if (!target) return null;
    return {
        id: 'prompt-test-review',
        title: 'Enjoying Mindwtr?',
        body: 'A quick rating helps others discover it. It only takes a moment.',
        action: {
            type: 'url',
            label: target.label,
            url: target.url,
        },
    };
};

function App() {
    // Honor `?view=<name>` from the URL on first mount (TG deep-links land here).
    const initialView = (() => {
        if (typeof window === 'undefined') return DEFAULT_DESKTOP_VIEW;
        const v = new URLSearchParams(window.location.search).get('view');
        return v && v.trim() ? v.trim() : DEFAULT_DESKTOP_VIEW;
    })();
    const [currentView, setCurrentView] = useState(initialView);
    const [activeView, setActiveView] = useState(initialView);
    const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage | undefined>();
    const [settingsOnboardingHintPage, setSettingsOnboardingHintPage] = useState<
        SettingsOnboardingHintPage | undefined
    >();
    const [desktopOnboardingDismissed, setDesktopOnboardingDismissed] = useState(readDesktopOnboardingDismissed);
    const [desktopOnboardingOpen, setDesktopOnboardingOpen] = useState(false);
    const [desktopOnboardingBusy, setDesktopOnboardingBusy] = useState(false);
    const [desktopOnboardingError, setDesktopOnboardingError] = useState<string | null>(null);
    const [desktopOnboardingGateSettled, setDesktopOnboardingGateSettled] = useState(false);
    const [announcementOpen, setAnnouncementOpen] = useState(false);
    const [announcementDismissedInSession, setAnnouncementDismissedInSession] = useState(false);
    const [donationPromptOpen, setDonationPromptOpen] = useState(false);
    const [donationDismissedInSession, setDonationDismissedInSession] = useState(false);
    const [donationPromptAllowed, setDonationPromptAllowed] = useState<boolean | null>(null);
    const [desktopInstallSource, setDesktopInstallSource] = useState<InstallSource | null>(null);
    const [updateReminderOpen, setUpdateReminderOpen] = useState(false);
    const [updateReminderDismissedInSession, setUpdateReminderDismissedInSession] = useState(false);
    const [updateReminderInfo, setUpdateReminderInfo] = useState<DesktopUpdateReminderInfo | null>(null);
    const [testAnnouncement, setTestAnnouncement] = useState<AppAnnouncement | null>(null);
    const [, startTransition] = useTransition();
    const fetchData = useTaskStore((state) => state.fetchData);
    const seedGettingStarted = useTaskStore((state) => state.seedGettingStarted);
    const isLoading = useTaskStore((state) => state.isLoading);
    const visibleDataCount = useTaskStore((state) => (
        state.tasks.length + state.projects.length + state.sections.length + state.areas.length
    ));
    const setError = useTaskStore((state) => state.setError);
    const isFlatpak = isFlatpakRuntime();
    const windowDecorations = useTaskStore((state) => state.settings?.window?.decorations);
    const closeBehavior = useTaskStore((state) => (
        resolveCloseBehavior(state.settings?.window?.closeBehavior, isFlatpak)
    ));
    const showTray = useTaskStore((state) => state.settings?.window?.showTray);
    const settingsTheme = useTaskStore((state) => state.settings?.theme);
    const settingsTextSize = useTaskStore((state) => state.settings?.appearance?.textSize);
    const settingsLanguage = useTaskStore((state) => state.settings?.language);
    const settingsDateFormat = useTaskStore((state) => state.settings?.dateFormat);
    const settingsCalendarSystem = useTaskStore((state) => state.settings?.calendarSystem);
    const settingsTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const showToast = useUiStore((state) => state.showToast);
    const { t, language, setLanguage } = useLanguage();
    const isActiveRef = useRef(true);
    const lastSyncErrorRef = useRef<string | null>(null);
    const lastSyncErrorAtRef = useRef(0);
    const [closePromptOpen, setClosePromptOpen] = useState(false);
    const [closePromptRemember, setClosePromptRemember] = useState(false);
    const [externalSyncChange, setExternalSyncChange] = useState<ExternalSyncChange | null>(null);
    const [resolvingExternalSync, setResolvingExternalSync] = useState(false);
    const [hasHydratedSettings, setHasHydratedSettings] = useState(false);
    const closePromptRememberRef = useRef(false);
    const closePromptOpenRef = useRef(false);
    const localPromptActivityRecordedRef = useRef(false);
    const lastViewBreadcrumbRef = useRef<string | null>(null);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    const obsidianVaultPath = useObsidianStore((state) => state.config.vaultPath);
    const startObsidianWatcher = useObsidianStore((state) => state.startWatcher);
    const stopObsidianWatcher = useObsidianStore((state) => state.stopWatcher);
    const activeAnnouncement = testAnnouncement ?? ACTIVE_APP_ANNOUNCEMENT;

    const setClosePromptRememberValue = useCallback((next: boolean) => {
        closePromptRememberRef.current = next;
        setClosePromptRemember(next);
    }, []);

    const setClosePromptOpenValue = useCallback((next: boolean) => {
        closePromptOpenRef.current = next;
        setClosePromptOpen(next);
    }, []);

    const resolveExternalSync = useCallback(async (resolution: ExternalSyncChangeResolution) => {
        setResolvingExternalSync(true);
        try {
            const result = await SyncService.resolveExternalSyncChange(resolution);
            if (result.success) {
                if (resolution === 'keep-local') {
                    showToast('Kept local changes and updated sync file.', 'success');
                } else if (resolution === 'use-external') {
                    showToast('Loaded external sync file changes.', 'success');
                } else {
                    const conflicts = summarizeMergeStats(result.stats).conflicts;
                    showToast(
                        conflicts > 0
                            ? `Sync merged with ${conflicts} conflict${conflicts === 1 ? '' : 's'} resolved.`
                            : 'Sync merged external changes.',
                        'success'
                    );
                }
                setExternalSyncChange(null);
                return;
            }
            showToast(result.error || 'Failed to resolve external sync change.', 'error');
        } finally {
            setResolvingExternalSync(false);
        }
    }, [showToast]);

    const persistCloseBehavior = useCallback(async (behavior: 'tray' | 'quit') => {
        await updateSettings({
            window: {
                ...(useTaskStore.getState().settings?.window ?? {}),
                closeBehavior: behavior,
            },
        });
        await flushPendingSave();
    }, [updateSettings]);

    const getActiveThemeMode = useCallback(() => (
        resolveDesktopThemeMode(settingsTheme, localStorage.getItem(THEME_STORAGE_KEY))
    ), [settingsTheme]);

    const applyActiveNativeTheme = useCallback((stepPrefix = 'apply') => {
        if (!isTauriRuntime()) return;
        const nativeTheme = resolveNativeTheme(getActiveThemeMode());
        void applyNativeTheme(
            nativeTheme,
            () => import('@tauri-apps/api/app'),
            () => import('@tauri-apps/api/window'),
            (step, error) => void logError(error, { scope: 'theme', step: `${stepPrefix}:${step}` }),
        );
    }, [getActiveThemeMode]);

    useEffect(() => {
        if (!hasHydratedSettings) return;
        let cancelled = false;
        const normalizedTheme = getActiveThemeMode();
        localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme);
        applyThemeMode(normalizedTheme);
        if (normalizedTheme === 'system' && isTauriRuntime()) {
            void resolveSystemThemeCommandPreference(
                () => import('@tauri-apps/api/core'),
                (step, error) => void logError(error, { scope: 'theme', step: `initial-command:${step}` }),
            ).then((theme) => {
                if (!cancelled && theme) applyThemeMode('system', theme);
            });
        }
        applyActiveNativeTheme();
        return () => {
            cancelled = true;
        };
    }, [applyActiveNativeTheme, getActiveThemeMode, hasHydratedSettings]);

    useEffect(() => {
        if (!hasHydratedSettings || !isTauriRuntime()) return;
        const reapplyTheme = () => applyActiveNativeTheme('reapply');
        const reapplyThemeWhenVisible = () => {
            if (document.visibilityState === 'visible') {
                reapplyTheme();
            }
        };

        window.addEventListener('focus', reapplyTheme);
        document.addEventListener('visibilitychange', reapplyThemeWhenVisible);
        return () => {
            window.removeEventListener('focus', reapplyTheme);
            document.removeEventListener('visibilitychange', reapplyThemeWhenVisible);
        };
    }, [applyActiveNativeTheme, hasHydratedSettings]);

    useEffect(() => {
        if (!hasHydratedSettings) return;
        const normalizedTextSize = coerceDesktopTextSize(settingsTextSize);
        if (normalizedTextSize === DEFAULT_DESKTOP_TEXT_SIZE_MODE) {
            localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
        } else {
            localStorage.setItem(TEXT_SIZE_STORAGE_KEY, normalizedTextSize);
        }
        applyDesktopTextSize(normalizedTextSize);
    }, [hasHydratedSettings, settingsTextSize]);

    useEffect(() => {
        if (!hasHydratedSettings) return;
        const normalizedTheme = getActiveThemeMode();
        if (normalizedTheme !== 'system') return;

        const stopWatchingSystemTheme = watchSystemThemePreference((theme) => {
            applyThemeMode('system', theme);
        });

        if (!isTauriRuntime()) {
            return () => {
                stopWatchingSystemTheme();
            };
        }

        const stopWatchingNativeTheme = watchNativeSystemThemePreference(
            () => import('@tauri-apps/api/window'),
            (theme) => {
                applyThemeMode('system', theme);
            },
            (step, error) => {
                void logError(error, { scope: 'theme', step });
            }
        );
        const stopWatchingCommandTheme = watchSystemThemeCommandPreference(
            () => import('@tauri-apps/api/core'),
            (theme) => {
                applyThemeMode('system', theme);
            },
            (step, error) => {
                void logError(error, { scope: 'theme', step: `command:${step}` });
            }
        );

        return () => {
            stopWatchingSystemTheme();
            stopWatchingNativeTheme();
            stopWatchingCommandTheme();
        };
    }, [getActiveThemeMode, hasHydratedSettings]);

    useEffect(() => {
        if (!settingsLanguage || !isSupportedLanguage(settingsLanguage)) return;
        if (settingsLanguage === language) return;
        setLanguage(settingsLanguage);
    }, [settingsLanguage, language, setLanguage]);

    useEffect(() => {
        const next = `view:${currentView}`;
        if (lastViewBreadcrumbRef.current === next) return;
        lastViewBreadcrumbRef.current = next;
        addBreadcrumb(next);
    }, [currentView]);

    useEffect(() => {
        const systemLocale = (() => {
            const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
            return String(candidates?.[0] || '').trim();
        })();
        configureDateFormatting({
            language: settingsLanguage || language,
            dateFormat: settingsDateFormat,
            calendarSystem: settingsCalendarSystem,
            timeFormat: settingsTimeFormat,
            systemLocale,
        });
    }, [language, settingsCalendarSystem, settingsDateFormat, settingsLanguage, settingsTimeFormat]);

    const translateOrFallback = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    const donationPromptAnnouncement = useMemo<AppAnnouncement>(() => ({
        ...DONATION_PROMPT_ANNOUNCEMENT,
        title: translateOrFallback('donationPrompt.title', DONATION_PROMPT_ANNOUNCEMENT.title),
        body: translateOrFallback('donationPrompt.body', DONATION_PROMPT_ANNOUNCEMENT.body),
        dismissLabel: translateOrFallback(
            'donationPrompt.dismiss',
            DONATION_PROMPT_ANNOUNCEMENT.dismissLabel ?? DONATION_PROMPT_ANNOUNCEMENT.title,
        ),
        action: DONATION_PROMPT_ANNOUNCEMENT.action
            ? {
                ...DONATION_PROMPT_ANNOUNCEMENT.action,
                label: translateOrFallback('donationPrompt.action', DONATION_PROMPT_ANNOUNCEMENT.action.label),
            }
            : undefined,
    }), [translateOrFallback]);

    const hideToTray = useCallback(async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        try {
            await window.setSkipTaskbar(true);
        } catch (error) {
            void logError(error, { scope: 'window', step: 'setSkipTaskbar' });
        }
        await window.hide();
    }, []);

    const quitApp = useCallback(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('quit_app');
    }, []);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        let cancelled = false;
        let disposed = false;
        let stopCalendarPush: (() => void) | null = null;

        const reportError = (label: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`${label}: ${message}`);
            void logError(error, { scope: 'app', step: label });
        };

        fetchData()
            .finally(() => {
                if (!cancelled) {
                    setHasHydratedSettings(true);
                }
            })
            .then(() => {
                if (!disposed && isTauriRuntime()) {
                    stopCalendarPush = startDesktopCalendarPushSync();
                    runFullDesktopCalendarPushSync()
                        .catch((error) => reportError('Calendar push failed', error));
                }
            })
            .catch((error) => reportError('Data load failed', error));
        useObsidianStore.getState().loadConfig().catch((error) => reportError('Obsidian init failed', error));
        const unsubscribeExternalSync = SyncService.subscribeExternalSyncChange(setExternalSyncChange);

        const handleUnload = () => {
            flushPendingSave().catch((error) => reportError('Save failed', error));
        };
        window.addEventListener('beforeunload', handleUnload);
        let unlistenClose: (() => void) | null = null;
        let closingPromise: Promise<void> | null = null;
        let isClosing = false;
        if (isTauriRuntime()) {
            import('@tauri-apps/api/window')
                .then(async ({ getCurrentWindow }) => {
                    const window = getCurrentWindow();
                    const unlisten = await window.onCloseRequested(async (event) => {
                        if (closingPromise || isClosing) return;
                        isClosing = true;
                        event.preventDefault();
                        closingPromise = flushPendingSave()
                            .catch((error) => reportError('Save failed', error))
                            .finally(() => {
                                closingPromise = null;
                                isClosing = false;
                            });
                        await closingPromise;
                    });
                    if (disposed) {
                        unlisten();
                    } else {
                        unlistenClose = unlisten;
                    }
                })
                .catch((error) => reportError('Window listener failed', error));
        }

        if (isTauriRuntime()) {
            startDesktopNotifications().catch((error) => reportError('Notifications failed', error));
            SyncService.startFileWatcher().catch((error) => reportError('File watcher failed', error));

            // Watch local data.json and SQLite sidecar files for external changes (CLI/MCP/Local REST).
            import('@tauri-apps/api/core')
                .then(async (mod) => {
                    const [dataPath, dbPath] = await Promise.all([
                        mod.invoke<string>('get_data_path_cmd'),
                        mod.invoke<string>('get_db_path_cmd'),
                    ]);
                    await LocalDataWatcher.start(dataPath, dbPath);
                })
                .catch((error) => reportError('Local data watcher failed', error));
        }

        isActiveRef.current = true;

        const performSync = async () => {
            return SyncService.performSync();
        };

        const handleSyncFailure = (message: string) => {
            const nowMs = Date.now();
            const isSameError = message === lastSyncErrorRef.current;
            // Throttle repeated identical errors to once per 2 minutes, but always
            // show new/different error messages immediately so the user stays informed.
            const shouldAlert = !isSameError || nowMs - lastSyncErrorAtRef.current > 2 * 60 * 1000;
            if (shouldAlert) {
                lastSyncErrorRef.current = message;
                lastSyncErrorAtRef.current = nowMs;
                showToast(`Sync failed: ${message}`, 'error', 6000);
            }
        };

        const autoSyncController = createDesktopAutoSyncController({
            canSync: () => canDesktopAutoSync(SyncService),
            performSync,
            flushPendingSave,
            reportError,
            onSyncFailure: handleSyncFailure,
            isRuntimeActive: () => isDesktopSyncRuntimeActive(isActiveRef.current),
            shouldPauseWindowSync: () => (
                useTaskStore.getState().editLockCount > 0
                || useUiStore.getState().editingTaskId !== null
            ),
            hasPendingLocalChanges: () => SyncService.hasPendingLocalChangesForAutoSync(),
            logInfo: (message, extra) => {
                void logInfo(message, { scope: 'sync', extra });
            },
        });

        const focusListener = () => {
            autoSyncController.handleFocus();
        };

        const blurListener = () => {
            autoSyncController.handleBlur();
        };

        const manualSyncShortcutListener = (event: KeyboardEvent) => {
            if (!shouldHandleDesktopManualSyncShortcut({
                isEditableTarget: isEditableManualSyncShortcutTarget(event.target),
                isShortcut: isManualSyncShortcut(event),
            })) return;
            event.preventDefault();
            void autoSyncController.requestSync(0).catch((error) => reportError('Sync failed', error));
        };

        const visibilityListener = () => {
            const action = resolveVisibilitySyncAction(document.visibilityState);
            if (action === 'focus') {
                autoSyncController.handleFocus();
            } else if (action === 'blur') {
                autoSyncController.handleBlur();
            }
        };

        const storeUnsubscribe = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            autoSyncController.handleDataChange();
        });

        window.addEventListener('focus', focusListener);
        window.addEventListener('blur', blurListener);
        window.addEventListener('keydown', manualSyncShortcutListener);
        document.addEventListener('visibilitychange', visibilityListener);
        autoSyncController.scheduleInitialSync();

        return () => {
            cancelled = true;
            disposed = true;
            isActiveRef.current = false;
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('focus', focusListener);
            window.removeEventListener('blur', blurListener);
            window.removeEventListener('keydown', manualSyncShortcutListener);
            document.removeEventListener('visibilitychange', visibilityListener);
            if (unlistenClose) {
                unlistenClose();
            }
            storeUnsubscribe();
            autoSyncController.dispose();
            stopCalendarPush?.();
            stopDesktopCalendarPushSync();
            stopDesktopNotifications();
            LocalDataWatcher.stop();
            SyncService.stopFileWatcher().catch((error) => reportError('File watcher failed', error));
            unsubscribeExternalSync();
        };
    }, [fetchData, setError, showToast]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const reportQuickAddRefreshError = (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`Quick add refresh failed: ${message}`);
            void logError(error, { scope: 'quick-add', step: 'refreshAfterStandaloneSave' });
        };

        const setup = async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const nextUnlisten = await listen(QUICK_ADD_SAVED_EVENT, async () => {
                await LocalDataWatcher.refreshFromDiskNow().catch(reportQuickAddRefreshError);
            });
            if (disposed) {
                nextUnlisten();
                return;
            }
            unlisten = nextUnlisten;
        };

        setup().catch(reportQuickAddRefreshError);

        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [setError]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const reportCloseError = (label: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`${label}: ${message}`);
            void logError(error, { scope: 'app', step: label });
        };

        const setup = async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const { invoke } = await import('@tauri-apps/api/core');
            const nextUnlisten = await listen('close-requested', async () => {
                await invoke('acknowledge_close_request').catch((error) => {
                    void logError(error, { scope: 'app', step: 'acknowledgeCloseRequest' });
                });
                await handleDesktopCloseRequest({
                    getWindowSettings: () => useTaskStore.getState().settings?.window,
                    hideToTray,
                    isFlatpak,
                    promptOpenRef: closePromptOpenRef,
                    quitApp,
                    reportCloseError,
                    setPromptOpen: setClosePromptOpenValue,
                    setPromptRemember: setClosePromptRememberValue,
                });
            });
            if (disposed) {
                nextUnlisten();
                return;
            }
            unlisten = nextUnlisten;
        };

        setup().catch((error) => reportCloseError('Close listener failed', error));

        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [hideToTray, isFlatpak, quitApp, setClosePromptOpenValue, setClosePromptRememberValue, setError]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (windowDecorations === undefined) return;
        if (!/linux/i.test(navigator.userAgent || '')) return;
        let cancelled = false;
        import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => {
                if (cancelled) return;
                return getCurrentWindow().setDecorations(windowDecorations);
            })
            .catch((error) => void logError(error, { scope: 'window', step: 'setDecorations' }));
        return () => {
            cancelled = true;
        };
    }, [windowDecorations]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        let cancelled = false;
        let unlistenResize: (() => void) | undefined;

        const syncFullscreenState = async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const isFullscreen = await getCurrentWindow().isFullscreen();
            if (!cancelled) {
                saveStoredFullscreen(isFullscreen, localStorage);
            }
        };

        const setup = async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const current = getCurrentWindow();
            await syncFullscreenState();
            const nextUnlisten = await current.onResized(() => {
                void syncFullscreenState().catch((error) => {
                    void logError(error, { scope: 'window', step: 'syncFullscreenState' });
                });
            });
            if (cancelled) {
                nextUnlisten();
                return;
            }
            unlistenResize = nextUnlisten;
        };

        setup().catch((error) => void logError(error, { scope: 'window', step: 'setupFullscreenSync' }));

        return () => {
            cancelled = true;
            if (unlistenResize) unlistenResize();
        };
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        return installWebviewZoomShortcuts({
            storage: localStorage,
            onError: (error) => void logError(error, { scope: 'window', step: 'setWebviewZoom' }),
        });
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (!isObsidianEnabled || !obsidianVaultPath) {
            void stopObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'stopWatcher' }));
            return;
        }

        void startObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'startWatcher' }));

        return () => {
            void stopObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'stopWatcher' }));
        };
    }, [isObsidianEnabled, obsidianVaultPath, startObsidianWatcher, stopObsidianWatcher]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (showTray === undefined) return;
        let cancelled = false;
        import('@tauri-apps/api/core')
            .then(async ({ invoke }) => {
                if (cancelled) return;
                await invoke('set_tray_visible', { visible: showTray !== false });
            })
            .catch((error) => void logError(error, { scope: 'tray', step: 'setVisible' }));
        return () => {
            cancelled = true;
        };
    }, [showTray]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        const hideFromDock = closeBehavior === 'tray' && showTray !== false;
        let cancelled = false;
        import('@tauri-apps/api/core')
            .then(async ({ invoke }) => {
                if (cancelled) return;
                await invoke('set_macos_activation_policy', { accessory: hideFromDock });
            })
            .catch((error) => void logError(error, { scope: 'window', step: 'setActivationPolicy' }));
        return () => {
            cancelled = true;
        };
    }, [closeBehavior, showTray]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        // Settings is frequently opened from menu actions; preload it eagerly to avoid first-open delay.
        void import('./components/views/SettingsView');
        const idleCallback =
            (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
            ?? ((cb: () => void) => window.setTimeout(cb, 200));
        const idleCancel =
            (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
            ?? ((id: number) => window.clearTimeout(id));
        const id = idleCallback(() => {
            void import('./components/views/BoardView');
            void import('./components/views/ObsidianView');
            if (!import.meta.env.DEV) {
                void import('./components/views/ProjectsView');
            }
            void import('./components/views/ReviewView');
        });
        return () => idleCancel(id);
    }, []);

    const renderView = () => {
        if (activeView.startsWith('savedSearch:')) {
            const savedSearchId = activeView.replace('savedSearch:', '');
            return <SearchView savedSearchId={savedSearchId} />;
        }
        switch (activeView) {
            case 'inbox':
                return <ListView title={t('list.inbox')} statusFilter="inbox" />;
            case 'agenda':
                return <AgendaView />;
            case 'next':
                return <AgendaView />;
            case 'someday':
                return <ListView title={t('list.someday')} statusFilter="someday" />;
            case 'reference':
                return <ListView title={t('list.reference')} statusFilter="reference" />;
            case 'waiting':
                return <ListView title={t('list.waiting')} statusFilter="waiting" />;
            case 'ai-agent':
                // AI Agent lane: surfaces tasks the Enricher delegated to
                // the agent (assignedTo='@ai-agent'). Status stays honest
                // (next/waiting/etc per GTD); this view is just a saved
                // filter over `assignedTo` so delegated tasks don't pollute
                // the user's real Next list.
                return <ListView title="AI Agent" statusFilter="all" assignedToFilter="@ai-agent" />;
            case 'done':
                return <ListView title={t('list.done')} statusFilter="done" />;
            case 'calendar':
                return <CalendarView />;
            case 'board':
                return <BoardView />;
            case 'obsidian':
                return <ObsidianView />;
            case 'projects':
                return <ProjectsView />;
            case 'contexts':
                return <ContextsView />;
            case 'review':
                return <ReviewView />;
            case 'ai-playbook':
                return <ProceduralPlaybookView />;
            case 'glossary-onboarding':
                return <GlossaryOnboardingView />;
            case 'control-center':
                return <ControlCenterView />;
            case 'settings':
                return (
                    <SettingsView
                        initialPage={settingsInitialPage}
                        onboardingHintPage={settingsOnboardingHintPage}
                        onResumeOnboarding={resumeDesktopOnboarding}
                    />
                );
            case 'archived':
                return <ArchiveView />;
            case 'trash':
                return <TrashView />;
            default:
                return <ListView title={t('list.inbox')} statusFilter="inbox" />;
        }
    };

    const handleViewChange = useCallback((view: string) => {
        const nextView = view === 'obsidian' && !useObsidianStore.getState().config.enabled ? 'settings' : view;
        if (nextView !== 'settings') {
            setSettingsInitialPage(undefined);
            setSettingsOnboardingHintPage(undefined);
        }
        setCurrentView(nextView);
        if (nextView === 'settings') {
            beginSettingsOpenTrace('handleViewChange');
            setActiveView(nextView);
            return;
        }
        startTransition(() => {
            setActiveView(nextView);
        });
    }, [startTransition]);

    useEffect(() => {
        if (isObsidianEnabled || currentView !== 'obsidian') return;
        handleViewChange('settings');
    }, [currentView, handleViewChange, isObsidianEnabled]);

    useEffect(() => {
        if (!hasHydratedSettings || isLoading) return;
        if (desktopOnboardingDismissed || visibleDataCount > 0) {
            setDesktopOnboardingGateSettled(true);
            return;
        }

        let cancelled = false;
        setDesktopOnboardingGateSettled(false);
        SyncService.getSyncBackend()
            .then((backend) => {
                if (cancelled) return;
                if (shouldOpenDesktopFirstRunOnboarding({
                    hasHydratedSettings,
                    isLoading,
                    dismissed: desktopOnboardingDismissed,
                    visibleDataCount,
                    syncBackend: backend,
                })) {
                    setDesktopOnboardingOpen(true);
                }
                setDesktopOnboardingGateSettled(true);
            })
            .catch((error) => {
                void logError(error, { scope: 'onboarding', step: 'readSyncBackend' });
                if (!cancelled && shouldOpenDesktopFirstRunOnboarding({
                    hasHydratedSettings,
                    isLoading,
                    dismissed: desktopOnboardingDismissed,
                    visibleDataCount,
                    syncBackend: 'off',
                })) {
                    setDesktopOnboardingOpen(true);
                }
                if (!cancelled) {
                    setDesktopOnboardingGateSettled(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [desktopOnboardingDismissed, hasHydratedSettings, isLoading, visibleDataCount]);

    const dismissDesktopOnboarding = useCallback(() => {
        writeDesktopOnboardingDismissed();
        setDesktopOnboardingDismissed(true);
        setDesktopOnboardingOpen(false);
    }, []);

    const resumeDesktopOnboarding = useCallback(() => {
        setDesktopOnboardingBusy(false);
        setDesktopOnboardingError(null);
        setDesktopOnboardingDismissed(false);
        setDesktopOnboardingOpen(true);
    }, []);

    const openSettingsPage = useCallback((page: SettingsOnboardingHintPage) => {
        setDesktopOnboardingOpen(false);
        setSettingsInitialPage(page);
        setSettingsOnboardingHintPage(page);
        handleViewChange('settings');
    }, [handleViewChange]);

    const handleStartFreshOnboarding = useCallback(() => {
        if (desktopOnboardingBusy) return;
        setDesktopOnboardingBusy(true);
        setDesktopOnboardingError(null);
        seedGettingStarted()
            .then((result) => {
                if (!result.id) {
                    setDesktopOnboardingError('Getting Started was not created. Try again or import your data instead.');
                    showToast('Getting Started was not created.', 'info');
                    return;
                }
                dismissDesktopOnboarding();
                useUiStore.getState().setProjectView({ selectedProjectId: result.id });
                handleViewChange('projects');
                showToast('Getting Started is ready in Projects.', 'success');
            })
            .catch((error) => {
                setDesktopOnboardingError('Failed to create Getting Started onboarding. Try again, or use Import/Sync instead.');
                showToast('Failed to create Getting Started onboarding.', 'error');
                void logError(error, { scope: 'onboarding', step: 'seedGettingStarted' });
            })
            .finally(() => setDesktopOnboardingBusy(false));
    }, [desktopOnboardingBusy, dismissDesktopOnboarding, handleViewChange, seedGettingStarted, showToast]);

    const dismissAppAnnouncement = useCallback(() => {
        if (testAnnouncement) {
            setTestAnnouncement(null);
            setAnnouncementOpen(false);
            return;
        }
        const announcement = ACTIVE_APP_ANNOUNCEMENT;
        if (announcement && typeof window !== 'undefined') {
            try {
                window.localStorage.setItem(
                    getAnnouncementDismissalStorageKey(announcement.id),
                    APP_ANNOUNCEMENT_DISMISSED_VALUE,
                );
            } catch {
                // Keep the in-memory dismissal for this session when localStorage is unavailable.
            }
        }
        setAnnouncementDismissedInSession(true);
        setAnnouncementOpen(false);
    }, [testAnnouncement]);

    const openAnnouncementUrl = useCallback(async (url: string) => {
        const nextUrl = url.trim();
        if (!nextUrl) return;
        let openError: unknown = null;
        if (isTauriRuntime()) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(nextUrl);
                return;
            } catch (error) {
                openError = error;
            }
        }

        const opened = window.open(nextUrl, '_blank', 'noopener,noreferrer');
        if (!opened) {
            void logError(openError ?? new Error('Failed to open announcement link'), {
                scope: 'announcement',
                step: 'openUrl',
            });
        }
    }, []);

    const handleAppAnnouncementAction = useCallback((action: AppAnnouncementAction) => {
        dismissAppAnnouncement();
        if (action.type === 'feedback') {
            setSettingsInitialPage('about');
            setSettingsOnboardingHintPage(undefined);
            handleViewChange('settings');
            return;
        }
        void openAnnouncementUrl(action.url);
    }, [dismissAppAnnouncement, handleViewChange, openAnnouncementUrl]);

    const dismissDonationPrompt = useCallback(() => {
        setDonationDismissedInSession(true);
        setDonationPromptOpen(false);
    }, []);

    const handleDonationPromptAction = useCallback((action: AppAnnouncementAction) => {
        dismissDonationPrompt();
        if (action.type === 'feedback') {
            setSettingsInitialPage('about');
            setSettingsOnboardingHintPage(undefined);
            handleViewChange('settings');
            return;
        }
        try {
            updateLocalUserPromptState((state) => recordDonationPromptSupportClicked(state, Date.now()));
        } catch (error) {
            void logError(error, { scope: 'prompt-state', step: 'recordDonationSupportClicked' });
        }
        void openAnnouncementUrl(action.url);
    }, [dismissDonationPrompt, handleViewChange, openAnnouncementUrl]);

    const recordDonationPromptVisible = useCallback(() => {
        try {
            updateLocalUserPromptState((state) => recordDonationPromptShown(state, Date.now()));
        } catch (error) {
            void logError(error, { scope: 'prompt-state', step: 'recordDonationShown' });
        }
    }, []);

    const dismissUpdateReminder = useCallback(() => {
        const latestVersion = updateReminderInfo?.latestVersion;
        if (latestVersion && updateReminderInfo?.testOnly !== true) {
            try {
                updateLocalUserPromptState((state) => recordUpdateReminderDismissed(state, latestVersion));
            } catch (error) {
                void logError(error, { scope: 'prompt-state', step: 'dismissUpdateReminder' });
            }
        }
        setUpdateReminderDismissedInSession(true);
        setUpdateReminderOpen(false);
    }, [updateReminderInfo?.latestVersion, updateReminderInfo?.testOnly]);

    const handleUpdateReminderAction = useCallback((action: AppAnnouncementAction) => {
        dismissUpdateReminder();
        if (action.type === 'feedback') {
            setSettingsInitialPage('about');
            setSettingsOnboardingHintPage(undefined);
            handleViewChange('settings');
            return;
        }
        void openAnnouncementUrl(action.url);
    }, [dismissUpdateReminder, handleViewChange, openAnnouncementUrl]);

    useEffect(() => {
        if (!PROMPT_TEST_CONTROLS_ENABLED) return;
        let disposed = false;
        const closePromptSurfaces = () => {
            setAnnouncementOpen(false);
            setDonationPromptOpen(false);
            setUpdateReminderOpen(false);
            setTestAnnouncement(null);
        };

        const unsubscribe = subscribePromptTest((kind) => {
            closePromptSurfaces();
            if (kind === 'announcement') {
                setTestAnnouncement(PROMPT_TEST_ANNOUNCEMENT);
                setAnnouncementOpen(true);
                return;
            }
            if (kind === 'donation') {
                setDonationPromptOpen(true);
                return;
            }
            if (kind === 'review') {
                const reviewAnnouncement = buildPromptTestReviewAnnouncement(desktopInstallSource);
                if (!reviewAnnouncement) return;
                setTestAnnouncement(reviewAnnouncement);
                setAnnouncementOpen(true);
                return;
            }
            const openUpdateTest = async () => {
                let currentVersion = 'this build';
                try {
                    const { getVersion } = await import('@tauri-apps/api/app');
                    currentVersion = await getVersion();
                } catch {
                    currentVersion = 'this build';
                }
                if (disposed) return;
                const updateTarget = getDesktopUpdateTarget(desktopInstallSource);
                setUpdateReminderInfo({
                    currentVersion,
                    latestVersion: '99.99.99',
                    latestReleasedAt: new Date().toISOString(),
                    releaseUrl: updateTarget.url,
                    actionLabel: updateTarget.label,
                    testOnly: true,
                });
                setUpdateReminderOpen(true);
            };
            void openUpdateTest();
        });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [desktopInstallSource]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        if (
            announcementDismissedInSession
            || !hasHydratedSettings
            || isLoading
            || !desktopOnboardingGateSettled
            || desktopOnboardingOpen
            || closePromptOpen
            || externalSyncChange
        ) {
            return;
        }

        const announcement = ACTIVE_APP_ANNOUNCEMENT;
        if (!shouldShowAppAnnouncement(announcement, null)) return;

        let dismissedValue: string | null = null;
        try {
            dismissedValue = window.localStorage.getItem(getAnnouncementDismissalStorageKey(announcement.id));
        } catch {
            dismissedValue = null;
        }
        if (!shouldShowAppAnnouncement(announcement, dismissedValue)) return;

        const timer = window.setTimeout(() => setAnnouncementOpen(true), 250);
        return () => window.clearTimeout(timer);
    }, [
        announcementDismissedInSession,
        closePromptOpen,
        desktopOnboardingGateSettled,
        desktopOnboardingOpen,
        externalSyncChange,
        hasHydratedSettings,
        isLoading,
    ]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        if (localPromptActivityRecordedRef.current || !hasHydratedSettings || isLoading) return;
        localPromptActivityRecordedRef.current = true;
        try {
            recordLocalPromptActivity();
        } catch (error) {
            void logError(error, { scope: 'prompt-state', step: 'recordActivity' });
        }
    }, [hasHydratedSettings, isLoading]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        let cancelled = false;
        getInstallSourceOrFallback('unknown')
            .then((installSource) => {
                if (cancelled) return;
                const normalized = normalizeInstallSource(installSource);
                setDesktopInstallSource(normalized);
                setDonationPromptAllowed(isDesktopDonationPromptAllowed(normalized));
            })
            .catch((error) => {
                if (!cancelled) {
                    setDesktopInstallSource('unknown');
                    setDonationPromptAllowed(false);
                }
                void logError(error, { scope: 'prompt-state', step: 'resolveDonationInstallSource' });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        if (
            donationDismissedInSession
            || donationPromptOpen
            || updateReminderOpen
            || donationPromptAllowed !== true
            || ACTIVE_APP_ANNOUNCEMENT
            || announcementOpen
            || !hasHydratedSettings
            || isLoading
            || !desktopOnboardingGateSettled
            || desktopOnboardingOpen
            || closePromptOpen
            || externalSyncChange
        ) {
            return;
        }

        const nowMs = Date.now();
        let promptState: ReturnType<typeof readLocalUserPromptState>;
        try {
            promptState = readLocalUserPromptState();
        } catch (error) {
            setDonationDismissedInSession(true);
            void logError(error, { scope: 'prompt-state', step: 'readDonationPromptState' });
            return;
        }
        if (!shouldShowDonationPrompt({ nowMs, promptState, donationAllowed: true })) return;

        const timer = window.setTimeout(() => {
            setDonationPromptOpen(true);
        }, DONATION_PROMPT_STARTUP_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [
        announcementOpen,
        closePromptOpen,
        desktopOnboardingGateSettled,
        desktopOnboardingOpen,
        donationDismissedInSession,
        donationPromptAllowed,
        donationPromptOpen,
        externalSyncChange,
        hasHydratedSettings,
        isLoading,
        updateReminderOpen,
    ]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        if (
            updateReminderDismissedInSession
            || updateReminderOpen
            || !desktopInstallSource
            || !isDesktopUpdateReminderAllowed(desktopInstallSource)
            || ACTIVE_APP_ANNOUNCEMENT
            || announcementOpen
            || donationPromptOpen
            || !hasHydratedSettings
            || isLoading
            || !desktopOnboardingGateSettled
            || desktopOnboardingOpen
            || closePromptOpen
            || externalSyncChange
        ) {
            return;
        }

        const nowMs = Date.now();
        let promptState: ReturnType<typeof readLocalUserPromptState>;
        try {
            promptState = readLocalUserPromptState();
        } catch (error) {
            setUpdateReminderDismissedInSession(true);
            void logError(error, { scope: 'prompt-state', step: 'readUpdateReminderState' });
            return;
        }
        if (!shouldCheckUpdateReminder({ nowMs, promptState, updateReminderAllowed: true })) return;
        try {
            updateLocalUserPromptState((state) => recordUpdateReminderChecked(state, nowMs));
        } catch (error) {
            setUpdateReminderDismissedInSession(true);
            void logError(error, { scope: 'prompt-state', step: 'recordUpdateReminderChecked' });
            return;
        }

        let cancelled = false;
        const timer = window.setTimeout(() => {
            const check = async () => {
                const { getVersion } = await import('@tauri-apps/api/app');
                const currentVersion = await getVersion();
                const info = await checkForUpdates(currentVersion, { installSource: desktopInstallSource });
                if (cancelled || !info.hasUpdate) return;
                const latestPromptState = readLocalUserPromptState();
                if (!shouldShowUpdateReminder({
                    nowMs: Date.now(),
                    promptState: latestPromptState,
                    updateReminderAllowed: true,
                    currentVersion: info.currentVersion,
                    latestVersion: info.latestVersion,
                    latestReleasedAt: info.latestReleasedAt,
                })) {
                    return;
                }
                updateLocalUserPromptState((state) => recordUpdateReminderShown(state, Date.now()));
                if (cancelled) return;
                const updateTarget = getDesktopUpdateTarget(desktopInstallSource);
                setUpdateReminderInfo({
                    currentVersion: info.currentVersion,
                    latestVersion: info.latestVersion,
                    latestReleasedAt: info.latestReleasedAt,
                    releaseUrl: updateTarget.url,
                    actionLabel: updateTarget.label,
                });
                setUpdateReminderOpen(true);
            };
            check().catch((error) => {
                if (!cancelled) setUpdateReminderDismissedInSession(true);
                void logError(error, { scope: 'prompt-state', step: 'checkUpdateReminder' });
            });
        }, 1750);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        announcementOpen,
        closePromptOpen,
        desktopInstallSource,
        desktopOnboardingGateSettled,
        desktopOnboardingOpen,
        donationPromptOpen,
        externalSyncChange,
        hasHydratedSettings,
        isLoading,
        updateReminderDismissedInSession,
        updateReminderOpen,
    ]);

    const LoadingFallback = ({ view }: { view: string }) => {
        useEffect(() => {
            if (view !== 'settings') return;
            markSettingsOpenTrace('app-suspense-fallback-mounted');
        }, [view]);

        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <div className="w-full max-w-md space-y-3">
                    <div className="h-4 w-2/3 rounded bg-muted/60 animate-pulse" />
                    <div className="h-4 w-5/6 rounded bg-muted/50 animate-pulse" />
                    <div className="h-4 w-1/2 rounded bg-muted/40 animate-pulse" />
                </div>
            </div>
        );
    };

    useEffect(() => {
        return subscribeNavigateEvent(({ view }) => {
            handleViewChange(view);
        });
    }, [handleViewChange]);

    useEffect(() => {
        return subscribeDesktopOnboardingEvent(() => {
            resumeDesktopOnboarding();
        });
    }, [resumeDesktopOnboarding]);

    return (
        <ErrorBoundary>
            <KeybindingProvider currentView={currentView} onNavigate={handleViewChange}>
                <Layout currentView={currentView} onViewChange={handleViewChange}>
                    <Suspense
                        fallback={(
                            <LoadingFallback view={activeView} />
                        )}
                    >
                        {isLoading ? (
                            <LoadingFallback view={activeView} />
                        ) : (
                            renderView()
                        )}
                    </Suspense>
                    <GlobalSearch onNavigate={(view, _id) => handleViewChange(view)} />
                    <QuickAddModal />
                    <CloseBehaviorModal
                        isOpen={closePromptOpen}
                        title={translateOrFallback('settings.closeBehaviorPromptTitle', 'Close Mindwtr?')}
                        description={translateOrFallback(
                            'settings.closeBehaviorPromptBody',
                            'Do you want Mindwtr to stay running in the tray or quit completely?'
                        )}
                        rememberLabel={translateOrFallback('settings.closeBehaviorRemember', "Don't ask again")}
                        stayLabel={translateOrFallback('settings.closeBehaviorTray', 'Keep running in tray')}
                        quitLabel={translateOrFallback('settings.closeBehaviorQuit', 'Quit the app')}
                        cancelLabel={translateOrFallback('common.cancel', 'Cancel')}
                        remember={closePromptRemember}
                        onRememberChange={setClosePromptRememberValue}
                        onCancel={() => setClosePromptOpenValue(false)}
                        onStay={() => {
                            const apply = async () => {
                                if (closePromptRememberRef.current) {
                                    await persistCloseBehavior('tray');
                                }
                                setClosePromptOpenValue(false);
                                await hideToTray();
                            };
                            apply().catch((error) => {
                                setClosePromptOpenValue(false);
                                void logError(error, { scope: 'app', step: 'close-tray' });
                            });
                        }}
                        onQuit={() => {
                            const apply = async () => {
                                if (closePromptRememberRef.current) {
                                    await persistCloseBehavior('quit');
                                }
                                setClosePromptOpenValue(false);
                                await quitApp();
                            };
                            apply().catch((error) => {
                                setClosePromptOpenValue(false);
                                void logError(error, { scope: 'app', step: 'close-quit' });
                            });
                        }}
                    />
                    <DesktopOnboardingFlow
                        isOpen={desktopOnboardingOpen}
                        busy={desktopOnboardingBusy}
                        error={desktopOnboardingError}
                        onOpenSync={() => openSettingsPage('sync')}
                        onOpenImport={() => openSettingsPage('data')}
                        onStartFresh={handleStartFreshOnboarding}
                        onSkip={dismissDesktopOnboarding}
                    />
                    <AppAnnouncementModal
                        announcement={activeAnnouncement}
                        isOpen={
                            announcementOpen
                            && !desktopOnboardingOpen
                            && !closePromptOpen
                            && !externalSyncChange
                        }
                        onAction={handleAppAnnouncementAction}
                        onDismiss={dismissAppAnnouncement}
                    />
                    <AppAnnouncementModal
                        announcement={donationPromptAnnouncement}
                        isOpen={
                            donationPromptOpen
                            && !announcementOpen
                            && !desktopOnboardingOpen
                            && !closePromptOpen
                            && !externalSyncChange
                        }
                        onAction={handleDonationPromptAction}
                        onDismiss={dismissDonationPrompt}
                        onShown={recordDonationPromptVisible}
                    />
                    <AppAnnouncementModal
                        announcement={updateReminderInfo ? buildUpdateReminderAnnouncement(updateReminderInfo) : null}
                        isOpen={
                            updateReminderOpen
                            && !announcementOpen
                            && !donationPromptOpen
                            && !desktopOnboardingOpen
                            && !closePromptOpen
                            && !externalSyncChange
                        }
                        onAction={handleUpdateReminderAction}
                        onDismiss={dismissUpdateReminder}
                    />
                    {externalSyncChange && (
                        <ModalPortal>
                        <div
                            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
                            role="dialog"
                            aria-modal="true"
                            onClick={() => !resolvingExternalSync && setExternalSyncChange(null)}
                        >
                            <div
                                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="px-4 py-3 border-b">
                                    <h3 className="font-semibold">
                                        {translateOrFallback('settings.externalSyncChangeTitle', 'External sync change detected')}
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {translateOrFallback(
                                            'settings.externalSyncChangeBody',
                                            'The sync file changed while local edits were pending. Choose how to continue.'
                                        )}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-2">
                                        {translateOrFallback('settings.lastSync', 'Last sync')}: {externalSyncChange.lastSyncAt || translateOrFallback('settings.lastSyncNever', 'Never')}
                                    </p>
                                </div>
                                <div className="p-4 flex flex-wrap justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setExternalSyncChange(null)}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('common.reviewLater', 'Review later')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('use-external')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.useExternal', 'Use external')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('merge')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-secondary text-secondary-foreground hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.mergeChanges', 'Merge')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('keep-local')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.keepLocal', 'Keep local')}
                                    </button>
                                </div>
                            </div>
                        </div>
                        </ModalPortal>
                    )}
                </Layout>
            </KeybindingProvider>
        </ErrorBoundary>
    );
}

export default App;
