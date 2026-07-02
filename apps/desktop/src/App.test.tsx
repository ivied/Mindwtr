import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import App from './App';
import { LanguageProvider } from './contexts/language-context';
import { dispatchDesktopOnboardingEvent } from './lib/desktop-onboarding-events';
import { useUiStore } from './store/ui-store';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Mock electronAPI
// Mock electronAPI
Object.defineProperty(window, 'electronAPI', {
    value: {
        saveData: vi.fn(),
        getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
    },
    writable: true,
});

describe('App', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            settings: {},
            isLoading: false,
            error: null,
        }));
        useUiStore.setState((state) => ({
            ...state,
            projectView: { selectedProjectId: null },
            toasts: [],
        }));
    });

    it('renders Focus by default', () => {
        const { getByRole } = renderWithProviders(<App />);
        expect(getByRole('heading', { name: 'Focus' })).toBeInTheDocument();
    });

    it('renders Sidebar navigation', () => {
        const { getByRole } = renderWithProviders(<App />);
        expect(getByRole('button', { name: 'Projects' })).toBeInTheDocument();
    });

    it('opens the manual onboarding flow and seeds data from Start fresh', async () => {
        const { getByRole, queryByRole } = renderWithProviders(<App />);

        act(() => {
            dispatchDesktopOnboardingEvent();
        });

        expect(getByRole('dialog', { name: /welcome to mindwtr/i })).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: /start fresh/i }));

        await waitFor(() => {
            expect(queryByRole('dialog', { name: /welcome to mindwtr/i })).not.toBeInTheDocument();
        });
        expect(useTaskStore.getState().projects.some((project) => project.title === 'Getting Started')).toBe(true);
        expect(useTaskStore.getState().tasks).toHaveLength(8);
        expect(useUiStore.getState().projectView.selectedProjectId).toBe(
            useTaskStore.getState().projects.find((project) => project.title === 'Getting Started')?.id
        );
    });

    it('does not mark onboarding dismissed when routing to sync setup', async () => {
        const { getByRole, queryByRole } = renderWithProviders(<App />);

        act(() => {
            dispatchDesktopOnboardingEvent();
        });

        fireEvent.click(getByRole('button', { name: /set up sync/i }));

        await waitFor(() => {
            expect(queryByRole('dialog', { name: /welcome to mindwtr/i })).not.toBeInTheDocument();
        });
        expect(window.localStorage.getItem('mindwtr:desktop:first-run-onboarding:v1')).not.toBe('dismissed');
    });
});
