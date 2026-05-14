import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { ReviewView } from './ReviewView';
import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Avoid async state updates from calendar fetch effects in review modals.
vi.mock('../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(() => new Promise(() => {})),
}));

describe('ReviewView', () => {
    const nowIso = '2026-04-19T12:00:00.000Z';
    const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
        id,
        title: `Task ${id}`,
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        ...overrides,
    });

    beforeEach(() => {
        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            projects: [],
            _allProjects: [],
            sections: [],
            _allSections: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        useUiStore.setState({
            listOptions: {
                showDetails: false,
                nextGroupBy: 'none',
                focusTop3Only: false,
            },
            expandedTaskIds: {},
        });
    });

    it('renders the review list with a guide button', () => {
        const { getByRole } = renderWithProviders(<ReviewView />);
        expect(getByRole('heading', { name: /^review$/i })).toBeInTheDocument();
        expect(getByRole('button', { name: /weekly review/i })).toBeInTheDocument();
    });

    it('hides compact metadata when the details toggle is turned off', () => {
        const reviewTask = makeTask('review-1', {
            title: 'Review task',
            location: 'Desk lamp',
        });

        useTaskStore.setState({
            tasks: [reviewTask],
            _allTasks: [reviewTask],
            lastDataChangeAt: 1,
        });
        useUiStore.setState((state) => ({
            ...state,
            listOptions: {
                ...state.listOptions,
                showDetails: true,
            },
        }));

        const { getByRole, queryByText } = renderWithProviders(<ReviewView />);

        expect(queryByText('Desk lamp')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: /^details$/i }));

        expect(queryByText('Desk lamp')).not.toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
    });

    it('navigates through the wizard steps', () => {
        const { getByText, getAllByText, queryByText } = renderWithProviders(<ReviewView />);

        // Open guide
        fireEvent.click(getByText('Weekly Review'));
        expect(getByText('Process Inbox')).toBeInTheDocument();
        expect(getByText('Inbox Zero Goal')).toBeInTheDocument();

        // Inbox -> AI or Calendar (AI step is hidden when AI is disabled)
        fireEvent.click(getByText('Next Step'));
        const aiVisible = queryByText('AI insight');
        if (aiVisible) {
            expect(aiVisible).toBeInTheDocument();
            fireEvent.click(getByText('Next Step'));
        }

        // -> Calendar
        expect(getAllByText('Review Calendar').length).toBeGreaterThan(0);
        expect(getByText('Events')).toBeInTheDocument();
        expect(getByText('Look at the next week. What do you need to prepare for? Capture any new next actions.')).toBeInTheDocument();

        // Calendar -> Waiting For
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Waiting For')).toBeInTheDocument();

        // Waiting For -> Contexts (optional) -> Projects
        fireEvent.click(getByText('Next Step'));
        const contextsVisible = queryByText('Contexts');
        if (contextsVisible) {
            expect(contextsVisible).toBeInTheDocument();
            fireEvent.click(getByText('Next Step'));
        }
        expect(getByText('Review Projects')).toBeInTheDocument();

        // Projects -> Someday/Maybe
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Someday/Maybe')).toBeInTheDocument();

        // Someday/Maybe -> Completed
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Review Complete!')).toBeInTheDocument();
        expect(getByText('Finish')).toBeInTheDocument();
    });

    it('can navigate back', () => {
        const { getByText, queryByText } = renderWithProviders(<ReviewView />);

        // Open guide
        fireEvent.click(getByText('Weekly Review'));
        expect(getByText('Process Inbox')).toBeInTheDocument();

        // Go forward then back to Inbox
        fireEvent.click(getByText('Next Step'));
        expect(queryByText('Process Inbox')).not.toBeInTheDocument();
        fireEvent.click(getByText('Back'));
        expect(getByText('Process Inbox')).toBeInTheDocument();
    });
});
