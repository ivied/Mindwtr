import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutSyncEffects } from '@/hooks/root-layout/use-root-layout-sync-effects';

const {
  abortMobileSync,
  appState,
  appStateListeners,
  asyncStorageGetItem,
  flushPendingSave,
  getCalendarPushEnabled,
  hasActiveMobileNotificationFeature,
  performMobileSync,
  storeSubscribe,
  syncMobileBackgroundSyncRegistration,
  subscribeToCloudKitChanges,
  updateMobileWidgetFromStore,
} = vi.hoisted(() => ({
  abortMobileSync: vi.fn(() => true),
  appState: { currentState: 'active' },
  appStateListeners: new Set<(state: 'active' | 'background' | 'inactive') => void>(),
  asyncStorageGetItem: vi.fn(async () => 'cloud'),
  flushPendingSave: vi.fn(async () => undefined),
  getCalendarPushEnabled: vi.fn(async () => false),
  hasActiveMobileNotificationFeature: vi.fn(() => false),
  performMobileSync: vi.fn(async () => ({ success: true })),
  storeSubscribe: vi.fn(() => vi.fn()),
  syncMobileBackgroundSyncRegistration: vi.fn(async () => undefined),
  subscribeToCloudKitChanges: vi.fn(() => vi.fn()),
  updateMobileWidgetFromStore: vi.fn(async () => true),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    AppState: {
      get currentState() {
        return appState.currentState;
      },
      addEventListener: vi.fn((_event: string, listener: (state: 'active' | 'background' | 'inactive') => void) => {
        appStateListeners.add(listener);
        return {
          remove: () => appStateListeners.delete(listener),
        };
      }),
    },
    Platform: {
      ...actual.Platform,
      OS: 'android',
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageGetItem,
  },
}));

vi.mock('@mindwtr/core', () => ({
  flushPendingSave,
  useTaskStore: {
    getState: () => ({ settings: {} }),
    subscribe: storeSubscribe,
  },
}));

vi.mock('@/lib/notification-service', () => ({
  getNotificationPermissionStatus: vi.fn(async () => ({ granted: true })),
  startMobileNotifications: vi.fn(async () => undefined),
  stopMobileNotifications: vi.fn(async () => undefined),
}));

vi.mock('@/lib/calendar-push-sync', () => ({
  getCalendarPushEnabled,
  runFullCalendarSync: vi.fn(async () => undefined),
  startCalendarPushSync: vi.fn(() => vi.fn()),
  stopCalendarPushSync: vi.fn(),
}));

vi.mock('@/lib/sync-service', () => ({
  abortMobileSync,
  performMobileSync,
}));

vi.mock('@/lib/background-sync-task', () => ({
  syncMobileBackgroundSyncRegistration,
}));

vi.mock('@/lib/sync-service-utils', () => ({
  classifySyncFailure: vi.fn(() => 'generic'),
  coerceSupportedBackend: vi.fn((backend: string) => backend),
  isLikelyOfflineSyncError: vi.fn(() => false),
  resolveBackend: vi.fn((backend: string | null) => backend ?? 'off'),
}));

vi.mock('@/lib/cloudkit-sync', () => ({
  isCloudKitAvailable: vi.fn(() => false),
  subscribeToCloudKitChanges,
}));

vi.mock('@/lib/widget-service', () => ({
  updateMobileWidgetFromStore,
}));

vi.mock('@/lib/mobile-notification-settings', () => ({
  hasActiveMobileNotificationFeature,
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(async () => undefined),
  logWarn: vi.fn(async () => undefined),
}));

function TestHarness() {
  useRootLayoutSyncEffects({
    resolveText: (_key, fallback) => fallback,
    openNotificationsSettings: vi.fn(),
    openSyncSettings: vi.fn(),
    showToast: vi.fn(),
  });
  return null;
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useRootLayoutSyncEffects', () => {
  beforeEach(() => {
    abortMobileSync.mockClear();
    appState.currentState = 'active';
    appStateListeners.clear();
    asyncStorageGetItem.mockClear();
    asyncStorageGetItem.mockResolvedValue('cloud');
    flushPendingSave.mockClear();
    getCalendarPushEnabled.mockClear();
    getCalendarPushEnabled.mockResolvedValue(false);
    hasActiveMobileNotificationFeature.mockClear();
    hasActiveMobileNotificationFeature.mockReturnValue(false);
    performMobileSync.mockClear();
    performMobileSync.mockResolvedValue({ success: true });
    storeSubscribe.mockClear();
    storeSubscribe.mockReturnValue(vi.fn());
    syncMobileBackgroundSyncRegistration.mockClear();
    syncMobileBackgroundSyncRegistration.mockResolvedValue(undefined);
    subscribeToCloudKitChanges.mockClear();
    subscribeToCloudKitChanges.mockReturnValue(vi.fn());
    updateMobileWidgetFromStore.mockClear();
    updateMobileWidgetFromStore.mockResolvedValue(true);
  });

  it('aborts the in-flight mobile sync through the AppState background transition', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });

    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
    });

    expect(abortMobileSync).toHaveBeenCalledTimes(1);
    expect(syncMobileBackgroundSyncRegistration).toHaveBeenCalled();
    expect(performMobileSync).toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });
});
