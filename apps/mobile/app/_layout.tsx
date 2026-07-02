import '../polyfills';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Stack, usePathname, useRouter } from 'expo-router';
import 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BackHandler, Platform, SafeAreaView, StatusBar, Text, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { QuickCaptureProvider, type QuickCaptureOptions } from '../contexts/quick-capture-context';
import { ToastProvider, useToast } from '../contexts/toast-context';

import { ThemeProvider, useTheme } from '../contexts/theme-context';
import { LanguageProvider, useLanguage } from '../contexts/language-context';
import {
  ACTIVE_APP_ANNOUNCEMENT,
  APP_ANNOUNCEMENT_DISMISSED_VALUE,
  DONATION_PROMPT_ANNOUNCEMENT,
  addBreadcrumb,
  consoleLogger,
  configureDateFormatting,
  getAnnouncementDismissalStorageKey,
  isSupportedLanguage,
  recordDonationPromptShown,
  recordDonationPromptSupportClicked,
  recordUpdateReminderChecked,
  recordUpdateReminderDismissed,
  recordUpdateReminderShown,
  setStorageAdapter,
  setLogger,
  shouldCheckUpdateReminder,
  shouldShowAppAnnouncement,
  shouldShowDonationPrompt,
  shouldShowUpdateReminder,
  translateWithFallback,
  useTaskStore,
  type AppAnnouncement,
  type AppAnnouncementAction,
} from '@mindwtr/core';
import { mobileStorage } from '../lib/storage-adapter';
import { markStartupPhase } from '../lib/startup-profiler';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { logError, logInfo, logWarn, setupGlobalErrorLogging } from '../lib/app-log';
import { useThemeColors } from '../hooks/use-theme-colors';
import { useRootLayoutContextAutomation } from '@/hooks/root-layout/use-root-layout-context-automation';
import { useRootLayoutExternalCapture } from '@/hooks/root-layout/use-root-layout-external-capture';
import { useRootLayoutNotificationOpenHandler } from '@/hooks/root-layout/use-root-layout-notification-open-handler';
import { useRootLayoutStartup } from '@/hooks/root-layout/use-root-layout-startup';
import { resolveMobileAnalyticsVersion } from '@/lib/analytics-heartbeat';
import { useRootLayoutSyncEffects } from '@/hooks/root-layout/use-root-layout-sync-effects';
import { ProjectNextActionPromptProvider } from '@/components/project-next-action-prompt';
import { ThemedAlertProvider } from '@/components/themed-alert';
import { AppAnnouncementModal } from '@/components/app-announcement-modal';
import { MobileOnboardingFlow } from '@/components/MobileOnboardingFlow';
import { MobileAppLockGate } from '@/components/mobile-app-lock-gate';
import { applyAndroidSystemBars } from '@/lib/android-system-bars';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
  readLocalUserPromptState,
  recordLocalPromptActivity,
  updateLocalUserPromptState,
} from '@/lib/user-prompt-state';
import { subscribePromptTest } from '@/lib/prompt-test-controls';
import { requestStoreReviewForTesting } from '@/lib/store-review-prompt';
import {
  readMobileOnboardingDismissed,
  shouldOpenMobileFirstRunOnboarding,
  subscribeMobileOnboardingEvent,
  writeMobileOnboardingDismissed,
} from '@/lib/mobile-onboarding-events';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { coerceSupportedBackend, resolveBackend } from '@/lib/sync-service-utils';

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

type MobileExtraConfig = {
  isFossBuild?: boolean | string;
  analyticsHeartbeatUrl?: string;
  analyticsHeartbeatChannel?: string;
  analyticsReleaseVersion?: string;
  donationPromptEnabled?: boolean | string;
  promptTestControlsEnabled?: boolean | string;
};

const parseBool = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

const resolveMobileDonationPromptAllowed = async (options: {
  isExpoGo: boolean;
  donationPromptEnabled: boolean;
}): Promise<boolean> => {
  if (!options.donationPromptEnabled) return false;
  if (options.isExpoGo) return false;
  return Platform.OS === 'android' || Platform.OS === 'ios';
};

const DONATION_PROMPT_STARTUP_DELAY_MS = 2000;
const UPDATE_REMINDER_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
const UPDATE_REMINDER_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
const APP_STORE_APP_ID = '6758597144';
const APP_STORE_REVIEW_URL = `itms-apps://itunes.apple.com/app/id${APP_STORE_APP_ID}?action=write-review`;
const APP_STORE_LISTING_URL = `https://apps.apple.com/app/mindwtr/id${APP_STORE_APP_ID}`;
const UPDATE_NOW_ACTION_LABEL = 'Update now';
const VIEW_RELEASE_ACTION_LABEL = 'View release';

type MobileUpdateReminderInfo = {
  currentVersion: string;
  latestVersion: string;
  latestReleasedAt: string | null;
  releaseUrl: string;
  actionLabel?: string;
  testOnly?: boolean;
};

type AndroidInstallerSource = 'play-store' | 'sideload' | 'unknown';

type GitHubLatestRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
};

const resolveMobileUpdateReminderAllowed = async (options: {
  androidInstallerSource: AndroidInstallerSource;
  isExpoGo: boolean;
  isFossBuild: boolean;
}): Promise<boolean> => {
  if (options.isExpoGo) return false;
  if (Platform.OS !== 'android') return false;
  if (options.isFossBuild) return false;
  return options.androidInstallerSource === 'sideload';
};

const fetchMobileUpdateReminderInfo = async (currentVersion: string): Promise<MobileUpdateReminderInfo> => {
  const response = await fetch(UPDATE_REMINDER_RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Mindwtr-App',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }
  const release = await response.json() as GitHubLatestRelease;
  const latestVersion = String(release.tag_name || '').trim().replace(/^v/i, '');
  if (!latestVersion) throw new Error('GitHub release returned no version');
  return {
    currentVersion,
    latestVersion,
    latestReleasedAt: typeof release.published_at === 'string' ? release.published_at : null,
    releaseUrl: typeof release.html_url === 'string' && release.html_url.trim()
      ? release.html_url.trim()
      : UPDATE_REMINDER_RELEASES_URL,
    actionLabel: UPDATE_NOW_ACTION_LABEL,
  };
};

const buildUpdateReminderAnnouncement = (info: MobileUpdateReminderInfo): AppAnnouncement => ({
  id: `update-reminder-${info.latestVersion}`,
  title: 'Update available',
  body: `Mindwtr ${info.latestVersion} is available. You are using ${info.currentVersion}. Update when you have a minute to keep fixes and improvements current.`,
  action: {
    type: 'url',
    label: info.actionLabel ?? VIEW_RELEASE_ACTION_LABEL,
    url: info.releaseUrl,
  },
});

const getAndroidPackageName = (): string => (
  Constants.expoConfig?.android?.package || Application.applicationId || 'tech.dongdongbh.mindwtr'
);

const getGooglePlayListingUrl = (): string => (
  `https://play.google.com/store/apps/details?id=${getAndroidPackageName()}`
);

const openMobileStoreReviewDestination = async (): Promise<boolean> => {
  if (Platform.OS === 'android') {
    const packageName = getAndroidPackageName();
    const marketUrl = `market://details?id=${packageName}`;
    const webUrl = getGooglePlayListingUrl();
    try {
      await Linking.openURL(marketUrl);
      return true;
    } catch {
      await Linking.openURL(webUrl);
      return true;
    }
  }

  if (Platform.OS === 'ios') {
    try {
      await Linking.openURL(APP_STORE_REVIEW_URL);
      return true;
    } catch {
      await Linking.openURL(APP_STORE_LISTING_URL);
      return true;
    }
  }

  return false;
};

const getMobileUpdateTestTarget = (options: {
  androidInstallerSource: AndroidInstallerSource;
  isFossBuild: boolean;
}): { label: string; url: string } | null => {
  if (options.isFossBuild) return null;
  if (Platform.OS === 'ios') {
    return { label: UPDATE_NOW_ACTION_LABEL, url: APP_STORE_LISTING_URL };
  }
  if (Platform.OS === 'android' && options.androidInstallerSource === 'play-store') {
    return {
      label: UPDATE_NOW_ACTION_LABEL,
      url: getGooglePlayListingUrl(),
    };
  }
  if (Platform.OS === 'android' && options.androidInstallerSource === 'sideload') {
    return { label: UPDATE_NOW_ACTION_LABEL, url: UPDATE_REMINDER_RELEASES_URL };
  }
  return { label: VIEW_RELEASE_ACTION_LABEL, url: UPDATE_REMINDER_RELEASES_URL };
};

const PROMPT_TEST_ANNOUNCEMENT: AppAnnouncement = {
  id: 'prompt-test-announcement',
  title: 'Test announcement',
  body: 'This is the temporary announcement template test. It uses the same popup surface as a real maintainer announcement.',
};

const getDeviceLocale = (): string => {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
};

const getViewBreadcrumb = (pathname: string | null): string | null => {
  const trimmed = String(pathname || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\/+|\/+$/g, '');
  if (!normalized) return 'view:root';
  const segments = normalized.split('/').filter(Boolean);
  const view = segments[segments.length - 1] || 'root';
  return `view:${view}`;
};

// Initialize storage for mobile
let storageInitError: Error | null = null;

installCoreLoggerBridge();

try {
  setStorageAdapter(mobileStorage);
} catch (e) {
  storageInitError = e as Error;
  void logError(e, { scope: 'app', extra: { message: 'Failed to initialize storage adapter' } });
}

// Keep splash visible until app is ready.
void SplashScreen.preventAutoHideAsync().catch(() => {});
markStartupPhase('js.root_layout.module_loaded');

function RootLayoutContent() {
  const tc = useThemeColors();

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: tc.bg }}>
      <ToastProvider>
        <ThemedAlertProvider>
          <ProjectNextActionPromptProvider>
            <RootLayoutContentInner />
          </ProjectNextActionPromptProvider>
        </ThemedAlertProvider>
      </ToastProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutContentInner() {
  const router = useRouter();
  const pathname = usePathname();
  const incomingUrl = Linking.useURL();
  const { isDark, isReady: themeReady } = useTheme();
  const tc = useThemeColors();
  const { language, setLanguage, isReady: languageReady, t } = useLanguage();
  const { showToast } = useToast();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
  const isFossBuild = parseBool(extraConfig?.isFossBuild);
  const analyticsHeartbeatUrl = String(extraConfig?.analyticsHeartbeatUrl || '').trim();
  const analyticsHeartbeatChannel = String(extraConfig?.analyticsHeartbeatChannel || '').trim();
  const analyticsReleaseVersion = String(extraConfig?.analyticsReleaseVersion || '').trim();
  const donationPromptEnabled = parseBool(extraConfig?.donationPromptEnabled);
  const promptTestControlsEnabled = process.env.NODE_ENV !== 'test'
    && (__DEV__ || parseBool(extraConfig?.promptTestControlsEnabled));
  const isExpoGo = Constants.appOwnership === 'expo';
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const analyticsAppVersion = resolveMobileAnalyticsVersion(appVersion, analyticsReleaseVersion);
  const settingsLanguage = useTaskStore((state) => state.settings?.language);
  const settingsDateFormat = useTaskStore((state) => state.settings?.dateFormat);
  const settingsCalendarSystem = useTaskStore((state) => state.settings?.calendarSystem);
  const settingsTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
  const mobileAppLockEnabled = useTaskStore((state) => state.settings?.security?.mobileAppLockEnabled === true);
  const seedGettingStarted = useTaskStore((state) => state.seedGettingStarted);
  const visibleDataCount = useTaskStore((state) => (
    state.tasks.length + state.projects.length + state.sections.length + state.areas.length
  ));
  const firstRenderLogged = useRef(false);
  const [mobileOnboardingDismissed, setMobileOnboardingDismissed] = useState(false);
  const [mobileOnboardingDismissalLoaded, setMobileOnboardingDismissalLoaded] = useState(false);
  const [mobileOnboardingOpen, setMobileOnboardingOpen] = useState(false);
  const [mobileOnboardingBusy, setMobileOnboardingBusy] = useState(false);
  const [mobileOnboardingError, setMobileOnboardingError] = useState<string | null>(null);
  const [mobileOnboardingGateSettled, setMobileOnboardingGateSettled] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [announcementDismissedInSession, setAnnouncementDismissedInSession] = useState(false);
  const [donationPromptOpen, setDonationPromptOpen] = useState(false);
  const [donationDismissedInSession, setDonationDismissedInSession] = useState(false);
  const [donationPromptAllowed, setDonationPromptAllowed] = useState<boolean | null>(null);
  const [updateReminderOpen, setUpdateReminderOpen] = useState(false);
  const [updateReminderDismissedInSession, setUpdateReminderDismissedInSession] = useState(false);
  const [updateReminderAllowed, setUpdateReminderAllowed] = useState<boolean | null>(null);
  const [updateReminderInfo, setUpdateReminderInfo] = useState<MobileUpdateReminderInfo | null>(null);
  const [androidInstallerSource, setAndroidInstallerSource] = useState<AndroidInstallerSource>(
    Platform.OS === 'android' ? 'unknown' : 'play-store'
  );
  const [testAnnouncement, setTestAnnouncement] = useState<AppAnnouncement | null>(null);
  const [promptActivitySettled, setPromptActivitySettled] = useState(false);
  const activeAnnouncement = testAnnouncement ?? ACTIVE_APP_ANNOUNCEMENT;

  const resolveText = useCallback((key: string, fallback: string) => (
    translateWithFallback(t, key, fallback)
  ), [t]);

  const donationPromptAnnouncement = useMemo<AppAnnouncement>(() => ({
    ...DONATION_PROMPT_ANNOUNCEMENT,
    title: resolveText('donationPrompt.title', DONATION_PROMPT_ANNOUNCEMENT.title),
    body: resolveText('donationPrompt.body', DONATION_PROMPT_ANNOUNCEMENT.body),
    dismissLabel: resolveText(
      'donationPrompt.dismiss',
      DONATION_PROMPT_ANNOUNCEMENT.dismissLabel ?? DONATION_PROMPT_ANNOUNCEMENT.title,
    ),
    action: DONATION_PROMPT_ANNOUNCEMENT.action
      ? {
        ...DONATION_PROMPT_ANNOUNCEMENT.action,
        label: resolveText('donationPrompt.action', DONATION_PROMPT_ANNOUNCEMENT.action.label),
      }
      : undefined,
  }), [resolveText]);

  const buildQuickCaptureInitialProps = useCallback((initialProps?: QuickCaptureOptions['initialProps']) => {
    const nextInitialProps = initialProps ? { ...initialProps } : {};
    return Object.keys(nextInitialProps).length > 0 ? nextInitialProps : undefined;
  }, []);

  const openSyncSettings = useCallback(() => {
    router.push({ pathname: '/settings', params: { settingsScreen: 'sync' } } as never);
  }, [router]);

  const openNotificationsSettings = useCallback(() => {
    router.push({ pathname: '/settings', params: { settingsScreen: 'notifications' } } as never);
  }, [router]);

  const returnContextAutomationToBackground = useCallback(() => {
    if (Platform.OS === 'android') {
      BackHandler.exitApp();
    }
  }, []);

  const { requestSync } = useRootLayoutSyncEffects({
    resolveText,
    openNotificationsSettings,
    openSyncSettings,
    showToast,
  });
  const { dataReady } = useRootLayoutStartup({
    analyticsHeartbeatUrl,
    analyticsHeartbeatChannel,
    appVersion: analyticsAppVersion,
    isExpoGo,
    isFossBuild,
    requestSync,
    storageInitError,
  });
  const isShellReady = themeReady && languageReady;
  const isFirstPaintReady = isShellReady && (dataReady || Boolean(storageInitError));

  useRootLayoutNotificationOpenHandler({
    appReady: isFirstPaintReady,
    pathname,
    router,
  });
  useRootLayoutContextAutomation({
    dataReady,
    incomingUrl,
    returnToBackground: returnContextAutomationToBackground,
    resolveText,
  });
  useRootLayoutExternalCapture({
    dataReady,
    hasShareIntent,
    incomingUrl,
    resolveText,
    resetShareIntent,
    router,
    shareText: shareIntent?.text,
    shareWebUrl: shareIntent?.webUrl,
    showToast,
  });

  if (!firstRenderLogged.current) {
    firstRenderLogged.current = true;
    markStartupPhase('js.root_layout.first_render');
  }

  useEffect(() => {
    markStartupPhase('js.root_layout.mounted');
  }, []);

  useEffect(() => {
    setupGlobalErrorLogging();
  }, []);

  useEffect(() => {
    const breadcrumb = getViewBreadcrumb(pathname);
    if (!breadcrumb) return;
    addBreadcrumb(breadcrumb);
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android' || isExpoGo) return;
    SplashScreen.setOptions({ duration: 0, fade: false });
  }, [isExpoGo]);

  useEffect(() => {
    void applyAndroidSystemBars(tc, isDark);
  }, [isDark, tc.bg]);

  useEffect(() => {
    if (!settingsLanguage || !isSupportedLanguage(settingsLanguage)) return;
    if (settingsLanguage === language) return;
    void setLanguage(settingsLanguage);
  }, [language, settingsLanguage, setLanguage]);

  useEffect(() => {
    configureDateFormatting({
      language: settingsLanguage || language,
      dateFormat: settingsDateFormat,
      calendarSystem: settingsCalendarSystem,
      timeFormat: settingsTimeFormat,
      systemLocale: getDeviceLocale(),
    });
  }, [language, settingsCalendarSystem, settingsDateFormat, settingsLanguage, settingsTimeFormat]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      setAndroidInstallerSource('play-store');
      return;
    }
    if (isFossBuild) {
      setAndroidInstallerSource('sideload');
      return;
    }
    let cancelled = false;
    Application.getInstallReferrerAsync()
      .then((referrer) => {
        if (cancelled) return;
        setAndroidInstallerSource(String(referrer || '').trim() ? 'play-store' : 'sideload');
      })
      .catch((error) => {
        if (!cancelled) setAndroidInstallerSource('unknown');
        void logWarn('Failed to detect Android installer source', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isFossBuild]);

  useEffect(() => {
    let cancelled = false;
    readMobileOnboardingDismissed()
      .then((dismissed) => {
        if (cancelled) return;
        setMobileOnboardingDismissed(dismissed);
      })
      .finally(() => {
        if (!cancelled) setMobileOnboardingDismissalLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => subscribeMobileOnboardingEvent(() => {
    setMobileOnboardingBusy(false);
    setMobileOnboardingError(null);
    setMobileOnboardingOpen(true);
  }), []);

  useEffect(() => {
    if (
      !mobileOnboardingDismissalLoaded
      || !dataReady
    ) {
      return undefined;
    }
    if (mobileOnboardingDismissed || visibleDataCount > 0) {
      setMobileOnboardingGateSettled(true);
      return undefined;
    }

    let cancelled = false;
    setMobileOnboardingGateSettled(false);
    AsyncStorage.getItem(SYNC_BACKEND_KEY)
      .then((rawBackend) => {
        if (cancelled) return;
        const syncBackend = coerceSupportedBackend(resolveBackend(rawBackend), isCloudKitAvailable());
        if (shouldOpenMobileFirstRunOnboarding({
          dataReady,
          dismissed: mobileOnboardingDismissed,
          syncBackend,
          visibleDataCount,
        })) {
          setMobileOnboardingOpen(true);
        }
        setMobileOnboardingGateSettled(true);
      })
      .catch((error) => {
        void logError(error, { scope: 'onboarding', extra: { step: 'readMobileSyncBackend' } });
        if (cancelled) return;
        if (shouldOpenMobileFirstRunOnboarding({
          dataReady,
          dismissed: mobileOnboardingDismissed,
          syncBackend: 'off',
          visibleDataCount,
        })) {
          setMobileOnboardingOpen(true);
        }
        setMobileOnboardingGateSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [
    dataReady,
    mobileOnboardingDismissalLoaded,
    mobileOnboardingDismissed,
    visibleDataCount,
  ]);

  const dismissMobileOnboarding = useCallback(() => {
    void writeMobileOnboardingDismissed();
    setMobileOnboardingDismissed(true);
    setMobileOnboardingOpen(false);
    setMobileOnboardingError(null);
  }, []);

  const openOnboardingSync = useCallback(() => {
    setMobileOnboardingOpen(false);
    setMobileOnboardingError(null);
    router.push({
      pathname: '/settings',
      params: { settingsScreen: 'sync', onboardingHandoff: '1' },
    } as never);
  }, [router]);

  const openOnboardingImport = useCallback(() => {
    setMobileOnboardingOpen(false);
    setMobileOnboardingError(null);
    router.push({
      pathname: '/settings',
      params: { settingsScreen: 'data', onboardingHandoff: '1' },
    } as never);
  }, [router]);

  const startFreshOnboarding = useCallback(() => {
    if (mobileOnboardingBusy) return;
    setMobileOnboardingBusy(true);
    setMobileOnboardingError(null);
    seedGettingStarted()
      .then((result) => {
        if (!result.id) {
          setMobileOnboardingError('Getting Started was not created. Try again or import your data instead.');
          showToast({
            message: 'Getting Started was not created.',
            tone: 'info',
          });
          return;
        }
        dismissMobileOnboarding();
        router.push({ pathname: '/projects-screen', params: { projectId: result.id } } as never);
        showToast({
          message: 'Getting Started is ready in Projects.',
          tone: 'success',
        });
      })
      .catch((error) => {
        setMobileOnboardingError('Failed to create Getting Started onboarding. Try again, or use Import/Sync instead.');
        showToast({
          message: 'Failed to create Getting Started onboarding.',
          tone: 'error',
        });
        void logError(error, { scope: 'onboarding', extra: { step: 'seedGettingStarted' } });
      })
      .finally(() => setMobileOnboardingBusy(false));
  }, [
    dismissMobileOnboarding,
    mobileOnboardingBusy,
    router,
    seedGettingStarted,
    showToast,
  ]);

  const dismissAppAnnouncement = useCallback(() => {
    if (testAnnouncement) {
      setTestAnnouncement(null);
      setAnnouncementOpen(false);
      return;
    }
    const announcement = ACTIVE_APP_ANNOUNCEMENT;
    setAnnouncementDismissedInSession(true);
    setAnnouncementOpen(false);
    if (!announcement) return;
    AsyncStorage.setItem(
      getAnnouncementDismissalStorageKey(announcement.id),
      APP_ANNOUNCEMENT_DISMISSED_VALUE,
    ).catch((error) => {
      void logWarn('Failed to persist announcement dismissal', {
        scope: 'announcement',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }, [testAnnouncement]);

  const openAnnouncementUrl = useCallback((url: string) => {
    const nextUrl = url.trim();
    if (!nextUrl) return;
    Linking.openURL(nextUrl).catch((error) => {
      void logWarn('Failed to open announcement link', {
        scope: 'announcement',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }, []);

  const handleAppAnnouncementAction = useCallback((action: AppAnnouncementAction) => {
    dismissAppAnnouncement();
    if (action.type === 'feedback') {
      router.push({ pathname: '/settings', params: { settingsScreen: 'about' } } as never);
      return;
    }
    openAnnouncementUrl(action.url);
  }, [dismissAppAnnouncement, openAnnouncementUrl, router]);

  const dismissDonationPrompt = useCallback(() => {
    setDonationDismissedInSession(true);
    setDonationPromptOpen(false);
  }, []);

  const handleDonationPromptAction = useCallback((action: AppAnnouncementAction) => {
    dismissDonationPrompt();
    if (action.type === 'feedback') {
      router.push({ pathname: '/settings', params: { settingsScreen: 'about' } } as never);
      return;
    }
    updateLocalUserPromptState((state) => recordDonationPromptSupportClicked(state, Date.now()))
      .catch((error) => {
        void logWarn('Failed to record donation support action', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    openAnnouncementUrl(action.url);
  }, [dismissDonationPrompt, openAnnouncementUrl, router]);

  const recordDonationPromptVisible = useCallback(() => {
    updateLocalUserPromptState((state) => recordDonationPromptShown(state, Date.now()))
      .catch((error) => {
        void logWarn('Failed to record donation prompt state', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });
  }, []);

  const dismissUpdateReminder = useCallback(() => {
    const latestVersion = updateReminderInfo?.latestVersion;
    if (latestVersion && updateReminderInfo?.testOnly !== true) {
      updateLocalUserPromptState((state) => recordUpdateReminderDismissed(state, latestVersion))
        .catch((error) => {
          void logWarn('Failed to persist update reminder dismissal', {
            scope: 'prompt-state',
            extra: { error: error instanceof Error ? error.message : String(error) },
          });
        });
    }
    setUpdateReminderDismissedInSession(true);
    setUpdateReminderOpen(false);
  }, [updateReminderInfo?.latestVersion, updateReminderInfo?.testOnly]);

  const handleUpdateReminderAction = useCallback((action: AppAnnouncementAction) => {
    dismissUpdateReminder();
    if (action.type === 'feedback') {
      router.push({ pathname: '/settings', params: { settingsScreen: 'about' } } as never);
      return;
    }
    openAnnouncementUrl(action.url);
  }, [dismissUpdateReminder, openAnnouncementUrl, router]);

  useEffect(() => {
    if (!promptTestControlsEnabled) return;
    return subscribePromptTest((kind) => {
      setAnnouncementOpen(false);
      setDonationPromptOpen(false);
      setUpdateReminderOpen(false);
      setTestAnnouncement(null);

      if (kind === 'announcement') {
        setTestAnnouncement(PROMPT_TEST_ANNOUNCEMENT);
        setAnnouncementOpen(true);
        return;
      }
      if (kind === 'donation') {
        setDonationPromptOpen(true);
        return;
      }
      if (kind === 'update') {
        const updateTarget = getMobileUpdateTestTarget({ androidInstallerSource, isFossBuild });
        if (!updateTarget) {
          showToast({
            message: 'Updates are managed by this build channel.',
            tone: 'info',
          });
          return;
        }
        setUpdateReminderInfo({
          currentVersion: appVersion,
          latestVersion: '99.99.99',
          latestReleasedAt: new Date().toISOString(),
          releaseUrl: updateTarget.url,
          actionLabel: updateTarget.label,
          testOnly: true,
        });
        setUpdateReminderOpen(true);
        return;
      }
      if (isExpoGo) {
        showToast({
          message: 'Native review prompt is unavailable in Expo Go.',
          tone: 'info',
        });
        return;
      }
      requestStoreReviewForTesting()
        .then((shown) => {
          if (shown) return;
          return openMobileStoreReviewDestination()
            .then((opened) => {
              if (opened) return;
              showToast({
                message: 'Native review prompt is unavailable in this build.',
                tone: 'info',
              });
            });
        })
        .catch((error) => {
          void logWarn('Failed to request review prompt test', {
            scope: 'store-review',
            extra: { error: error instanceof Error ? error.message : String(error) },
          });
        });
    });
  }, [androidInstallerSource, appVersion, isExpoGo, isFossBuild, promptTestControlsEnabled, showToast]);

  useEffect(() => {
    if (
      announcementDismissedInSession
      || !isFirstPaintReady
      || !mobileOnboardingGateSettled
      || mobileOnboardingOpen
    ) {
      return undefined;
    }

    const announcement = ACTIVE_APP_ANNOUNCEMENT;
    if (!shouldShowAppAnnouncement(announcement, null)) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const openWhenUndismissed = (dismissedValue: string | null) => {
      if (cancelled || !shouldShowAppAnnouncement(announcement, dismissedValue)) return;
      timer = setTimeout(() => {
        if (!cancelled) setAnnouncementOpen(true);
      }, 250);
    };

    AsyncStorage.getItem(getAnnouncementDismissalStorageKey(announcement.id))
      .then(openWhenUndismissed)
      .catch(() => openWhenUndismissed(null));

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    announcementDismissedInSession,
    isFirstPaintReady,
    mobileOnboardingGateSettled,
    mobileOnboardingOpen,
  ]);

  useEffect(() => {
    if (!isFirstPaintReady) return;
    markStartupPhase('js.shell_ready');
    markStartupPhase('js.app_ready');
    if (typeof SplashScreen?.hideAsync === 'function') {
      SplashScreen.hideAsync()
        .then(() => {
          markStartupPhase('js.splash_hidden');
        })
        .catch((error) => {
          markStartupPhase('js.splash_hide.failed');
          void logWarn('Failed to hide splash screen', {
            scope: 'app',
            extra: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      return;
    }
    markStartupPhase('js.splash_hidden.noop');
  }, [isFirstPaintReady]);

  useEffect(() => {
    if (!isFirstPaintReady) return;
    recordLocalPromptActivity().catch((error) => {
      void logWarn('Failed to record local prompt activity', {
        scope: 'prompt-state',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
    }).finally(() => {
      setPromptActivitySettled(true);
    });
  }, [isFirstPaintReady]);

  useEffect(() => {
    let cancelled = false;
    resolveMobileDonationPromptAllowed({ donationPromptEnabled, isExpoGo })
      .then((allowed) => {
        if (!cancelled) setDonationPromptAllowed(allowed);
      })
      .catch((error) => {
        if (!cancelled) setDonationPromptAllowed(false);
        void logWarn('Failed to resolve donation prompt channel', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [donationPromptEnabled, isExpoGo]);

  useEffect(() => {
    let cancelled = false;
    resolveMobileUpdateReminderAllowed({ androidInstallerSource, isExpoGo, isFossBuild })
      .then((allowed) => {
        if (!cancelled) setUpdateReminderAllowed(allowed);
      })
      .catch((error) => {
        if (!cancelled) setUpdateReminderAllowed(false);
        void logWarn('Failed to resolve update reminder channel', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [androidInstallerSource, isExpoGo, isFossBuild]);

  useEffect(() => {
    if (
      donationDismissedInSession
      || donationPromptOpen
      || updateReminderOpen
      || donationPromptAllowed !== true
      || ACTIVE_APP_ANNOUNCEMENT
      || announcementOpen
      || !isFirstPaintReady
      || !promptActivitySettled
      || !mobileOnboardingGateSettled
      || mobileOnboardingOpen
    ) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nowMs = Date.now();

    readLocalUserPromptState()
      .then((promptState) => {
        if (cancelled) return;
        if (!shouldShowDonationPrompt({ nowMs, promptState, donationAllowed: true })) return;
        timer = setTimeout(() => {
          if (!cancelled) setDonationPromptOpen(true);
        }, DONATION_PROMPT_STARTUP_DELAY_MS);
      })
      .catch((error) => {
        if (!cancelled) setDonationDismissedInSession(true);
        void logWarn('Failed to read donation prompt state', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    announcementOpen,
    donationDismissedInSession,
    donationPromptAllowed,
    donationPromptOpen,
    isFirstPaintReady,
    mobileOnboardingGateSettled,
    mobileOnboardingOpen,
    promptActivitySettled,
    updateReminderOpen,
  ]);

  useEffect(() => {
    if (
      updateReminderDismissedInSession
      || updateReminderOpen
      || updateReminderAllowed !== true
      || ACTIVE_APP_ANNOUNCEMENT
      || announcementOpen
      || donationPromptOpen
      || !isFirstPaintReady
      || !promptActivitySettled
      || !mobileOnboardingGateSettled
      || mobileOnboardingOpen
    ) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nowMs = Date.now();

    readLocalUserPromptState()
      .then((promptState) => {
        if (cancelled) return;
        if (!shouldCheckUpdateReminder({ nowMs, promptState, updateReminderAllowed: true })) return;
        updateLocalUserPromptState((state) => recordUpdateReminderChecked(state, nowMs))
          .then(() => {
            if (cancelled) return;
            timer = setTimeout(() => {
              fetchMobileUpdateReminderInfo(appVersion)
                .then((info) => {
                  if (cancelled) return;
                  return readLocalUserPromptState()
                    .then((latestPromptState) => {
                      if (cancelled) return;
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
                      return updateLocalUserPromptState((state) => recordUpdateReminderShown(state, Date.now()))
                        .then(() => {
                          if (cancelled) return;
                          setUpdateReminderInfo(info);
                          setUpdateReminderOpen(true);
                        });
                    });
                })
                .catch((error) => {
                  if (!cancelled) setUpdateReminderDismissedInSession(true);
                  void logWarn('Failed to check update reminder', {
                    scope: 'prompt-state',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                  });
                });
            }, 1750);
          })
          .catch((error) => {
            if (!cancelled) setUpdateReminderDismissedInSession(true);
            void logWarn('Failed to record update reminder check', {
              scope: 'prompt-state',
              extra: { error: error instanceof Error ? error.message : String(error) },
            });
          });
      })
      .catch((error) => {
        if (!cancelled) setUpdateReminderDismissedInSession(true);
        void logWarn('Failed to read update reminder state', {
          scope: 'prompt-state',
          extra: { error: error instanceof Error ? error.message : String(error) },
        });
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    announcementOpen,
    appVersion,
    donationPromptOpen,
    isFirstPaintReady,
    mobileOnboardingGateSettled,
    mobileOnboardingOpen,
    promptActivitySettled,
    updateReminderAllowed,
    updateReminderDismissedInSession,
    updateReminderOpen,
  ]);

  if (storageInitError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: tc.bg }}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: isDark ? '#e2e8f0' : '#0f172a', marginBottom: 12 }}>
            Storage unavailable
          </Text>
          <Text style={{ fontSize: 14, color: isDark ? '#94a3b8' : '#475569', lineHeight: 20 }}>
            Mindwtr could not initialize local storage, so changes won&apos;t be saved. Please restart the app or reinstall if the problem persists.
          </Text>
          <Text style={{ fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', marginTop: 16 }}>
            {storageInitError.message}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Avoid mounting task screens against the empty default store before local hydration finishes.
  if (!isFirstPaintReady) {
    return null;
  }

  return (
    <QuickCaptureProvider
      value={{
        openQuickCapture: (options?: QuickCaptureOptions) => {
          const params = new URLSearchParams();
          if (options?.initialValue) {
            params.set('initialValue', options.initialValue);
          }
          const initialProps = buildQuickCaptureInitialProps(options?.initialProps);
          if (initialProps) {
            params.set('initialProps', encodeURIComponent(JSON.stringify(initialProps)));
          }
          if (options?.returnTo) {
            params.set('returnTo', options.returnTo);
          }
          const query = params.toString();
          router.push((query ? `/capture-modal?${query}` : '/capture-modal') as never);
        },
      }}
    >
      <NavigationThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
        <MobileAppLockGate enabled={mobileAppLockEnabled}>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false, animation: 'none' }} />
            <Stack.Screen name="(drawer)" options={{ headerShown: false, animation: 'none' }} />
            <Stack.Screen
              name="daily-review"
              options={{
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="weekly-review"
              options={{
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="global-search"
              options={{
                headerShown: false,
                presentation: 'modal',
                animation: 'slide_from_bottom'
              }}
            />
            <Stack.Screen
              name="capture-modal"
              options={{
                headerShown: false,
                presentation: 'modal',
                animation: 'slide_from_bottom'
              }}
            />
            <Stack.Screen
              name="mind-sweep-modal"
              options={{
                headerShown: false,
                presentation: 'modal',
                animation: 'slide_from_bottom'
              }}
            />
            <Stack.Screen
              name="check-focus"
              options={{
                headerShown: false,
              }}
            />
          </Stack>
          <MobileOnboardingFlow
            busy={mobileOnboardingBusy}
            error={mobileOnboardingError}
            isOpen={mobileOnboardingOpen}
            onOpenImport={openOnboardingImport}
            onOpenSync={openOnboardingSync}
            onSkip={dismissMobileOnboarding}
            onStartFresh={startFreshOnboarding}
          />
          <AppAnnouncementModal
            announcement={activeAnnouncement}
            visible={announcementOpen && !mobileOnboardingOpen}
            onAction={handleAppAnnouncementAction}
            onDismiss={dismissAppAnnouncement}
          />
          <AppAnnouncementModal
            announcement={donationPromptAnnouncement}
            visible={donationPromptOpen && !announcementOpen && !mobileOnboardingOpen}
            onAction={handleDonationPromptAction}
            onDismiss={dismissDonationPrompt}
            onShown={recordDonationPromptVisible}
          />
          <AppAnnouncementModal
            announcement={updateReminderInfo ? buildUpdateReminderAnnouncement(updateReminderInfo) : null}
            visible={
              updateReminderOpen
              && !announcementOpen
              && !donationPromptOpen
              && !mobileOnboardingOpen
            }
            onAction={handleUpdateReminderAction}
            onDismiss={dismissUpdateReminder}
          />
        </MobileAppLockGate>
        <StatusBar
          barStyle={isDark ? 'light-content' : 'dark-content'}
          backgroundColor={tc.bg}
        />
      </NavigationThemeProvider>
    </QuickCaptureProvider>
  );
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <ThemeProvider>
        <LanguageProvider>
          <ErrorBoundary>
            <RootLayoutContent />
          </ErrorBoundary>
        </LanguageProvider>
      </ThemeProvider>
    </ShareIntentProvider>
  );
}
