import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useManualPullSync } from './use-manual-pull-sync';

const mocked = vi.hoisted(() => ({
  getMobileSyncConfigurationStatus: vi.fn(),
  getSyncConflictCount: vi.fn(() => 0),
  isLikelyOfflineSyncError: vi.fn(() => false),
  performMobileSync: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'common.notice': 'Notice',
        'common.offline': 'Offline',
        'settings.lastSyncError': 'Sync failed',
        'settings.syncCompletedWithConflicts': 'Sync completed with {count} conflicts (resolved automatically).',
        'settings.syncMobile.pleaseSetAWebdavUrlFirst': 'Please set a WebDAV URL first',
        'settings.syncQueued': 'Sync queued',
        'settings.syncQueuedBody': 'Local changes arrived during sync. A retry was queued automatically.',
        'settings.syncSkippedOffline': 'No internet connection. Sync skipped.',
      }[key] ?? key),
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: mocked.showToast,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/sync-service', () => ({
  getMobileSyncConfigurationStatus: mocked.getMobileSyncConfigurationStatus,
  performMobileSync: mocked.performMobileSync,
}));

vi.mock('@/lib/sync-service-utils', () => ({
  getSyncConflictCount: mocked.getSyncConflictCount,
  isLikelyOfflineSyncError: mocked.isLikelyOfflineSyncError,
}));

let latest: ReturnType<typeof useManualPullSync> | null = null;
let tree: ReactTestRenderer | null = null;

function Harness() {
  latest = useManualPullSync();
  return React.createElement('ManualPullSyncHarness', {
    indicatorState: latest.indicatorState,
    refreshing: latest.refreshing,
  });
}

const renderHarness = () => {
  act(() => {
    tree = create(<Harness />);
  });
};

describe('useManualPullSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    mocked.getMobileSyncConfigurationStatus.mockReset();
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    mocked.getSyncConflictCount.mockReset();
    mocked.getSyncConflictCount.mockReturnValue(0);
    mocked.isLikelyOfflineSyncError.mockReset();
    mocked.isLikelyOfflineSyncError.mockReturnValue(false);
    mocked.performMobileSync.mockReset();
    mocked.performMobileSync.mockResolvedValue({ success: true });
    mocked.showToast.mockReset();
  });

  afterEach(() => {
    if (tree) {
      act(() => {
        tree?.unmount();
      });
    }
    tree = null;
    vi.useRealTimers();
  });

  it('runs configured sync and settles the manual indicator without a success toast', async () => {
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
    expect(latest?.indicatorState).toBe('success');
    expect(latest?.refreshing).toBe(false);
    expect(mocked.showToast).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(latest?.indicatorState).toBe('idle');
  });

  it('shows setup feedback without calling sync when the backend is not configured', async () => {
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: false });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).not.toHaveBeenCalled();
    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Please set a WebDAV URL first',
      tone: 'warning',
    }));
  });

  it('surfaces offline skips as manual pull errors', async () => {
    mocked.performMobileSync.mockResolvedValue({ success: true, skipped: 'offline' });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Offline',
      message: 'No internet connection. Sync skipped.',
      tone: 'warning',
    }));
  });

  it('keeps success quiet except for conflict summaries', async () => {
    mocked.getSyncConflictCount.mockReturnValue(2);
    mocked.performMobileSync.mockResolvedValue({ success: true, stats: {} });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('success');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Sync completed with 2 conflicts (resolved automatically).',
      tone: 'warning',
    }));
  });
});
