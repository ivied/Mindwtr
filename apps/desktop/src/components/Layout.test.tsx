import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';

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

const renderLayout = () => render(
    <LanguageProvider>
        <KeybindingProvider currentView="inbox" onNavigate={onNavigate}>
            <Layout currentView="inbox" onViewChange={vi.fn()}>
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
    resetStores();
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [],
            projects: [],
            areas: [],
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

describe('Layout Obsidian nav visibility', () => {
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
});

describe('Layout sync security warning', () => {
    it('shows a cleartext HTTP banner for WebDAV sync', async () => {
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });
        const providerSpy = vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('dropbox');

        try {
            const { findByText } = renderLayout();

            expect(await findByText(/WebDAV sync is using HTTP/)).toBeInTheDocument();
        } finally {
            webdavSpy.mockRestore();
            providerSpy.mockRestore();
        }
    });

    it('aggregates cleartext warnings into one banner', async () => {
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
            const { findByText, queryAllByText } = renderLayout();

            expect(await findByText(/WebDAV sync is using HTTP.*Self-hosted sync is using HTTP/)).toBeInTheDocument();
            expect(queryAllByText(/WebDAV sync is using HTTP/)).toHaveLength(1);
        } finally {
            webdavSpy.mockRestore();
            providerSpy.mockRestore();
            cloudSpy.mockRestore();
        }
    });
});
