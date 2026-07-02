import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Section, Task } from '@mindwtr/core';

import { useUiStore } from '../../../store/ui-store';
import { LanguageProvider } from '../../../contexts/language-context';
import { KeybindingProvider } from '../../../contexts/keybinding-context';
import { ProjectWorkspace } from './ProjectWorkspace';

vi.mock('../../TaskItem', () => ({
    TaskItem: ({
        task,
        selectionMode,
        isMultiSelected,
        onToggleSelect,
    }: {
        task: Task;
        selectionMode?: boolean;
        isMultiSelected?: boolean;
        onToggleSelect?: (options?: { range?: boolean }) => void;
    }) => (
        <div data-task-id={task.id}>
            {selectionMode && (
                <input
                    type="checkbox"
                    aria-label="Select task"
                    checked={Boolean(isMultiSelected)}
                    onClick={(event) => onToggleSelect?.({ range: event.shiftKey })}
                    onChange={() => undefined}
                />
            )}
            <span>{task.title}</span>
        </div>
    ),
}));

vi.mock('./SortableRows', () => ({
    SortableProjectTaskRow: ({ task }: { task: Task }) => (
        <div data-sortable-task-id={task.id} data-task-id={task.id}>
            <span>{task.title}</span>
        </div>
    ),
}));

vi.mock('../../PromptModal', () => ({
    PromptModal: () => null,
}));

vi.mock('../../TokenPickerModal', () => ({
    TokenPickerModal: () => null,
}));

vi.mock('./ProjectDetailsHeader', () => ({
    ProjectDetailsHeader: ({ project }: { project: Project }) => <div>{project.title}</div>,
}));

vi.mock('./ProjectDetailsFields', () => ({
    ProjectDetailsFields: () => null,
}));

vi.mock('./ProjectNotesSection', () => ({
    ProjectNotesSection: () => null,
}));

const translations: Record<string, string> = {
    'bulk.addContext': 'Add context',
    'bulk.addTag': 'Add tag',
    'bulk.delete': 'Delete',
    'bulk.exitSelect': 'Exit Select',
    'bulk.moveTo': 'Move to',
    'bulk.organize': 'Bulk organize',
    'bulk.removeContext': 'Remove context',
    'bulk.removeTag': 'Remove tag',
    'bulk.select': 'Select',
    'bulk.selected': 'selected',
    'common.all': 'All',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.save': 'Save',
    'common.search': 'Search...',
    'common.tasks': 'tasks',
    'list.confirmBatchDelete': 'Delete selected tasks?',
    'projects.addSection': 'Add section',
    'projects.addTask': 'Add task',
    'projects.addTaskPlaceholder': 'Add task',
    'projects.areaLabel': 'Area',
    'projects.noActiveTasks': 'No active tasks',
    'projects.sectionsLabel': 'Tasks',
    'sort.default': 'Default',
    'sort.due': 'Due date',
    'sort.label': 'Sort',
    'status.done': 'Done',
    'status.inbox': 'Inbox',
    'status.next': 'Next',
    'status.reference': 'Reference',
    'status.someday': 'Someday',
    'status.waiting': 'Waiting',
    'taskEdit.noAreaOption': 'No area',
};

const t = (key: string) => translations[key] ?? key;

const project: Project = {
    id: 'project-1',
    title: 'Launch',
    color: '#3b82f6',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const projectSection: Section = {
    id: 'section-1',
    projectId: project.id,
    title: 'Planning',
    order: 0,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
};

const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title,
    status: 'next',
    projectId: project.id,
    tags: [],
    contexts: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
});

type ProjectWorkspaceProps = ComponentProps<typeof ProjectWorkspace>;

const defaultProps: ProjectWorkspaceProps = {
    addSection: vi.fn(),
    allTasks: [],
    allTokens: [],
    areaById: new Map(),
    areas: [],
    batchDeleteTasks: vi.fn(),
    batchMoveTasks: vi.fn(),
    batchUpdateTasks: vi.fn(),
    deleteProject: vi.fn(),
    deleteSection: vi.fn(),
    highlightTaskId: null,
    isAreaCreating: false,
    isCreatingProject: false,
    language: 'en',
    noAreaId: '__none__',
    onDuplicateProject: vi.fn(),
    onManageAreas: vi.fn(),
    onRequestQuickArea: vi.fn(),
    onToggleShowCompletedTasks: vi.fn(),
    projects: [project],
    reorderProjectTasks: vi.fn(),
    reorderSections: vi.fn(),
    requestConfirmation: vi.fn(),
    restoreProject: vi.fn(),
    sections: [],
    selectedProject: project,
    selectedProjectId: project.id,
    setHighlightTask: vi.fn(),
    setSelectedProjectId: vi.fn(),
    showCompletedTasks: false,
    showToast: vi.fn(),
    sortedAreas: [],
    t,
    undoNotificationsEnabled: true,
    updateProject: vi.fn(),
    updateSection: vi.fn(),
    updateTask: vi.fn(),
};

const renderWorkspace = (overrides: Partial<ProjectWorkspaceProps> = {}) => render(
    <ProjectWorkspace
        {...defaultProps}
        {...overrides}
    />
);

const renderWorkspaceWithKeybindings = (overrides: Partial<ProjectWorkspaceProps> = {}) => render(
    <LanguageProvider>
        <KeybindingProvider currentView="projects" onNavigate={vi.fn()}>
            <ProjectWorkspace
                {...defaultProps}
                {...overrides}
            />
        </KeybindingProvider>
    </LanguageProvider>
);

describe('ProjectWorkspace Select mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUiStore.setState({ editingTaskId: null });
    });

    it('opens global quick add with the selected project defaults', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getByRole } = renderWorkspace();

        fireEvent.click(getByRole('button', { name: 'Add task' }));

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        const event = quickAddListener.mock.calls[0]?.[0] as CustomEvent;
        expect(event.detail).toEqual({
            initialProps: {
                projectId: project.id,
                status: 'next',
            },
        });
        expect(useUiStore.getState().editingTaskId).toBeNull();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('opens default quick add from the app-scoped add-task shortcut', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);

        renderWorkspaceWithKeybindings();

        fireEvent.keyDown(window, { key: 'a' });

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        expect((quickAddListener.mock.calls[0]?.[0] as CustomEvent).detail).toBeUndefined();
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('opens global quick add with section defaults from section add buttons', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getAllByRole } = renderWorkspace({
            sections: [projectSection],
        });

        fireEvent.click(getAllByRole('button', { name: 'Add task' })[1]);

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        const event = quickAddListener.mock.calls[0]?.[0] as CustomEvent;
        expect(event.detail).toEqual({
            initialProps: {
                projectId: project.id,
                sectionId: projectSection.id,
                status: 'next',
            },
        });
        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('renders a newly created save-and-edit task outside the initial virtualized project rows', () => {
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        const scrollIntoView = vi.fn();
        const existingTasks = Array.from({ length: 130 }, (_, index) => (
            task(`task-${index}`, `Task ${index}`, {
                createdAt: `2026-05-12T00:${String(index).padStart(2, '0')}:00.000Z`,
                updatedAt: `2026-05-12T00:${String(index).padStart(2, '0')}:00.000Z`,
            })
        ));
        const createdTask = task('task-created', 'New project task', {
            createdAt: '2026-05-12T02:10:00.000Z',
            updatedAt: '2026-05-12T02:10:00.000Z',
        });
        const tasks = [...existingTasks, createdTask];
        act(() => {
            useUiStore.setState({ editingTaskId: createdTask.id });
        });
        HTMLElement.prototype.scrollIntoView = scrollIntoView;

        try {
            const { container, getByText } = renderWorkspace({
                allTasks: tasks,
                highlightTaskId: createdTask.id,
            });

            expect(container.querySelector('[data-virtualized-task-list="true"]')).toBeInTheDocument();
            expect(container.querySelector('[data-index="130"]')).toBeInTheDocument();
            expect(getByText('New project task')).toBeInTheDocument();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        } finally {
            HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
        }
    });

    it('sorts completed project tasks by most recent completion first', () => {
        const { container, getByRole } = renderWorkspace({
            showCompletedTasks: true,
            allTasks: [
                task('done-old', 'Old finish', {
                    status: 'done',
                    completedAt: '2026-05-12T09:00:00.000Z',
                    updatedAt: '2026-05-12T09:00:00.000Z',
                }),
                task('done-newest', 'Newest finish', {
                    status: 'done',
                    completedAt: '2026-05-12T11:00:00.000Z',
                    updatedAt: '2026-05-12T11:00:00.000Z',
                }),
                task('done-middle', 'Middle finish', {
                    status: 'done',
                    completedAt: '2026-05-12T10:00:00.000Z',
                    updatedAt: '2026-05-12T10:00:00.000Z',
                }),
            ],
        });

        fireEvent.click(getByRole('button', { name: /Done/ }));

        expect(Array.from(container.querySelectorAll('[data-task-id]')).map((row) => row.getAttribute('data-task-id'))).toEqual([
            'done-newest',
            'done-middle',
            'done-old',
        ]);
    });

    it('restores project scroll after expanding completed tasks and entering selection mode', () => {
        const { container, getByRole } = renderWorkspace({
            showCompletedTasks: true,
            allTasks: [
                task('active-1', 'Active task'),
                task('done-1', 'Finished one', {
                    status: 'done',
                    completedAt: '2026-05-12T10:00:00.000Z',
                }),
                task('done-2', 'Finished two', {
                    status: 'done',
                    completedAt: '2026-05-12T11:00:00.000Z',
                }),
            ],
        });
        const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement;
        expect(scrollContainer).toBeTruthy();

        scrollContainer.scrollTop = 420;
        fireEvent.click(getByRole('button', { name: /Done/ }));

        expect(scrollContainer.scrollTop).toBe(420);

        scrollContainer.scrollTop = 360;
        fireEvent.click(getByRole('button', { name: 'Select' }));

        expect(scrollContainer.scrollTop).toBe(360);
    });

    it('keeps the first visible project task anchored when Select expands the toolbar', () => {
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const getRect = (top: number, bottom: number) => ({
            top,
            bottom,
            left: 0,
            right: 320,
            width: 320,
            height: bottom - top,
            x: 0,
            y: top,
            toJSON: () => ({}),
        } as DOMRect);

        try {
            const { container, getByRole } = renderWorkspace({
                allTasks: [
                    task('task-1', 'Earlier task'),
                    task('task-2', 'Visible task'),
                ],
            });
            const scrollContainer = container.querySelector('[data-project-scroll-container]') as HTMLDivElement;
            expect(scrollContainer).toBeTruthy();

            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getMockRect(this: HTMLElement) {
                const element = this as HTMLElement;
                if (element === scrollContainer) return getRect(0, 600);
                if (element.getAttribute('data-task-id') === 'task-1') return getRect(-120, -80);
                if (element.getAttribute('data-task-id') === 'task-2') {
                    const selectModeActive = document.body.textContent?.includes('Exit Select') ?? false;
                    return getRect(selectModeActive ? 160 : 120, selectModeActive ? 200 : 160);
                }
                return originalGetBoundingClientRect.call(element);
            });

            scrollContainer.scrollTop = 360;
            fireEvent.click(getByRole('button', { name: 'Select' }));

            expect(scrollContainer.scrollTop).toBe(400);
        } finally {
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('shows bulk organize and area assignment for selected project tasks', () => {
        const area = {
            id: 'area-1',
            name: 'Work',
            color: '#2563eb',
            order: 0,
            createdAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
        };
        const projectTask = task('task-1', 'Move me');
        const { getByRole } = renderWorkspace({
            allTasks: [projectTask],
            areas: [area],
            sortedAreas: [area],
            selectedProjectTasks: [projectTask],
        });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('checkbox', { name: 'Select task' }));

        expect(getByRole('button', { name: 'Bulk organize' })).toBeInTheDocument();
        expect(getByRole('combobox', { name: 'Area' })).toBeInTheDocument();
    });

    it('retries scrolling to a highlighted project task after navigation', async () => {
        vi.useFakeTimers();
        const highlightedTask = task('task-1', 'Highlighted task');
        const scrollIntoView = vi.fn();
        let highlightQueryCount = 0;
        const originalQuerySelector = document.querySelector.bind(document);
        const querySelectorSpy = vi.spyOn(document, 'querySelector').mockImplementation((selector) => {
            if (selector === '[data-task-id="task-1"]') {
                highlightQueryCount += 1;
                return highlightQueryCount === 1
                    ? null
                    : ({ scrollIntoView } as unknown as Element);
            }
            return originalQuerySelector(selector);
        });

        try {
            renderWorkspace({
                allTasks: [highlightedTask],
                highlightTaskId: highlightedTask.id,
            });

            expect(scrollIntoView).not.toHaveBeenCalled();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(50);
            });

            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        } finally {
            querySelectorSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('selects all visible project tasks and clears the selection', () => {
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
        ];
        const { getAllByRole, getByRole } = renderWorkspace({ allTasks });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        expect(getByRole('button', { name: 'Select All' })).toBeEnabled();
        expect(getByRole('button', { name: 'Clear' })).toBeDisabled();

        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);
        expect(getByRole('button', { name: 'Select All' })).toBeDisabled();
        expect(getByRole('button', { name: 'Clear' })).toBeEnabled();

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('selects a contiguous project task range with shift-click', () => {
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
            task('task-3', 'Third task'),
        ];
        const { getAllByRole, getByRole } = renderWorkspace({ allTasks });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        const checkboxes = getAllByRole('checkbox', { name: 'Select task' });

        fireEvent.click(checkboxes[0]);
        fireEvent.click(checkboxes[2], { shiftKey: true });

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true, true]);
    });

    it('bulk deletes selected project tasks after confirmation', async () => {
        const batchDeleteTasks = vi.fn();
        const requestConfirmation = vi.fn().mockResolvedValue(true);
        const allTasks = [
            task('task-1', 'First task'),
            task('task-2', 'Second task'),
        ];
        const { getByRole } = renderWorkspace({
            allTasks,
            batchDeleteTasks,
            requestConfirmation,
        });

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));
        fireEvent.click(getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(requestConfirmation).toHaveBeenCalled();
            expect(batchDeleteTasks).toHaveBeenCalledWith(['task-1', 'task-2']);
        });
    });

    it('bounds mounted rows for large project task lists', async () => {
        const allTasks = Array.from({ length: 200 }, (_, index) => (
            task(`task-${index}`, `Task ${index}`)
        ));
        const { container } = renderWorkspace({ allTasks });

        await waitFor(() => {
            const virtualList = container.querySelector('[data-virtualized-task-list="true"]');
            expect(virtualList).not.toBeNull();

            const mountedRows = container.querySelectorAll('[data-virtualized-task-list="true"] [data-index]');
            expect(mountedRows.length).toBeGreaterThan(0);
            expect(mountedRows.length).toBeLessThan(80);
        });
    });


    it('clears project search from an inline clear button and refocuses the field', () => {
        const { getByLabelText, getByPlaceholderText, queryByLabelText } = renderWorkspace();
        const input = getByPlaceholderText('Search...') as HTMLInputElement;

        expect(queryByLabelText('Clear search')).toBeNull();

        fireEvent.change(input, { target: { value: 'first' } });
        const clearButton = getByLabelText('Clear search');
        fireEvent.click(clearButton);

        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(queryByLabelText('Clear search')).toBeNull();
    });

    it('keeps select grouped with project task controls instead of the search row', () => {
        const { container, getByRole } = renderWorkspace();
        const selectButton = getByRole('button', { name: 'Select' });
        const searchRow = container.querySelector('[data-project-search-row]');
        const toolbar = container.querySelector('[data-project-task-toolbar]');

        expect(searchRow).not.toBeNull();
        expect(toolbar).not.toBeNull();
        expect(searchRow).not.toContainElement(selectButton);
        expect(toolbar).toContainElement(selectButton);
    });

    it('condenses the project task toolbar while scrolled down and expands at the top', () => {
        const allTasks = Array.from({ length: 120 }, (_, index) => task(`task-${index}`, `Task ${index}`));
        const { container } = renderWorkspace({ allTasks });
        const scrollContainer = container.querySelector('[data-project-scroll-container]') as HTMLDivElement;
        const toolbar = container.querySelector('[data-project-task-toolbar]');

        expect(scrollContainer).toBeTruthy();
        expect(toolbar).toHaveAttribute('data-compact', 'false');

        scrollContainer.scrollTop = 140;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'true');

        scrollContainer.scrollTop = 64;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'true');

        scrollContainer.scrollTop = 0;
        fireEvent.scroll(scrollContainer);
        expect(toolbar).toHaveAttribute('data-compact', 'false');
    });

    it('sorts visible project tasks by due date when selected', () => {
        const allTasks = [
            task('task-no-due', 'No due', { createdAt: '2026-05-01T00:00:00.000Z', order: 0 }),
            task('task-later', 'Later due', { createdAt: '2026-05-02T00:00:00.000Z', dueDate: '2026-07-01', order: 1 }),
            task('task-soon', 'Soon due', { createdAt: '2026-05-03T00:00:00.000Z', dueDate: '2026-06-01', order: 2 }),
        ];
        const { container, getByRole } = renderWorkspace({ allTasks });
        const taskTitles = () => Array.from(container.querySelectorAll('[data-task-id] span')).map((item) => item.textContent);

        expect(taskTitles()).toEqual(['No due', 'Later due', 'Soon due']);

        fireEvent.click(getByRole('button', { name: 'Due date' }));

        expect(taskTitles()).toEqual(['Soon due', 'Later due', 'No due']);
    });
});
