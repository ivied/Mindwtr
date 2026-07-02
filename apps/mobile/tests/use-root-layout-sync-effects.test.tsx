import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutSyncEffects } from '@/hooks/root-layout/use-root-layout-sync-effects';

const {
  abortMobileSync,
  appState,
  appStateListeners,
  asyncStorageGetItem,
  computeSyncPayloadFingerprint,
  flushPendingSave,
  getInMemoryAppDataSnapshot,
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
  computeSyncPayloadFingerprint: vi.fn((_data?: unknown) => 'sync-payload:initial'),
  flushPendingSave: vi.fn(async () => undefined),
  getInMemoryAppDataSnapshot: vi.fn(() => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} })),
  getCalendarPushEnabled: vi.fn(async () => false),
  hasActiveMobileNotificationFeature: vi.fn(() => false),
  performMobileSync: vi.fn(async () => ({ success: true })),
  storeSubscribe: vi.fn((..._args: unknown[]) => vi.fn()),
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
  computeSyncPayloadFingerprint,
  flushPendingSave,
  getInMemoryAppDataSnapshot,
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
    computeSyncPayloadFingerprint.mockClear();
    computeSyncPayloadFingerprint.mockReturnValue('sync-payload:initial');
    flushPendingSave.mockClear();
    getInMemoryAppDataSnapshot.mockClear();
    getInMemoryAppDataSnapshot.mockReturnValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
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

  it('does not auto-sync for local-only store changes that leave the sync payload unchanged', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('strips sync bookkeeping fields before comparing auto-sync payload fingerprints', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let snapshot = {
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        lastSyncStatus: 'success',
        pendingRemoteWriteAt: '2026-01-01T00:00:01.000Z',
        theme: 'dark',
      },
    };
    getInMemoryAppDataSnapshot.mockImplementation(() => snapshot);
    computeSyncPayloadFingerprint.mockImplementation((data?: unknown) => JSON.stringify(data));

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    snapshot = {
      ...snapshot,
      settings: {
        lastSyncAt: '2026-01-01T00:05:00.000Z',
        lastSyncStatus: 'success',
        pendingRemoteWriteAt: '2026-01-01T00:05:01.000Z',
        theme: 'dark',
      },
    };

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).not.toHaveBeenCalled();
    expect(computeSyncPayloadFingerprint).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: { theme: 'dark' },
    }));

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('auto-syncs when the sync payload fingerprint changes', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    computeSyncPayloadFingerprint.mockReturnValue('sync-payload:changed');
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('dedupes rapid unchanged app-state sync triggers', async () => {
    vi.useFakeTimers();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
      listener('active');
      await flushMicrotasks();
      listener('background');
      await flushMicrotasks();
      listener('active');
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('does not queue duplicate foreground syncs for repeated active AppState events', async () => {
    vi.useFakeTimers();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
      listener('active');
      listener('active');
      await vi.advanceTimersByTimeAsync(45_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });
});
