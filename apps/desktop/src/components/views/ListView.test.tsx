import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { restoreDeletedTasksWithFeedback } from './list/useListSelection';
import { ListView, reportArchivedTaskQueryFailure } from './ListView';

const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/report-error', () => ({
  reportError: reportErrorMock,
}));

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const now = new Date().toISOString();
const referenceViewStateStorageKey = 'mindwtr:view:reference:v1';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const renderStaticListView = (statusFilter: 'inbox' | 'done', title: string) =>
  renderToStaticMarkup(
    <LanguageProvider>
      <KeybindingProvider currentView={statusFilter} onNavigate={() => {}}>
        <ListView title={title} statusFilter={statusFilter} />
      </KeybindingProvider>
    </LanguageProvider>
  );

const renderListView = (statusFilter: 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'archived' | 'reference' = 'next', title = 'Next') =>
  render(
    <LanguageProvider>
      <KeybindingProvider currentView={statusFilter} onNavigate={() => {}}>
        <ListView title={title} statusFilter={statusFilter} />
      </KeybindingProvider>
    </LanguageProvider>
  );

describe('ListView', () => {
  beforeEach(() => {
    reportErrorMock.mockReset();
    window.localStorage.removeItem(referenceViewStateStorageKey);

    useTaskStore.setState(initialTaskState, true);
    useUiStore.setState(initialUiState, true);

    useTaskStore.setState({
      _allTasks: [],
      _allProjects: [],
      _allAreas: [],
      settings: {},
      lastDataChangeAt: 0,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: {
        criteria: {},
        open: false,
      },
      listOptions: {
        showDetails: false,
        nextGroupBy: 'none',
        referenceGroupBy: 'area',
        focusTop3Only: false,
      },
      projectView: {
        selectedProjectId: null,
      },
      editingTaskId: null,
      expandedTaskIds: {},
    }));
  });

  it('renders the view title', () => {
    const html = renderStaticListView('inbox', 'Inbox');
    expect(html).toContain('Inbox');
  });

  it('does not render local search input in inbox view', () => {
    const html = renderStaticListView('inbox', 'Inbox');
    expect(html).not.toContain('data-view-filter-input');
  });

  it('uses a compact one-line quick-add hint in the inbox list footer', () => {
    const { getByRole, getByText, queryByPlaceholderText, queryByText } = renderListView('inbox', 'Inbox');

    expect(queryByPlaceholderText(/Add Task/i)).toBeInTheDocument();
    expect(getByText('Try: Call mom /due:tomorrow 5pm @phone #family')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Quick Add syntax help' })).toHaveAttribute(
      'title',
      expect.stringContaining('/start:<when>')
    );
    expect(queryByText(/Quick add supports/)).not.toBeInTheDocument();
  });

  it.each([
    ['next', 'Next'],
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
    ['reference', 'Reference'],
  ] as const)('does not render the inline quick-add composer in the %s view', (statusFilter, title) => {
    const { queryByPlaceholderText, queryByText } = renderListView(statusFilter, title);

    expect(queryByPlaceholderText(/Add Task/i)).not.toBeInTheDocument();
    expect(queryByText('Try: Call mom /due:tomorrow 5pm @phone #family')).not.toBeInTheDocument();
  });

  it.each([
    ['next', 'Next'],
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
    ['reference', 'Reference'],
  ] as const)('does not show a contextual empty-state add action in the %s view', (statusFilter, title) => {
    const { queryByRole } = renderListView(statusFilter, title);

    expect(queryByRole('button', { name: 'Add Task' })).not.toBeInTheDocument();
  });

  it('renders local search input in done view', () => {
    const html = renderStaticListView('done', 'Done');
    expect(html).toContain('data-view-filter-input');
  });

  it.each([
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
  ] as const)('opens the default quick-add pane from the %s view using a', (statusFilter, title) => {
    const quickAddListener = vi.fn();
    window.addEventListener('mindwtr:quick-add', quickAddListener);

    renderListView(statusFilter, title);

    fireEvent.keyDown(window, { key: 'a' });

    expect(quickAddListener).toHaveBeenCalledTimes(1);
    expect((quickAddListener.mock.calls[0]?.[0] as CustomEvent).detail).toBeUndefined();

    window.removeEventListener('mindwtr:quick-add', quickAddListener);
  });

  it('keeps future-start inbox tasks visible while hiding future-start next actions', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-16T10:00:00Z'));

      useTaskStore.setState({
        _allTasks: [
          makeTask('inbox-future', {
            title: 'Future inbox task',
            status: 'inbox',
            startTime: '2026-04-20',
          }),
          makeTask('next-future', {
            title: 'Future next task',
            status: 'next',
            startTime: '2026-04-20',
          }),
        ],
        lastDataChangeAt: 1,
      });

      const inbox = renderListView('inbox', 'Inbox');
      expect(inbox.queryByText('Future inbox task')).toBeInTheDocument();
      inbox.unmount();

      const next = renderListView('next', 'Next');
      expect(next.queryByText('Future next task')).not.toBeInTheDocument();
      next.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show filtering feedback after a background task refresh settles', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();
    expect(queryByText('Filtering...')).not.toBeInTheDocument();

    act(() => {
      useTaskStore.setState({
        _allTasks: [makeTask('1'), makeTask('2')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Filtering...')).not.toBeInTheDocument();
    });
  });

  it('defaults reference tasks to area grouping', () => {
    useTaskStore.setState({
      _allAreas: [{ id: 'area-1', name: 'Work', color: '#2563eb', order: 0, createdAt: now, updatedAt: now }],
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', areaId: 'area-1' }),
        makeTask('2', { title: 'Loose reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getByRole, queryByText } = renderListView('reference', 'Reference');

    expect(getByRole('combobox', { name: 'Group' })).toHaveValue('area');
    expect(queryByText('Work')).toBeInTheDocument();
    expect(queryByText('General')).toBeInTheDocument();
  });

  it('groups reference tasks by each tag when tag grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Dual-tag reference', status: 'reference', tags: ['#alpha', '#beta'] }),
        makeTask('2', { title: 'Untagged reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'tag',
      },
    }));

    const { getAllByText, queryByText } = renderListView('reference', 'Reference');

    expect(queryByText('#alpha')).toBeInTheDocument();
    expect(queryByText('#beta')).toBeInTheDocument();
    expect(queryByText('No tags')).toBeInTheDocument();
    expect(getAllByText('Dual-tag reference')).toHaveLength(2);
  });

  it('groups inbox tasks by each tag when tag grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Dual-tag inbox', status: 'inbox', tags: ['#alpha', '#beta'] }),
        makeTask('2', { title: 'Untagged inbox', status: 'inbox' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        nextGroupBy: 'tag',
      },
    }));

    const { getAllByText, getByRole, queryByText } = renderListView('inbox', 'Inbox');

    expect(getByRole('combobox', { name: 'Group' })).toHaveValue('tag');
    expect(queryByText('#alpha')).toBeInTheDocument();
    expect(queryByText('#beta')).toBeInTheDocument();
    expect(queryByText('No tags')).toBeInTheDocument();
    expect(getAllByText('Dual-tag inbox')).toHaveLength(2);
  });

  it('groups reference tasks by context when context grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', contexts: ['@work'] }),
        makeTask('2', { title: 'Home reference', status: 'reference', contexts: ['@home'] }),
        makeTask('3', { title: 'Loose reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'context',
      },
    }));

    const { getByRole, queryByText } = renderListView('reference', 'Reference');

    expect(getByRole('combobox', { name: 'Group' })).toHaveValue('context');
    expect(queryByText('@home')).toBeInTheDocument();
    expect(queryByText('@work')).toBeInTheDocument();
    expect(queryByText('No context')).toBeInTheDocument();
  });

  it('persists collapsed reference groups by grouping mode', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', contexts: ['@work'] }),
        makeTask('2', { title: 'Home reference', status: 'reference', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'context',
      },
    }));

    const firstRender = renderListView('reference', 'Reference');
    const groupSelect = firstRender.getByRole('combobox', { name: 'Group' }) as HTMLSelectElement;
    const workGroup = firstRender.getByRole('button', { name: /@work\s*1/i });

    fireEvent.click(workGroup);

    expect(firstRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
    expect(firstRender.queryByText('Work reference')).not.toBeInTheDocument();
    expect(firstRender.getByText('Home reference')).toBeInTheDocument();

    const persisted = JSON.parse(window.localStorage.getItem(referenceViewStateStorageKey) ?? '{}') as {
      collapsedGroups?: Record<string, string[]>;
    };
    expect(persisted.collapsedGroups?.context).toEqual(['context:@work']);
    expect(persisted.collapsedGroups?.tag ?? []).toEqual([]);

    fireEvent.change(groupSelect, { target: { value: 'tag' } });
    expect(firstRender.getByRole('button', { name: /No tags\s*2/i })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(groupSelect, { target: { value: 'context' } });
    firstRender.unmount();

    const secondRender = renderListView('reference', 'Reference');
    expect(secondRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
    expect(secondRender.queryByText('Work reference')).not.toBeInTheDocument();
    expect(secondRender.getByText('Home reference')).toBeInTheDocument();
  });

  it('collapses expanded task details when page details are turned off', async () => {
    const expandedTask = makeTask('1', {
      title: 'Expanded task',
      description: 'Expanded task note',
    });
    useTaskStore.setState({
      _allTasks: [expandedTask],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        showDetails: true,
      },
      expandedTaskIds: { '1': true },
    }));

    const { getByRole, queryByText } = renderListView();

    expect(queryByText('Expanded task note')).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: /^details$/i }));

    await waitFor(() => {
      expect(queryByText('Expanded task note')).not.toBeInTheDocument();
      expect(useUiStore.getState().listOptions.showDetails).toBe(false);
      expect(useUiStore.getState().expandedTaskIds).toEqual({});
    });
  });

  it('applies token filters from the UI store', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work task', contexts: ['@work'] }),
        makeTask('2', { title: 'Home task', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    act(() => {
      useUiStore.getState().setListFilters({ criteria: { contexts: ['@work'] } });
    });

    await waitFor(() => {
      expect(queryByText('Work task')).toBeInTheDocument();
      expect(queryByText('Home task')).not.toBeInTheDocument();
    });
  });

  it('selects and clears all visible tasks from the shared list toolbar', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First visible task' }),
        makeTask('2', { title: 'Second visible task' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getAllByRole, getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    fireEvent.click(getByRole('button', { name: 'Select All' }));

    await waitFor(() => {
      expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
        (checkbox as HTMLInputElement).checked
      ))).toEqual([true, true]);
    });

    fireEvent.click(getByRole('button', { name: 'Clear' }));

    expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
      (checkbox as HTMLInputElement).checked
    ))).toEqual([false, false]);
  });

  it('selects a visible range with shift-click in selection mode', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First range task' }),
        makeTask('2', { title: 'Second range task' }),
        makeTask('3', { title: 'Third range task' }),
        makeTask('4', { title: 'Fourth range task' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getAllByRole, getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    const checkboxes = getAllByRole('checkbox', { name: 'Select task' });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[2], { shiftKey: true });

    await waitFor(() => {
      expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
        (checkbox as HTMLInputElement).checked
      ))).toEqual([true, true, true, false]);
    });
  });

  it('does not scroll back to the selected row after a background refresh', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    useTaskStore.setState({
      _allTasks: [makeTask('1'), makeTask('2')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    await waitFor(() => {
      expect(queryByText('Task 2')).toBeInTheDocument();
    });

    scrollIntoViewMock.mockClear();

    act(() => {
      useTaskStore.setState({
        _allTasks: [makeTask('1'), makeTask('2'), makeTask('3')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Task 3')).toBeInTheDocument();
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('shows an error toast when loading archived tasks fails', () => {
    const showToast = vi.fn();

    reportArchivedTaskQueryFailure(new Error('disk read failed'), showToast);

    expect(reportErrorMock).toHaveBeenCalledWith('Failed to load archived tasks', expect.any(Error));
    expect(showToast).toHaveBeenCalledWith('Failed to load archived tasks', 'error');
  });

  it('shows an error toast when a batch undo restore returns a failed result', async () => {
    const showToast = vi.fn();

    await restoreDeletedTasksWithFeedback(
      ['1', '2'],
      vi.fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Task not found' }),
      showToast,
    );

    expect(reportErrorMock).toHaveBeenCalledWith('Failed to restore deleted tasks', expect.any(Error));
    expect(showToast).toHaveBeenCalledWith('Task not found', 'error');
  });

  it('does not show an error toast when batch undo restore succeeds', async () => {
    const showToast = vi.fn();

    await restoreDeletedTasksWithFeedback(
      ['1', '2'],
      vi.fn().mockResolvedValue({ success: true }),
      showToast,
    );

    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('uses the current area filter in the inline inbox composer when default area mode is active', async () => {
    const addTask = vi.fn().mockResolvedValue({ success: true });
    const areas = [
      {
        id: 'area-home',
        name: 'Home',
        color: '#10b981',
        order: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'area-work',
        name: 'Work',
        color: '#3b82f6',
        order: 1,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ];

    useTaskStore.setState({
      addTask,
      areas,
      _allAreas: areas,
      settings: {
        quickAddAutoClean: true,
        filters: { areaId: 'area-work' },
        gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' },
      },
    });

    const { container, getByRole } = renderListView('inbox', 'Inbox');
    const input = getByRole('combobox', { name: '' });

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Area filtered task' } });
    });

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });

    expect(addTask).toHaveBeenCalledWith('Area filtered task', expect.objectContaining({
      areaId: 'area-work',
      status: 'inbox',
    }));
  });

  it('applies trailing date NLP in the desktop inline inbox quick add', async () => {
    const addTask = vi.fn().mockResolvedValue({ success: true });
    const now = new Date('2026-04-16T10:00:00Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);

      useTaskStore.setState({
        addTask,
        settings: { quickAddAutoClean: true },
      });

      const { container, getByRole } = renderListView('inbox', 'Inbox');

      const input = getByRole('combobox', { name: '' });
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Tax deadline — April 15' } });
      });

      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      await act(async () => {
        fireEvent.submit(form!);
      });

      expect(addTask).toHaveBeenCalledWith('Tax deadline', expect.objectContaining({
        dueDate: '2027-04-15',
        status: 'inbox',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the focus star in desktop inline quick add', () => {
    const { queryByRole } = renderListView('next', 'Next');

    expect(queryByRole('button', { name: /add to today's focus/i })).toBeNull();
  });
});
