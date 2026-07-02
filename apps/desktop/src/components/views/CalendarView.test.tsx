import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { CalendarView } from './CalendarView';
import { combineDateAndTime } from './calendar/useDesktopCalendarController';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';
import { setCalendarTaskDragData } from '../../lib/calendar-task-drag';

const storeMocks = vi.hoisted(() => {
    const taskStoreState = {
        addProject: vi.fn(async () => null),
        addTask: vi.fn(async () => ({ success: true, id: 'task-new' })),
        areas: [] as Area[],
        deleteTask: vi.fn(async () => {}),
        getDerivedState: () => ({
            allContexts: Array.from(new Set(taskStoreState.tasks.flatMap((task) => task.contexts ?? []))).sort(),
            allTags: Array.from(new Set(taskStoreState.tasks.flatMap((task) => task.tags ?? []))).sort(),
            projectMap: new Map(taskStoreState.projects.map((project) => [project.id, project])),
            sequentialProjectIds: new Set(taskStoreState.projects.filter((project) => project.isSequential).map((project) => project.id)),
            sequentialWithinSectionProjectIds: new Set(taskStoreState.projects.filter((project) => project.isSequential && project.sequentialScope === 'section').map((project) => project.id)),
        }),
        projects: [] as Project[],
        setError: vi.fn(),
        settings: {
            diagnostics: {
                loggingEnabled: false,
            },
            weekStart: 'sunday',
        },
        tasks: [] as Task[],
        updateTask: vi.fn(async () => {}),
    };

    return { taskStoreState };
});

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const useTaskStore = Object.assign(
        (selector: (state: typeof storeMocks.taskStoreState) => unknown) => selector(storeMocks.taskStoreState),
        {
            getState: () => storeMocks.taskStoreState,
            subscribe: vi.fn(),
        }
    );

    return {
        ...actual,
        isTaskInActiveProject: () => true,
        safeFormatDate: (value: Date) => value.toISOString(),
        safeParseDate: (value: string) => new Date(value),
        safeParseDueDate: (value: string) => new Date(value),
        shallow: () => false,
        useTaskStore,
    };
});

vi.mock('../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: (warnings: string[]) => {
        if (warnings.length === 0) return null;
        if (warnings.length === 1) return warnings[0];
        return `${warnings[0]} (+${warnings.length - 1} more)`;
    },
}));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const makeArea = (overrides: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Area',
    color: '#94a3b8',
    order: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const renderCalendar = () => render(
    <LanguageProvider>
        <CalendarView />
    </LanguageProvider>
);

const flushCalendarEffects = async () => {
    await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
    });
};

const selectDay = async (dayText: string) => {
    await act(async () => {
        fireEvent.click(screen.getByText(dayText).closest('.group') as HTMLElement);
        await Promise.resolve();
    });
};

const openNewTaskComposerForDay = async (dayText: string) => {
    await selectDay(dayText);
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /add new task/i }));
        await Promise.resolve();
    });
};

const createTaskDragDataTransfer = (taskId: string, itemKind?: 'scheduled' | 'deadline'): DataTransfer => {
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
        dropEffect: 'none' as DataTransfer['dropEffect'],
        effectAllowed: 'all' as DataTransfer['effectAllowed'],
        types,
        getData: vi.fn((type: string) => values.get(type) ?? ''),
        setData: vi.fn((type: string, value: string) => {
            values.set(type, value);
            if (!types.includes(type)) types.push(type);
        }),
    } as unknown as DataTransfer;
    setCalendarTaskDragData(dataTransfer, taskId, { itemKind });
    return dataTransfer;
};

describe('CalendarView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(),
        });
        window.history.replaceState(null, '', '/');
        window.localStorage.clear();
        storeMocks.taskStoreState.tasks = [];
        storeMocks.taskStoreState.projects = [];
        storeMocks.taskStoreState.areas = [];
        storeMocks.taskStoreState.addProject.mockClear();
        storeMocks.taskStoreState.addTask.mockClear();
        storeMocks.taskStoreState.addTask.mockResolvedValue({ success: true, id: 'task-new' });
        storeMocks.taskStoreState.updateTask.mockClear();
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars: [], events: [], warnings: [] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the today marker with explicit primary contrast tokens', async () => {
        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            await Promise.resolve();
        });

        const todayNumber = screen.getByText('3');
        const markerStyle = todayNumber.parentElement?.getAttribute('style') ?? '';
        expect(markerStyle).toContain('background-color: hsl(var(--primary));');
        expect(markerStyle).toContain('color: hsl(var(--primary-foreground));');
    });

    it('starts a restored schedule view from today instead of the first day of the month', async () => {
        window.history.replaceState(null, '', '/?calendarView=schedule&calendarMonth=2026-04');
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'month-start-task',
                title: 'Month start task',
                dueDate: '2026-04-01T12:00:00',
                startTime: '2026-04-01T12:00:00',
            }),
            makeTask({
                id: 'today-task',
                title: 'Today task',
                dueDate: '2026-04-03T12:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.queryByText('Month start task')).not.toBeInTheDocument();
        expect(screen.getAllByText('Today task').length).toBeGreaterThan(0);
        expect(window.location.search).toContain('calendarDate=2026-04-03');
    });

    it('rejects rolled-over date values in calendar composer parsing', () => {
        expect(combineDateAndTime('2026-02-30', '09:00')).toBeNull();
        expect(combineDateAndTime('2026-02-28', '09:00')?.getDate()).toBe(28);
    });

    it('shows external events that span into the selected day', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Launch window',
                start: '2026-04-02T23:30:00',
                end: '2026-04-03T00:30:00',
                allDay: false,
            }],
            warnings: [],
        });

        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            vi.runAllTimers();
            await Promise.resolve();
        });

        await act(async () => {
            fireEvent.click(screen.getByText('3').closest('.group') as HTMLElement);
            await Promise.resolve();
        });

        expect(screen.getAllByText(/Launch window/).length).toBeGreaterThan(0);

        const searchInput = document.querySelector('[data-view-filter-input]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'not-launch' } });
            await Promise.resolve();
        });

        expect(screen.getByText('No matching calendar items in this view')).toBeInTheDocument();
        expect(screen.queryByText(/Launch window/)).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Launch' } });
            await Promise.resolve();
        });

        expect(screen.getByText('1 matches in this view')).toBeInTheDocument();
        expect(screen.getAllByText(/Launch window/).length).toBeGreaterThan(0);
    });

    it('surfaces partial external calendar failures without dropping loaded events', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [],
            events: [],
            warnings: ['Failed to load "Work": HTTP 504'],
        });

        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            vi.runAllTimers();
            await Promise.resolve();
        });

        expect(screen.getByText(/Failed to load "Work": HTTP 504/)).toBeInTheDocument();
    });

    it('creates a task from a selected external calendar event', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Launch window',
                start: '2026-04-03T10:00:00.000Z',
                end: '2026-04-03T10:45:00.000Z',
                allDay: false,
                description: 'Discuss launch.',
                location: 'Room 1',
            }],
            warnings: [],
        });

        renderCalendar();
        await flushCalendarEffects();
        await selectDay('3');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /create task: launch window/i }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.addTask).toHaveBeenCalledWith('Launch window', {
            status: 'next',
            startTime: '2026-04-03T10:00:00.000Z',
            timeEstimate: 'custom:45',
            location: 'Room 1',
            description: 'Discuss launch.\n\nCalendar: Work',
        });
    });

    it('opens the day view when month overflow is clicked', async () => {
        storeMocks.taskStoreState.tasks = Array.from({ length: 5 }, (_, index) => makeTask({
            id: `overflow-task-${index}`,
            title: `Overflow task ${index + 1}`,
            dueDate: '2026-04-04T12:00:00',
        }));

        renderCalendar();
        await flushCalendarEffects();

        const overflowButton = screen.getByRole('button', { name: /open day view: apr 4, 2026/i });
        await act(async () => {
            fireEvent.click(overflowButton);
            await Promise.resolve();
        });

        expect(window.location.search).toContain('calendarView=day');
        expect(window.location.search).toContain('calendarDate=2026-04-04');
        expect(screen.queryByText('+2 more')).not.toBeInTheDocument();
    });

    it('opens an empty month day from the keyboard', async () => {
        renderCalendar();
        await flushCalendarEffects();

        const dayCell = screen.getByRole('button', { name: /apr 5, 2026, open day view/i });
        await act(async () => {
            fireEvent.keyDown(dayCell, { key: 'Enter' });
            await Promise.resolve();
        });

        expect(window.location.search).toContain('calendarView=day');
        expect(window.location.search).toContain('calendarDate=2026-04-05');
    });

    it('rejects composer submissions when the end time is before the start time', async () => {
        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Draft launch note' } });
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '07:45' } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(screen.getByText('Choose a valid start and end time.')).toBeInTheDocument();
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });

    it('rejects composer submissions that overlap visible external events', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Standup',
                start: '2026-04-04T08:00:00',
                end: '2026-04-04T09:00:00',
                allDay: false,
            }],
            warnings: [],
        });

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Prepare notes' } });
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '08:30' } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(screen.getByText('That time overlaps with an event. Please choose a free slot.')).toBeInTheDocument();
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });

    it('parses quick-add syntax when creating a scheduled task from the calendar composer', async () => {
        storeMocks.taskStoreState.projects = [
            makeProject({ id: 'project-launch', title: 'Launch' }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), {
            target: { value: 'Draft launch note +Launch @computer #deep /note:Outline next steps' },
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.addTask).toHaveBeenCalledWith('Draft launch note', expect.objectContaining({
            contexts: ['@computer'],
            description: 'Outline next steps',
            projectId: 'project-launch',
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            status: 'next',
            tags: ['#deep'],
            timeEstimate: '30min',
        }));
        expect(storeMocks.taskStoreState.addProject).not.toHaveBeenCalled();
    });

    it('shows quick-add autocomplete options in the calendar composer', async () => {
        storeMocks.taskStoreState.projects = [
            makeProject({ id: 'project-launch', title: 'Launch' }),
        ];
        storeMocks.taskStoreState.areas = [
            makeArea({ id: 'area-work', name: 'Work' }),
        ];
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-token-source',
                contexts: ['@computer'],
                tags: ['#deep'],
                title: 'Token source',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        const titleInput = screen.getByLabelText('Task title') as HTMLInputElement;
        const updateTitle = (value: string, key: string) => {
            fireEvent.change(titleInput, { target: { value } });
            titleInput.setSelectionRange(value.length, value.length);
            fireEvent.keyUp(titleInput, { key });
        };

        updateTitle('Draft +L', 'L');
        expect(screen.getByRole('option', { name: 'Launch' })).toBeInTheDocument();

        updateTitle('Draft !W', 'W');
        expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument();

        updateTitle('Draft #d', 'd');
        expect(screen.getByRole('option', { name: '#deep' })).toBeInTheDocument();

        updateTitle('Draft @c', 'c');
        expect(screen.getByRole('option', { name: '@computer' })).toBeInTheDocument();
    });

    it('saves existing tasks from the calendar composer', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-existing',
                title: 'Write proposal',
                timeEstimate: '1hr',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.click(screen.getByRole('button', { name: 'Existing task' }));
        fireEvent.click(screen.getByRole('button', { name: /Write proposal/ }));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('task-existing', expect.objectContaining({
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            timeEstimate: '1hr',
        }));
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });

    it('plans unscheduled next actions from the calendar side panel', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
            makeTask({
                id: 'task-deadline',
                title: 'Review deadline brief',
                dueDate: '2026-04-10T17:00:00.000Z',
            }),
            makeTask({
                id: 'task-scheduled',
                title: 'Already scheduled',
                startTime: '2026-04-04T09:00:00.000Z',
            }),
            makeTask({
                id: 'task-focused',
                title: 'Focused today',
                isFocusedToday: true,
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const panel = screen.getByText('Plan next actions').closest('aside') as HTMLElement;
        expect(within(panel).getByText('Draft planning memo')).toBeInTheDocument();
        expect(within(panel).getByText('Review deadline brief')).toBeInTheDocument();
        expect(within(panel).queryByText('Already scheduled')).not.toBeInTheDocument();
        expect(within(panel).queryByText('Focused today')).not.toBeInTheDocument();

        await selectDay('4');
        const planTitle = panel.querySelector('[data-task-id="task-plan"]') as HTMLElement;
        const planCard = planTitle.parentElement as HTMLElement;
        await act(async () => {
            fireEvent.click(within(planCard).getByRole('button', { name: 'Schedule' }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('task-plan', expect.objectContaining({
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
        }));
    });


    it('explains disabled planning schedule buttons until a day is selected', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const panel = screen.getByText('Plan next actions').closest('aside') as HTMLElement;
        const planTitle = within(panel).getByText('Draft planning memo');
        const planCard = planTitle.closest('.rounded-md') as HTMLElement;
        const disabledHintTarget = within(planCard).getByTitle('Select a day to plan first.');
        const scheduleButton = within(disabledHintTarget).getByRole('button', { name: 'Schedule' });

        expect(scheduleButton).toBeDisabled();
        expect(within(planCard).getByText('Select a day to plan first.')).toHaveClass('sr-only');

        await selectDay('4');

        expect(within(planCard).queryByTitle('Select a day to plan first.')).not.toBeInTheDocument();
        expect(within(planCard).getByRole('button', { name: 'Schedule' })).toBeEnabled();
    });

    it('collapses and expands the calendar planning panel', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.getByText('Draft planning memo')).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Collapse planning panel' }));
            await Promise.resolve();
        });

        expect(screen.queryByText('Draft planning memo')).not.toBeInTheDocument();
        expect(window.localStorage.getItem('mindwtr.calendar.planningPanelCollapsed')).toBe('true');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Expand planning panel' }));
            await Promise.resolve();
        });

        expect(screen.getByText('Draft planning memo')).toBeInTheDocument();
        expect(window.localStorage.getItem('mindwtr.calendar.planningPanelCollapsed')).toBe('false');
    });

    it('shows date-only start times as all-day scheduled tasks on the calendar', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-date-only',
                title: 'Date-only start',
                startTime: '2026-04-04',
            }),
            makeTask({
                id: 'task-timed',
                title: 'Timed start',
                startTime: '2026-04-04T09:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.getByText('Date-only start')).toBeInTheDocument();
        expect(screen.getByText('Timed start')).toBeInTheDocument();
    });

    it('sets a task due date when dropped on a month day', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'drop-task',
                title: 'Drop me',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-04"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('drop-task');
        await act(async () => {
            fireEvent.dragOver(dropTarget, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('drop-task', {
            dueDate: '2026-04-04',
        });
    });

    it('moves a deadline item without changing the scheduled start time', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'mixed-drop-task',
                title: 'Mixed drop task',
                dueDate: '2026-04-03',
                startTime: '2026-04-03T09:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('mixed-drop-task', 'deadline');
        await act(async () => {
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('mixed-drop-task', {
            dueDate: '2026-04-05',
        });
    });

    it('schedules a task when dropped on a timed calendar slot', async () => {
        window.history.replaceState(null, '', '/?calendarView=week&calendarDate=2026-04-03');
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'timed-drop-task',
                title: 'Schedule me',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-timed-drop-date="2026-04-03"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();
        Object.defineProperty(dropTarget, 'getBoundingClientRect', {
            value: () => ({
                bottom: 24 * 56,
                height: 24 * 56,
                left: 0,
                right: 320,
                top: 0,
                width: 320,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
        });

        const dataTransfer = createTaskDragDataTransfer('timed-drop-task');
        await act(async () => {
            const dragOverEvent = createEvent.dragOver(dropTarget, { dataTransfer });
            Object.defineProperty(dragOverEvent, 'clientY', { value: 9 * 56 });
            fireEvent(dropTarget, dragOverEvent);
            const dropEvent = createEvent.drop(dropTarget, { dataTransfer });
            Object.defineProperty(dropEvent, 'clientY', { value: 9 * 56 });
            fireEvent(dropTarget, dropEvent);
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('timed-drop-task', {
            startTime: new Date(2026, 3, 3, 9, 0).toISOString(),
        });
    });

    it('moves an existing calendar task by dragging it to another day', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'calendar-drag-task',
                title: 'Move me',
                dueDate: '2026-04-03T12:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const taskButton = screen.getByRole('button', { name: /Move me/i });
        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('');
        await act(async () => {
            fireEvent.dragStart(taskButton, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('calendar-drag-task', {
            dueDate: '2026-04-05',
        });
    });

    it('moves an existing timed calendar task to another day without turning it into a deadline', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'calendar-timed-drag-task',
                title: 'Move timed task',
                startTime: '2026-04-03T11:15:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const taskButton = screen.getByRole('button', { name: /Move timed task/i });
        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('');
        await act(async () => {
            fireEvent.dragStart(taskButton, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('calendar-timed-drag-task', {
            startTime: new Date(2026, 3, 5, 11, 15).toISOString(),
        });
    });
});
