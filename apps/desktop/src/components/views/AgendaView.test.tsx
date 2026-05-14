import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { AgendaView } from './AgendaView';
import { useUiStore } from '../../store/ui-store';

const nowIso = '2026-02-28T12:00:00.000Z';

const focusedTask: Task = {
    id: 'focused-task',
    title: 'Focused task',
    status: 'next',
    isFocusedToday: true,
    checklist: [
        { id: 'item-1', title: 'Checklist item', isCompleted: false },
    ],
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const renderAgenda = () => render(
    <LanguageProvider>
        <AgendaView />
    </LanguageProvider>
);

describe('AgendaView', () => {
    beforeEach(() => {
        useTaskStore.setState({
            tasks: [focusedTask],
            _allTasks: [focusedTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
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

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps focus task details open when checklist items are toggled', async () => {
        const { getByRole, getByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /toggle task details/i }));
        const checklistItem = getByText('Checklist item');
        expect(checklistItem).toBeInTheDocument();

        fireEvent.click(checklistItem);

        expect(getByText('Checklist item')).toBeInTheDocument();
    });

    it('collapses expanded task details when page details are turned off', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            description: 'Expanded task note',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask],
            _allTasks: [nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        useUiStore.setState((state) => ({
            ...state,
            listOptions: {
                ...state.listOptions,
                showDetails: true,
            },
            expandedTaskIds: { 'next-action-task': true },
        }));

        const { getByRole, queryByText } = renderAgenda();

        expect(queryByText('Expanded task note')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: /^details$/i }));

        expect(queryByText('Expanded task note')).not.toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
        expect(useUiStore.getState().expandedTaskIds).toEqual({});
    });

    it('keeps non-next tasks with start time today out of Today', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayTask: Task = {
            id: 'start-today-task',
            title: 'Start today inbox task',
            status: 'inbox',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayTask],
            _allTasks: [startTodayTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { queryByRole, queryByText } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(queryByText('Start today inbox task')).not.toBeInTheDocument();
    });

    it('shows an empty state when active tasks do not produce agenda sections', () => {
        const inboxTask: Task = {
            id: 'inbox-task',
            title: 'Inbox only task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [inboxTask],
            _allTasks: [inboxTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        expect(getByText('All Clear!')).toBeInTheDocument();
        expect(getByText('Nothing on deck. Pick a next action to focus on.')).toBeInTheDocument();
        expect(queryByText('Inbox only task')).not.toBeInTheDocument();
    });

    it('does not let earlier non-Focus tasks hide the next task in a sequential project', () => {
        const project = {
            id: 'project-1',
            title: 'Sequential project',
            status: 'active' as const,
            isSequential: true,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const inboxBefore: Task = {
            id: 'inbox-before',
            title: 'Inbox before',
            status: 'inbox',
            projectId: project.id,
            order: 0,
            orderNum: 0,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const availableNext: Task = {
            id: 'available-next',
            title: 'Available next',
            status: 'next',
            projectId: project.id,
            order: 1,
            orderNum: 1,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [inboxBefore, availableNext],
            _allTasks: [inboxBefore, availableNext],
            projects: [project],
            _allProjects: [project],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        expect(getByRole('heading', { name: /next actions/i })).toBeInTheDocument();
        expect(getByText('Available next')).toBeInTheDocument();
        expect(queryByText('Inbox before')).not.toBeInTheDocument();
    });

    it('shows next tasks with start time today in Today section (not Next Actions)', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayNextTask: Task = {
            id: 'start-today-next-task',
            title: 'Start today next task',
            status: 'next',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayNextTask],
            _allTasks: [startTodayNextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByRole } = renderAgenda();

        expect(getByRole('heading', { name: /today/i })).toBeInTheDocument();
        expect(getByText('Start today next task')).toBeInTheDocument();
        expect(queryByRole('heading', { name: /next actions/i })).not.toBeInTheDocument();
    });

    it('hides future-start next actions in Focus by default', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));

        const futureStartTask: Task = {
            id: 'future-start-next-task',
            title: 'Future start next task',
            status: 'next',
            startTime: '2026-03-03T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [futureStartTask],
            _allTasks: [futureStartTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        expect(queryByText('Future start next task')).not.toBeInTheDocument();
        expect(getByText('1 task hidden (future start)')).toBeInTheDocument();
    });

    it('does not show later sequential actions when the first action has a hidden future start', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));

        const project = {
            id: 'project-1',
            title: 'Sequential project',
            status: 'active' as const,
            isSequential: true,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const futureFirst: Task = {
            id: 'future-first',
            title: 'Future first',
            status: 'next',
            projectId: project.id,
            order: 0,
            orderNum: 0,
            startTime: '2026-03-03T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const followingNext: Task = {
            id: 'following-next',
            title: 'Following next',
            status: 'next',
            projectId: project.id,
            order: 1,
            orderNum: 1,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [futureFirst, followingNext],
            _allTasks: [futureFirst, followingNext],
            projects: [project],
            _allProjects: [project],
            areas: [],
            _allAreas: [],
            settings: { appearance: { showFutureStarts: false } },
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        expect(queryByText('Future first')).not.toBeInTheDocument();
        expect(queryByText('Following next')).not.toBeInTheDocument();
        expect(getByText('1 task hidden (future start)')).toBeInTheDocument();
    });

    it('shows due-soon next actions before undated tasks and sinks far-future due tasks', () => {
        vi.useFakeTimers();
        const now = new Date('2026-02-28T12:00:00.000Z');
        vi.setSystemTime(now);

        const soonTask: Task = {
            id: 'soon-task',
            title: 'Soon task',
            status: 'next',
            dueDate: '2026-03-05T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: '2026-02-20T00:00:00.000Z',
            updatedAt: '2026-02-20T00:00:00.000Z',
        };
        const undatedTask: Task = {
            id: 'undated-task',
            title: 'Undated task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-02-21T00:00:00.000Z',
            updatedAt: '2026-02-21T00:00:00.000Z',
        };
        const futureTask: Task = {
            id: 'future-task',
            title: 'Future task',
            status: 'next',
            dueDate: '2027-04-01T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: '2026-02-22T00:00:00.000Z',
            updatedAt: '2026-02-22T00:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [futureTask, undatedTask, soonTask],
            _allTasks: [futureTask, undatedTask, soonTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();
        expect(getByRole('heading', { name: /next actions/i })).toBeInTheDocument();

        const soonRow = container.querySelector('[data-task-id="soon-task"]');
        const undatedRow = container.querySelector('[data-task-id="undated-task"]');
        const futureRow = container.querySelector('[data-task-id="future-task"]');

        expect(soonRow).toBeTruthy();
        expect(undatedRow).toBeTruthy();
        expect(futureRow).toBeTruthy();
        expect(soonRow!.compareDocumentPosition(undatedRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(undatedRow!.compareDocumentPosition(futureRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps waiting tasks with review dates out of Today', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const reviewDue = new Date(now.getTime() - 60_000).toISOString();
        const waitingTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            startTime: startToday,
            reviewAt: reviewDue,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [waitingTask],
            _allTasks: [waitingTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByText, getByRole, queryByRole } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(getByRole('heading', { name: /review due/i })).toBeInTheDocument();
        expect(getAllByText('Waiting review task')).toHaveLength(1);
    });

    it('opens editor when double-clicking a non-focused task row in Focus', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask],
            _allTasks: [nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByDisplayValue } = renderAgenda();
        const row = container.querySelector('[data-task-id="next-action-task"]');
        expect(row).toBeTruthy();

        fireEvent.doubleClick(row!);
        expect(getByDisplayValue('Next action task')).toBeInTheDocument();
    });

    it('groups next actions by context in Focus view', () => {
        const workTask: Task = {
            id: 'next-work-task',
            title: 'Work next task',
            status: 'next',
            contexts: ['@work'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const homeTask: Task = {
            id: 'next-home-task',
            title: 'Home next task',
            status: 'next',
            contexts: ['@home'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [workTask, homeTask],
            _allTasks: [workTask, homeTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByLabelText, getByText } = renderAgenda();
        const groupSelect = getByLabelText('Group') as HTMLSelectElement;
        fireEvent.change(groupSelect, { target: { value: 'context' } });

        expect(getByText('@work')).toBeInTheDocument();
        expect(getByText('@home')).toBeInTheDocument();
        expect(getByText('Work next task')).toBeInTheDocument();
        expect(getByText('Home next task')).toBeInTheDocument();
    });

    it('groups next actions by project in Focus view', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const noProjectTask: Task = {
            id: 'no-project-task',
            title: 'Standalone task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [projectTask, noProjectTask],
            _allTasks: [projectTask, noProjectTask],
            projects: [{
                id: 'project-alpha',
                title: 'Alpha project',
                status: 'active',
                color: '#123456',
                order: 0,
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            }],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByLabelText, getByText } = renderAgenda();
        const groupSelect = getByLabelText('Group') as HTMLSelectElement;
        fireEvent.change(groupSelect, { target: { value: 'project' } });

        expect(getByText('Alpha project')).toBeInTheDocument();
        expect(getByText('No Project')).toBeInTheDocument();
        expect(getByText('Project task')).toBeInTheDocument();
        expect(getByText('Standalone task')).toBeInTheDocument();
    });

    it('filters focus tasks by project', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const otherTask: Task = {
            id: 'other-task',
            title: 'Other task',
            status: 'next',
            projectId: 'project-beta',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [projectTask, otherTask],
            _allTasks: [projectTask, otherTask],
            projects: [
                {
                    id: 'project-alpha',
                    title: 'Alpha project',
                    status: 'active',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: nowIso,
                    updatedAt: nowIso,
                },
                {
                    id: 'project-beta',
                    title: 'Beta project',
                    status: 'active',
                    color: '#654321',
                    order: 1,
                    tagIds: [],
                    createdAt: nowIso,
                    updatedAt: nowIso,
                },
            ],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'Alpha project' }));

        expect(getByText('Project task')).toBeInTheDocument();
        expect(queryByText('Other task')).not.toBeInTheDocument();
    });

    it('filters focus tasks with the no-project option', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const noProjectTask: Task = {
            id: 'no-project-task',
            title: 'Standalone task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [projectTask, noProjectTask],
            _allTasks: [projectTask, noProjectTask],
            projects: [{
                id: 'project-alpha',
                title: 'Alpha project',
                status: 'active',
                color: '#123456',
                order: 0,
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            }],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'No Project' }));

        expect(getByText('Standalone task')).toBeInTheDocument();
        expect(queryByText('Project task')).not.toBeInTheDocument();
    });

    it('filters focus tasks by energy level', () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const highEnergyTask: Task = {
            id: 'high-energy-task',
            title: 'High energy task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask, highEnergyTask],
            _allTasks: [lowEnergyTask, highEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));

        expect(getByText('High energy task')).toBeInTheDocument();
        expect(queryByText('Low energy task')).not.toBeInTheDocument();
    });

    it('shows an empty state when filters match no visible focus tasks', () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask],
            _allTasks: [lowEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));

        expect(queryByText('Low energy task')).not.toBeInTheDocument();
        expect(getByText('No tasks match these filters.')).toBeInTheDocument();
    });

    it('shows store errors inside the Agenda surface', () => {
        useTaskStore.setState({
            error: 'Storage request timed out. Try again.',
        });

        const { getByRole, getByText } = renderAgenda();

        expect(getByRole('alert')).toBeInTheDocument();
        expect(getByText('Something went wrong')).toBeInTheDocument();
        expect(getByText('Storage request timed out. Try again.')).toBeInTheDocument();
    });

    it('applies and clears saved Focus filters from the chip row', () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const phoneTask: Task = {
            id: 'phone-task',
            title: 'Phone task',
            status: 'next',
            contexts: ['@phone'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask, phoneTask],
            _allTasks: [deskTask, phoneTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: { contexts: ['@desk'] },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));

        expect(getByText('Desk task')).toBeInTheDocument();
        expect(queryByText('Phone task')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'All' }));

        expect(getByText('Desk task')).toBeInTheDocument();
        expect(getByText('Phone task')).toBeInTheDocument();
    });

    it('deletes the active saved Focus filter from the chip row', async () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask],
            _allTasks: [deskTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: { contexts: ['@desk'] },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole, queryByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));
        fireEvent.click(getByRole('button', { name: 'Delete saved filter Desk' }));
        fireEvent.click(getByRole('button', { name: /^Delete$/i }));

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters).toEqual([
                expect.objectContaining({
                    id: 'filter-desk',
                    deletedAt: expect.any(String),
                }),
            ]);
        });
        expect(queryByRole('button', { name: 'Desk' })).not.toBeInTheDocument();
    });

    it('removes advanced synced criteria from the active saved Focus filter', async () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask],
            _allTasks: [deskTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: {
                        contexts: ['@desk'],
                        dueDateRange: { preset: 'this_week' },
                        hasDescription: true,
                    },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));
        fireEvent.click(getByRole('button', { name: 'Delete Due Date: This week' }));

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                id: 'filter-desk',
                criteria: {
                    contexts: ['@desk'],
                    hasDescription: true,
                },
                updatedAt: expect.any(String),
            });
        });
    });

    it('saves the current Focus filter from existing controls', async () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const highEnergyTask: Task = {
            id: 'high-energy-task',
            title: 'High energy task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask, highEnergyTask],
            _allTasks: [lowEnergyTask, highEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByRole, getByDisplayValue, getByRole, getByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Show$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));
        fireEvent.click(getByRole('button', { name: /^Save$/i }));
        fireEvent.change(getByDisplayValue('High energy'), { target: { value: 'High energy preset' } });
        const saveButtons = getAllByRole('button', { name: /^Save$/i });
        fireEvent.click(saveButtons[saveButtons.length - 1]);

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                name: 'High energy preset',
                view: 'focus',
                criteria: { energy: ['high'] },
            });
        });
        expect(getByText('High energy preset')).toBeInTheDocument();
    });

    it('collapses next actions when the section header is toggled', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const reviewTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            reviewAt: '2026-02-27T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask, reviewTask],
            _allTasks: [nextTask, reviewTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();
        const nextSectionButton = getByRole('button', { name: /next actions/i });

        expect(nextSectionButton).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeTruthy();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();

        fireEvent.click(nextSectionButton);

        expect(getByRole('button', { name: /next actions/i })).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeNull();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();
    });

    it('exposes the filter panel state with aria-expanded', () => {
        const { getByRole } = renderAgenda();

        const filtersButton = getByRole('button', { name: /^show$/i });
        expect(filtersButton).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(filtersButton);
        expect(getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true');
    });

    it('allows hiding the filter panel after selecting a filter', () => {
        const filteredTask: Task = {
            id: 'filtered-task',
            title: 'Filtered task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [filteredTask],
            _allTasks: [filteredTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, queryByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^show$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));
        fireEvent.click(getByRole('button', { name: /^hide$/i }));

        expect(getByRole('button', { name: /^show$/i })).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: 'Low energy' })).not.toBeInTheDocument();
        expect(getByRole('textbox')).toBeInTheDocument();
        expect(queryByRole('button', { name: 'High energy' })).not.toBeInTheDocument();
        expect(document.body).toHaveTextContent('High energy');
    });

    it('renders every grouped no-context task when the list is large', () => {
        const tasks = Array.from({ length: 30 }, (_, index) => ({
            id: `next-task-${index + 1}`,
            title: `Next task ${index + 1}`,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        } satisfies Task));

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByLabelText, getByText } = renderAgenda();
        const groupSelect = getByLabelText('Group') as HTMLSelectElement;
        fireEvent.change(groupSelect, { target: { value: 'context' } });

        expect(getByText(/no context/i)).toBeInTheDocument();
        expect(getByText('Next task 30')).toBeInTheDocument();
    });
});
