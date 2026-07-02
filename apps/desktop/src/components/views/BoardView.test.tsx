import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { BoardView } from './BoardView';
import { LanguageProvider } from '../../contexts/language-context';
import { useTaskStore, type AppData, type Area, type Project, type Task } from '@mindwtr/core';
import { useUiStore } from '../../store/ui-store';

vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PointerSensor: class {},
    useDroppable: () => ({ setNodeRef: () => {} }),
    useSensor: () => ({}),
    useSensors: () => ([]),
    closestCorners: () => null,
}));

vi.mock('@dnd-kit/sortable', () => ({
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    verticalListSortingStrategy: {},
    useSortable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        transform: null,
        transition: undefined,
        isDragging: false,
    }),
}));

const renderWithProviders = () => {
    return render(
        <LanguageProvider>
            <BoardView />
        </LanguageProvider>
    );
};

const getRenderedTaskTitles = (column: HTMLElement, titles: string[]): string[] => (
    Array.from(column.querySelectorAll('[role="listitem"]'))
        .map((item) => titles.find((title) => item.textContent?.includes(title)))
        .filter((title): title is string => Boolean(title))
);

const setBoardStoreState = ({
    tasks = [],
    projects = [],
    areas = [],
    settings = {},
}: {
    tasks?: Task[];
    projects?: Project[];
    areas?: Area[];
    settings?: AppData['settings'];
}) => {
    useTaskStore.setState({
        tasks,
        projects,
        areas,
        settings,
        _allTasks: tasks,
        _allProjects: projects,
        _allAreas: areas,
    });
};

describe('BoardView', () => {
    beforeEach(() => {
        window.localStorage.clear();
        setBoardStoreState({
            tasks: [],
            projects: [],
            areas: [],
            settings: {},
        });
        useUiStore.setState({
            boardFilters: { criteria: {} },
        });
    });

    it('renders the column headers', () => {
        const { getByRole } = renderWithProviders();
        expect(getByRole('heading', { name: /inbox/i })).toBeInTheDocument();
        expect(getByRole('heading', { name: /next actions/i })).toBeInTheDocument();
    });

    it('exposes the project filter panel state with aria-expanded', () => {
        const { getByRole } = renderWithProviders();

        const filtersButton = getByRole('button', { name: /show/i });
        expect(filtersButton).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(filtersButton);
        expect(getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true');
    });

    it('allows hiding the project filter panel after selecting a filter', () => {
        setBoardStoreState({
            tasks: [],
            projects: [{
                id: 'project-1',
                title: 'Alpha project',
                status: 'active',
                color: '#123456',
                order: 0,
                tagIds: [],
                createdAt: '2026-02-28T12:00:00.000Z',
                updatedAt: '2026-02-28T12:00:00.000Z',
            }],
            areas: [],
            settings: {},
        });

        const { getByRole, queryByRole } = renderWithProviders();

        fireEvent.click(getByRole('button', { name: /^show$/i }));
        fireEvent.click(getByRole('button', { name: 'Alpha project' }));
        fireEvent.click(getByRole('button', { name: /^hide$/i }));

        expect(getByRole('button', { name: /^show$/i })).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: 'Alpha project' })).not.toBeInTheDocument();
    });

    it('hides tasks that belong to deferred projects', () => {
        setBoardStoreState({
            tasks: [
                {
                    id: 'active-task',
                    title: 'Active project next action',
                    status: 'next',
                    projectId: 'active-project',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
                {
                    id: 'someday-task',
                    title: 'Someday project next action',
                    status: 'next',
                    projectId: 'someday-project',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
            ],
            projects: [
                {
                    id: 'active-project',
                    title: 'Active project',
                    status: 'active',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
                {
                    id: 'someday-project',
                    title: 'Someday project',
                    status: 'someday',
                    color: '#654321',
                    order: 1,
                    tagIds: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
            ],
            areas: [],
            settings: {},
        });

        const { getByText, queryByText } = renderWithProviders();

        expect(getByText('Active project next action')).toBeInTheDocument();
        expect(queryByText('Someday project next action')).not.toBeInTheDocument();
    });

    it('orders column tasks by boardOrder ahead of tasks without one', () => {
        const baseTask = {
            status: 'next' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-05-18T12:00:00.000Z',
            updatedAt: '2026-05-18T12:00:00.000Z',
        };
        setBoardStoreState({
            tasks: [
                { ...baseTask, id: 'task-q', title: 'Task Q', boardOrder: 1 },
                { ...baseTask, id: 'task-w', title: 'Task W', boardOrder: 2 },
                { ...baseTask, id: 'task-e', title: 'Task E', boardOrder: 0 },
                { ...baseTask, id: 'task-r', title: 'Task R' },
            ],
            projects: [],
            areas: [],
            settings: {},
        });

        const { getByRole } = renderWithProviders();

        const column = getByRole('list', { name: /next actions tasks list/i });
        const titles = getRenderedTaskTitles(column, ['Task Q', 'Task W', 'Task E', 'Task R']);
        expect(titles).toEqual(['Task E', 'Task Q', 'Task W', 'Task R']);
    });

    it('filters board tasks to the selected context', () => {
        setBoardStoreState({
            tasks: [
                {
                    id: 'work-task',
                    title: 'Work task',
                    status: 'next',
                    contexts: ['@work'],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
                {
                    id: 'home-task',
                    title: 'Home task',
                    status: 'next',
                    contexts: ['@home'],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
            ],
            projects: [],
            areas: [],
            settings: {},
        });
        useUiStore.setState({ boardFilters: { criteria: { contexts: ['@work'] } } });

        const { getByText, queryByText } = renderWithProviders();

        expect(getByText('Work task')).toBeInTheDocument();
        expect(queryByText('Home task')).not.toBeInTheDocument();
    });

    it('filters board tasks by the selected due-date preset', () => {
        setBoardStoreState({
            tasks: [
                {
                    id: 'overdue-task',
                    title: 'Overdue task',
                    status: 'next',
                    dueDate: '2020-01-01',
                    contexts: [],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
                {
                    id: 'future-task',
                    title: 'Future task',
                    status: 'next',
                    dueDate: '2999-01-01',
                    contexts: [],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
            ],
            projects: [],
            areas: [],
            settings: {},
        });
        useUiStore.setState({ boardFilters: { criteria: { dueDateRange: { preset: 'overdue' } } } });

        const { getByText, queryByText } = renderWithProviders();

        expect(getByText('Overdue task')).toBeInTheDocument();
        expect(queryByText('Future task')).not.toBeInTheDocument();
    });

    it('toggles a context filter from the board filter panel', () => {
        setBoardStoreState({
            tasks: [
                {
                    id: 'work-task',
                    title: 'Work task',
                    status: 'next',
                    contexts: ['@work'],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
                {
                    id: 'home-task',
                    title: 'Home task',
                    status: 'next',
                    contexts: ['@home'],
                    tags: [],
                    createdAt: '2026-05-18T12:00:00.000Z',
                    updatedAt: '2026-05-18T12:00:00.000Z',
                },
            ],
            projects: [],
            areas: [],
            settings: {},
        });

        const { getByRole, getByText, queryByText } = renderWithProviders();

        fireEvent.click(getByRole('button', { name: /^show$/i }));
        fireEvent.click(getByRole('button', { name: '@work' }));

        expect(getByText('Work task')).toBeInTheDocument();
        expect(queryByText('Home task')).not.toBeInTheDocument();
    });

    it('uses the selected task sort instead of manual board order when non-default sort is selected', () => {
        const baseTask = {
            status: 'next' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-05-18T12:00:00.000Z',
            updatedAt: '2026-05-18T12:00:00.000Z',
        };
        setBoardStoreState({
            tasks: [
                { ...baseTask, id: 'task-q', title: 'Task Q', boardOrder: 1, createdAt: '2026-05-18T12:00:00.000Z' },
                { ...baseTask, id: 'task-w', title: 'Task W', boardOrder: 2, createdAt: '2026-05-19T12:00:00.000Z' },
                { ...baseTask, id: 'task-e', title: 'Task E', boardOrder: 0, createdAt: '2026-05-20T12:00:00.000Z' },
                { ...baseTask, id: 'task-r', title: 'Task R', createdAt: '2026-05-21T12:00:00.000Z' },
            ],
            projects: [],
            areas: [],
            settings: { taskSortBy: 'created-desc' },
        });

        const { getByRole, getByText } = renderWithProviders();

        const column = getByRole('list', { name: /next actions tasks list/i });
        const titles = getRenderedTaskTitles(column, ['Task Q', 'Task W', 'Task E', 'Task R']);
        expect(titles).toEqual(['Task R', 'Task E', 'Task W', 'Task Q']);
        expect(getByText('Ordering follows the selected sort. Switch to default sort to reorder cards.')).toBeInTheDocument();
    });
});
