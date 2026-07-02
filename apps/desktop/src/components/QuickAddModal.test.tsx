import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';
import type { ComponentProps } from 'react';

import { LanguageProvider } from '../contexts/language-context';
import { QuickAddModal } from './QuickAddModal';
import { QUICK_ADD_MAIN_WINDOW_LABEL, QUICK_ADD_SAVED_EVENT } from '../lib/quick-add-saved-event';
import { useUiStore } from '../store/ui-store';

const tauriMocks = vi.hoisted(() => ({
    emitTo: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    invoke: vi.fn(async () => false),
    listen: vi.fn(async () => () => undefined),
}));
const fsMocks = vi.hoisted(() => ({
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(async () => '/data'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    emitTo: tauriMocks.emitTo,
    listen: tauriMocks.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        hide: tauriMocks.hide,
    }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    mkdir: fsMocks.mkdir,
    readFile: fsMocks.readFile,
    remove: fsMocks.remove,
    writeFile: fsMocks.writeFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
    dataDir: pathMocks.dataDir,
    join: pathMocks.join,
}));

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

const createImageClipboardData = (file: File) => ({
    files: [file],
    items: [{
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
    }],
});

beforeEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.clearAllMocks();
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState((state) => ({
            ...state,
            _allProjects: [],
            _allAreas: [],
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
        useUiStore.setState({
            editingTaskId: null,
            projectView: { selectedProjectId: null },
        });
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
        expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('bg-transparent');
        expect(screen.getByRole('button', { name: 'Close' })).not.toHaveClass('bg-background');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Add Task')).toHaveValue('Fast capture');

        await act(async () => {
            deferred.resolve();
            await deferred.promise;
        });
    });

    it('notifies the main window after a standalone text quick add is saved', async () => {
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        const fetchData = vi.fn(async () => undefined) as unknown as typeof initialTaskState.fetchData;
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
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

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(tauriMocks.emitTo).toHaveBeenCalledWith(
                QUICK_ADD_MAIN_WINDOW_LABEL,
                QUICK_ADD_SAVED_EVENT,
                expect.objectContaining({ savedAt: expect.any(String) }),
            );
        });
        expect(addTask).toHaveBeenCalledWith('Fast capture', expect.objectContaining({ status: 'inbox' }));
    });

    it('uses the current area filter when default area mode is active', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
                _allAreas: [
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
                ],
                settings: {
                    ...state.settings,
                    filters: { ...(state.settings?.filters ?? {}), areaId: 'area-work' },
                    gtd: {
                        ...(state.settings?.gtd ?? {}),
                        defaultAreaMode: 'active',
                        defaultAreaId: 'area-home',
                    },
                },
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Area filtered capture' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Area filtered capture', expect.objectContaining({
                areaId: 'area-work',
                status: 'inbox',
            }));
        });
    });

    it('asks native code to hide standalone quick add without promoting the main window', async () => {
        (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

        renderQuickAddModal({ standaloneWindow: true });

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Close quietly' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => {
            expect(tauriMocks.invoke).toHaveBeenCalledWith('hide_quick_add_window');
        });
        expect(tauriMocks.hide).not.toHaveBeenCalled();
    });

    it("stars a task for Today's Focus from the add task modal", async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'File Q3 estimated tax payment' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: "Add to today's focus" }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('File Q3 estimated tax payment', expect.objectContaining({
                status: 'inbox',
                isFocusedToday: true,
            }));
        });
    });

    it('creates a new quick-add project in the parsed area', async () => {
        const addProject = vi.fn(async () => ({
            id: 'project-launch',
            title: 'Launch',
            color: '#3b82f6',
            order: 0,
            status: 'active' as const,
            tagIds: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
        }));
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addProject,
                addTask,
                settings: {
                    ...state.settings,
                    quickAddAutoClean: true,
                },
                _allAreas: [{
                    id: 'area-work',
                    name: 'Work',
                    color: '#3b82f6',
                    order: 0,
                    createdAt: '2026-04-01T00:00:00.000Z',
                    updatedAt: '2026-04-01T00:00:00.000Z',
                }],
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Plan campaign +Launch !Work' },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(addProject).toHaveBeenCalledWith('Launch', expect.any(String), { areaId: 'area-work' });
        });
        expect(addTask).toHaveBeenCalledWith('Plan campaign', expect.objectContaining({
            projectId: 'project-launch',
            areaId: undefined,
        }));
    });

    it('opens the created project task when save and edit is requested', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-created' }));
        const navigateListener = vi.fn();
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });
        window.addEventListener('mindwtr:navigate', navigateListener);

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: {
                    initialValue: 'Draft launch brief',
                    initialProps: { projectId: 'project-launch', status: 'next' },
                },
            }));
            await Promise.resolve();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save & edit' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Draft launch brief', expect.objectContaining({
                projectId: 'project-launch',
                status: 'next',
            }));
        });
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-launch');
        expect(useUiStore.getState().editingTaskId).toBe('task-created');
        expect(useTaskStore.getState().highlightTaskId).toBe('task-created');
        expect(navigateListener).toHaveBeenCalledWith(expect.objectContaining({
            detail: { view: 'projects' },
        }));
        window.removeEventListener('mindwtr:navigate', navigateListener);
    });

    it('attaches a pasted image to a text quick-add task', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                detail: { initialValue: 'Capture receipt' },
            }));
            await Promise.resolve();
        });

        const file = new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' });
        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: createImageClipboardData(file),
        });

        await waitFor(() => {
            expect(fsMocks.writeFile).toHaveBeenCalled();
            expect(screen.getByText('1 image attached')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(addTask).toHaveBeenCalled());
        expect(fsMocks.mkdir).toHaveBeenCalledWith('mindwtr/quick-add-images', {
            baseDir: 'Data',
            recursive: true,
        });
        expect(fsMocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/^mindwtr\/quick-add-images\/mindwtr-paste-/),
            expect.any(Uint8Array),
            expect.objectContaining({ baseDir: 'Data' }),
        );
        expect(addTask).toHaveBeenCalledWith('Capture receipt', expect.objectContaining({
            attachments: [
                expect.objectContaining({
                    kind: 'file',
                    title: expect.stringContaining('Screenshot'),
                    uri: expect.stringContaining('/data/mindwtr/quick-add-images/mindwtr-paste-'),
                    mimeType: 'image/png',
                    size: 3,
                }),
            ],
        }));
    });

    it('creates a screenshot-titled task for an image-only quick add paste', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        const file = new File([new Uint8Array([4, 5])], 'screenshot.png', { type: 'image/png' });
        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: createImageClipboardData(file),
        });

        await waitFor(() => {
            expect(screen.getByText('1 image attached')).toBeInTheDocument();
        });

        const saveButton = screen.getByRole('button', { name: 'Save' });
        await waitFor(() => expect(saveButton).not.toBeDisabled());
        fireEvent.click(saveButton);

        await waitFor(() => expect(addTask).toHaveBeenCalled());
        const [title, props] = addTask.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(title).toContain('Screenshot');
        expect(props).toEqual(expect.objectContaining({
            status: 'inbox',
            attachments: [
                expect.objectContaining({
                    kind: 'file',
                    title: expect.stringContaining('Screenshot'),
                    mimeType: 'image/png',
                    size: 2,
                }),
            ],
        }));
    });

    it('confirms and creates one task per nonblank pasted text line', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        fireEvent.paste(screen.getByPlaceholderText('Add Task'), {
            clipboardData: {
                files: [],
                items: [],
                getData: (type: string) => type === 'text/plain'
                    ? 'Email Bob\n\nCall Alice\nReview notes'
                    : '',
            },
        });

        expect(await screen.findByText('Create 3 tasks?')).toBeInTheDocument();
        expect(screen.getByText('Email Bob')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));

        await waitFor(() => expect(addTask).toHaveBeenCalledTimes(3));
        expect(addTask).toHaveBeenNthCalledWith(1, 'Email Bob', expect.objectContaining({ status: 'inbox' }));
        expect(addTask).toHaveBeenNthCalledWith(2, 'Call Alice', expect.objectContaining({ status: 'inbox' }));
        expect(addTask).toHaveBeenNthCalledWith(3, 'Review notes', expect.objectContaining({ status: 'inbox' }));
    });

    it('imports a text file through the same bulk quick-add confirmation', async () => {
        const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                addTask,
            }));
        });

        renderQuickAddModal();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add'));
            await Promise.resolve();
        });

        const file = new File(['First imported task\nSecond imported task\n'], 'tasks.txt', { type: 'text/plain' });
        fireEvent.change(screen.getByLabelText('Import text file'), {
            target: { files: [file] },
        });

        expect(await screen.findByText('Create 2 tasks?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Create tasks' }));

        await waitFor(() => expect(addTask).toHaveBeenCalledTimes(2));
        expect(addTask).toHaveBeenNthCalledWith(1, 'First imported task', expect.objectContaining({ status: 'inbox' }));
        expect(addTask).toHaveBeenNthCalledWith(2, 'Second imported task', expect.objectContaining({ status: 'inbox' }));
    });
});
