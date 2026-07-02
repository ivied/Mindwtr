import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useTaskStore, type MergeStats } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { KeybindingProvider } from '../contexts/keybinding-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { SyncService } from '../lib/sync-service';
import { Layout } from './Layout';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const initialObsidianState = useObsidianStore.getState();
const onNavigate = vi.fn();

const createMergeStats = (conflictIds: string[] = []): MergeStats => {
    const emptyStats = {
        localTotal: 0,
        incomingTotal: 0,
        mergedTotal: 0,
        localOnly: 0,
        incomingOnly: 0,
        conflicts: 0,
        resolvedUsingLocal: 0,
        resolvedUsingIncoming: 0,
        deletionsWon: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        invalidTimestamps: 0,
        timestampAdjustments: 0,
        timestampAdjustmentIds: [],
        futureTimestampClamps: 0,
        futureTimestampClampIds: [],
        conflictReasonCounts: {},
        conflictSamples: [],
    };
    return {
        tasks: {
            ...emptyStats,
            conflicts: conflictIds.length,
            conflictIds,
            conflictSamples: conflictIds.map((id) => ({
                id,
                winner: 'local',
                reasons: ['content'],
                hasRevision: true,
                timeDiffMs: 0,
                localUpdatedAt: '2026-04-22T12:00:00.000Z',
                incomingUpdatedAt: '2026-04-22T12:00:00.000Z',
                localRev: 1,
                incomingRev: 1,
                localComparableHash: `local-${id}`,
                incomingComparableHash: `incoming-${id}`,
                diffKeys: ['title'],
            })),
        },
        projects: { ...emptyStats },
        sections: { ...emptyStats },
        areas: { ...emptyStats },
    };
};

const renderLayout = (currentView = 'inbox', onViewChange = vi.fn()) => render(
    <LanguageProvider>
        <KeybindingProvider currentView={currentView} onNavigate={onNavigate}>
            <Layout currentView={currentView} onViewChange={onViewChange}>
                <div>Main content</div>
            </Layout>
        </KeybindingProvider>
    </LanguageProvider>
);

const resetStores = () => {
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useObsidianStore.setState(initialObsidianState, true);
    });
};

beforeEach(() => {
    window.localStorage.clear();
    resetStores();
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [],
            _allProjects: [],
            _allAreas: [],
            settings: {
                ...state.settings,
                sidebarCollapsed: false,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'all',
                },
            },
            error: null,
        }));
        useUiStore.setState((state) => ({
            ...state,
            isFocusMode: false,
        }));
        useObsidianStore.setState((state) => ({
            ...state,
            config: {
                ...state.config,
                enabled: false,
            },
            isInitialized: true,
        }));
    });
});

afterEach(() => {
    cleanup();
    resetStores();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('Layout sidebar archive section', () => {
    it('keeps archive visible by default on a fresh sidebar', () => {
        const { container, getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector('#sidebar-section-archive')).not.toHaveClass('hidden');
        expect(getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });

    it('expands archive when the active view lives in archive', async () => {
        const { container, getByRole } = renderLayout('trash');

        await waitFor(() => {
            expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'true');
            expect(container.querySelector('#sidebar-section-archive')).not.toHaveClass('hidden');
        });
        expect(getByRole('button', { name: 'Trash' })).toHaveAttribute('aria-current', 'page');
    });

    it('respects a stored collapsed archive preference', () => {
        window.localStorage.setItem('mindwtr:sidebar:collapsedSections', JSON.stringify(['archive']));

        const { container, getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('#sidebar-section-archive')).toHaveClass('hidden');
    });

    it('uses the full archive header row as the collapse target', () => {
        const { container, getByRole } = renderLayout();
        const archiveHeader = getByRole('button', { name: 'Archive' });

        expect(archiveHeader).toHaveAttribute('aria-controls', 'sidebar-section-archive');
        fireEvent.click(archiveHeader);

        expect(archiveHeader).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('#sidebar-section-archive')).toHaveClass('hidden');
    });
});

describe('Layout Obsidian nav visibility', () => {
    it('opens global inbox capture from the visible Add Task button', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getByRole } = renderLayout();
        const addTaskButton = getByRole('button', { name: 'Add Task (Inbox)' });

        expect(addTaskButton).toHaveAttribute('title', 'Add Task (Inbox)');
        expect(addTaskButton).toHaveClass('bg-primary/5');
        expect(addTaskButton).toHaveClass('text-primary');

        fireEvent.click(addTaskButton);

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        expect(quickAddListener.mock.calls[0][0]).toMatchObject({
            detail: { initialProps: { status: 'inbox' } },
        });

        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('hides Obsidian when the integration is disabled', () => {
        const { queryByRole } = renderLayout();

        expect(queryByRole('button', { name: 'Obsidian' })).not.toBeInTheDocument();
    });

    it('shows Obsidian when the integration is enabled', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    ...state.config,
                    enabled: true,
                },
            }));
        });

        const { getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Obsidian' })).toBeInTheDocument();
    });
});

describe('Layout sync conflict surface', () => {
    it('shows sync freshness as visible text', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-22T12:10:00.000Z'));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:05:00.000Z',
                    lastSyncStatus: 'success',
                },
            }));
        });

        const { getByText } = renderLayout();

        expect(getByText('Synced')).toBeInTheDocument();
    });

    it('runs manual sync from the sidebar sync button', async () => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
        });

        const { getByRole } = renderLayout();

        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledTimes(1));
        expect(showToast).toHaveBeenCalledWith('Sync completed', 'success');

        performSyncSpy.mockRestore();
    });

    it('shows a toast when a new sync conflict status is present', () => {
        const showToast = vi.fn();
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:00:00.000Z',
                    lastSyncStatus: 'conflict',
                },
            }));
        });

        renderLayout();

        expect(showToast).toHaveBeenCalledWith(
            'Sync conflict resolved with last-write-wins. Open Settings → Sync to review the details.',
            'info',
            6000,
        );
    });

    it('does not repeat the same conflict toast when only the sync timestamp changes', async () => {
        const showToast = vi.fn();
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:00:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-1']),
                },
            }));
        });

        renderLayout();

        expect(showToast).toHaveBeenCalledTimes(1);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:01:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-1']),
                },
            }));
        });

        await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:02:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-2']),
                },
            }));
        });

        await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    });
});

describe('Layout collapsed sidebar area filter', () => {
    it('keeps the area filter available when the sidebar is collapsed', () => {
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allAreas: [
                    { id: 'area-work', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
                ],
                settings: {
                    ...state.settings,
                    sidebarCollapsed: true,
                    filters: {
                        ...(state.settings?.filters ?? {}),
                        areaId: 'area-work',
                    },
                },
            }));
        });

        const { getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Area filter: Work' })).toBeInTheDocument();
    });

    it('uses distinct collapsed icons for board navigation and area filtering', () => {
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    sidebarCollapsed: true,
                },
            }));
        });

        const { container, getByRole } = renderLayout();
        const boardIcon = container.querySelector('[data-view="board"] svg');
        const areaFilterIcon = getByRole('button', { name: 'Area filter: All areas' }).querySelector('svg');

        expect(boardIcon).toHaveClass('lucide-kanban');
        expect(areaFilterIcon).toHaveClass('lucide-layers');
    });
});

describe('Layout sync security warning', () => {
    it('shows a cleartext HTTP banner for WebDAV sync', async () => {
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('webdav');
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });

        try {
            const { findByText } = renderLayout();

            expect(await findByText(/WebDAV sync is using HTTP/)).toBeInTheDocument();
        } finally {
            backendSpy.mockRestore();
            webdavSpy.mockRestore();
        }
    });

    it('shows a cleartext HTTP banner for active self-hosted sync', async () => {
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('cloud');
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });
        const providerSpy = vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        const cloudSpy = vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: 'http://192.168.1.50:3000',
            token: '',
            allowInsecureHttp: true,
        });

        try {
            const { findByText, queryByText } = renderLayout();

            expect(await findByText(/Self-hosted sync is using HTTP/)).toBeInTheDocument();
            expect(queryByText(/WebDAV sync is using HTTP/)).not.toBeInTheDocument();
        } finally {
            backendSpy.mockRestore();
            webdavSpy.mockRestore();
            providerSpy.mockRestore();
            cloudSpy.mockRestore();
        }
    });

    it('ignores stale cleartext WebDAV settings while file sync is active', async () => {
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('file');
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });
        const cloudSpy = vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: 'http://192.168.1.50:3000',
            token: '',
            allowInsecureHttp: true,
        });

        try {
            const { queryByText } = renderLayout();

            await waitFor(() => expect(backendSpy).toHaveBeenCalled());
            expect(queryByText(/WebDAV sync is using HTTP/)).not.toBeInTheDocument();
            expect(queryByText(/Self-hosted sync is using HTTP/)).not.toBeInTheDocument();
            expect(webdavSpy).not.toHaveBeenCalled();
            expect(cloudSpy).not.toHaveBeenCalled();
        } finally {
            backendSpy.mockRestore();
            webdavSpy.mockRestore();
            cloudSpy.mockRestore();
        }
    });
});
