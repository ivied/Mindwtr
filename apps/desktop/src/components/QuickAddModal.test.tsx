import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';
import type { ComponentProps } from 'react';

import { LanguageProvider } from '../contexts/language-context';
import { QuickAddModal } from './QuickAddModal';

const initialTaskState = useTaskStore.getState();

const renderQuickAddModal = (props?: ComponentProps<typeof QuickAddModal>) => render(
    <LanguageProvider>
        <QuickAddModal {...props} />
    </LanguageProvider>
);

const createDeferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

beforeEach(() => {
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState((state) => ({
            ...state,
            projects: [],
            areas: [],
            settings: {
                ...state.settings,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'all',
                },
                gtd: {
                    ...(state.settings?.gtd ?? {}),
                    defaultCaptureMethod: 'text',
                },
            },
        }));
    });
});

describe('QuickAddModal', () => {
    it('ignores duplicate open requests while the first open is still committing', async () => {
        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'First capture' },
            }));
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Second capture' },
            }));
            await Promise.resolve();
        });

        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('First capture');
    });

    it('opens the standalone quick add window before data refresh resolves', async () => {
        const deferred = createDeferred();
        const fetchData = vi.fn(() => deferred.promise) as unknown as typeof initialTaskState.fetchData;
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                fetchData,
            }));
        });

        renderQuickAddModal({ standaloneWindow: true });

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Fast capture' },
            }));
            await Promise.resolve();
        });

        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('Fast capture');

        await act(async () => {
            deferred.resolve();
            await deferred.promise;
        });
    });
});
