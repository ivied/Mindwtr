import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AREA_FILTER_ALL, useTaskStore, type Area, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { GlobalSearch } from './GlobalSearch';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const originalScrollIntoView = Element.prototype.scrollIntoView;
const now = '2026-05-03T00:00:00.000Z';

const areas: Area[] = [
    {
        id: 'area-work',
        name: 'Work',
        color: '#2563eb',
        order: 0,
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'area-home',
        name: 'Home',
        color: '#16a34a',
        order: 1,
        createdAt: now,
        updatedAt: now,
    },
];

const tasks: Task[] = [
    {
        id: 'task-work',
        title: 'Work task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-work',
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'task-home',
        title: 'Home needle task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-home',
        createdAt: now,
        updatedAt: now,
    },
];

describe('GlobalSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Element.prototype.scrollIntoView = vi.fn();
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useTaskStore.setState({
            _allTasks: tasks,
            _allProjects: [],
            _allAreas: areas,
            settings: {
                filters: {
                    areaId: 'area-work',
                },
            },
        });
    });

    afterEach(() => {
        if (originalScrollIntoView) {
            Element.prototype.scrollIntoView = originalScrollIntoView;
        } else {
            delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
        }
        vi.useRealTimers();
        useUiStore.setState(initialUiState, true);
    });

    it('searches all areas when opened from an active area filter', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        expect(screen.queryByText('Area: Work')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'needle' },
            });
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });

        expect(screen.getByText((_, element) => element?.textContent === 'Home needle task')).toBeInTheDocument();
    });

    it('switches the sidebar area filter to all areas when opening a task hidden by the active area', async () => {
        const onNavigate = vi.fn();
        const showToast = vi.fn();
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        useTaskStore.setState((state) => ({ ...state, updateSettings }));
        useUiStore.setState((state) => ({ ...state, showToast }));
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={onNavigate} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'needle' },
            });
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });

        const resultButton = screen.getByText((_, element) => element?.textContent === 'Home needle task')
            .closest('button');
        expect(resultButton).toBeTruthy();
        await act(async () => {
            resultButton!.click();
            await Promise.resolve();
        });

        expect(updateSettings).toHaveBeenCalledWith({ filters: { areaId: AREA_FILTER_ALL } });
        expect(showToast).toHaveBeenCalledWith(
            'Switched to All Areas so the selected item is visible.',
            'info',
        );
        expect(onNavigate).toHaveBeenCalledWith('next', 'task-home');
    });
});
