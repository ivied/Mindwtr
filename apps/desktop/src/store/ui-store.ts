import { createWithEqualityFn } from 'zustand/traditional';
import type { TaskPriority, TimeEstimate } from '@mindwtr/core';

const toastTimeouts = new Map<string, number>();
type ListNextGroupBy = 'none' | 'context' | 'area' | 'project';
type ListOptions = {
    showDetails: boolean;
    nextGroupBy: ListNextGroupBy;
    focusTop3Only: boolean;
};

export const LIST_OPTIONS_STORAGE_KEY = 'mindwtr:list-options:v1';

const DEFAULT_LIST_OPTIONS: ListOptions = {
    showDetails: false,
    nextGroupBy: 'none',
    focusTop3Only: false,
};

function isListNextGroupBy(value: unknown): value is ListNextGroupBy {
    return value === 'none' || value === 'context' || value === 'area' || value === 'project';
}

function getListOptionsStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function readStoredListOptions(): ListOptions {
    const storage = getListOptionsStorage();
    if (!storage) return DEFAULT_LIST_OPTIONS;
    try {
        const raw = storage.getItem(LIST_OPTIONS_STORAGE_KEY);
        if (!raw) return DEFAULT_LIST_OPTIONS;
        const parsed = JSON.parse(raw) as Partial<ListOptions> | null;
        return {
            showDetails: typeof parsed?.showDetails === 'boolean' ? parsed.showDetails : DEFAULT_LIST_OPTIONS.showDetails,
            nextGroupBy: isListNextGroupBy(parsed?.nextGroupBy) ? parsed.nextGroupBy : DEFAULT_LIST_OPTIONS.nextGroupBy,
            focusTop3Only: typeof parsed?.focusTop3Only === 'boolean' ? parsed.focusTop3Only : DEFAULT_LIST_OPTIONS.focusTop3Only,
        };
    } catch {
        return DEFAULT_LIST_OPTIONS;
    }
}

function saveStoredListOptions(options: ListOptions) {
    const storage = getListOptionsStorage();
    if (!storage) return;
    try {
        storage.setItem(LIST_OPTIONS_STORAGE_KEY, JSON.stringify(options));
    } catch {
        // View options are convenience state; storage failures should not block UI updates.
    }
}

interface UiState {
    isFocusMode: boolean;
    setFocusMode: (value: boolean) => void;
    toggleFocusMode: () => void;
    toasts: Array<{
        id: string;
        message: string;
        tone: 'success' | 'error' | 'info';
        action?: { label: string; onClick: () => void };
    }>;
    showToast: (
        message: string,
        tone?: 'success' | 'error' | 'info',
        durationMs?: number,
        action?: { label: string; onClick: () => void }
    ) => void;
    dismissToast: (id: string) => void;
    listFilters: {
        tokens: string[];
        priorities: TaskPriority[];
        estimates: TimeEstimate[];
        open: boolean;
    };
    setListFilters: (partial: Partial<UiState['listFilters']>) => void;
    resetListFilters: () => void;
    listOptions: ListOptions;
    setListOptions: (partial: Partial<UiState['listOptions']>) => void;
    editingTaskId: string | null;
    setEditingTaskId: (value: string | null) => void;
    expandedTaskIds: Record<string, true>;
    collapseAllTaskDetails: () => void;
    setTaskExpanded: (taskId: string, expanded: boolean) => void;
    toggleTaskExpanded: (taskId: string) => void;
    boardFilters: {
        selectedProjectIds: string[];
    };
    setBoardFilters: (partial: Partial<UiState['boardFilters']>) => void;
    projectView: {
        selectedProjectId: string | null;
    };
    setProjectView: (partial: Partial<UiState['projectView']>) => void;
}

export const useUiStore = createWithEqualityFn<UiState>()((set) => ({
    isFocusMode: false,
    setFocusMode: (value) => set({ isFocusMode: value }),
    toggleFocusMode: () => set((state) => ({ isFocusMode: !state.isFocusMode })),
    toasts: [],
    showToast: (message, tone = 'info', durationMs = 3000, action) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((state) => ({ toasts: [...state.toasts, { id, message, tone, action }] }));
        const timeoutId = window.setTimeout(() => {
            toastTimeouts.delete(id);
            set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
        }, durationMs);
        toastTimeouts.set(id, timeoutId);
    },
    dismissToast: (id) => {
        const timeoutId = toastTimeouts.get(id);
        if (timeoutId) {
            window.clearTimeout(timeoutId);
            toastTimeouts.delete(id);
        }
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },
    listFilters: {
        tokens: [],
        priorities: [],
        estimates: [],
        open: false,
    },
    setListFilters: (partial) =>
        set((state) => ({ listFilters: { ...state.listFilters, ...partial } })),
    resetListFilters: () =>
        set((state) => ({
            listFilters: {
                ...state.listFilters,
                tokens: [],
                priorities: [],
                estimates: [],
            },
        })),
    listOptions: readStoredListOptions(),
    setListOptions: (partial) =>
        set((state) => {
            const listOptions = { ...state.listOptions, ...partial };
            saveStoredListOptions(listOptions);
            return { listOptions };
        }),
    editingTaskId: null,
    setEditingTaskId: (value) => set({ editingTaskId: value }),
    expandedTaskIds: {},
    collapseAllTaskDetails: () =>
        set((state) => (Object.keys(state.expandedTaskIds).length === 0 ? state : { expandedTaskIds: {} })),
    setTaskExpanded: (taskId, expanded) =>
        set((state) => {
            const currentExpanded = Boolean(state.expandedTaskIds[taskId]);
            if (currentExpanded === expanded) return state;
            if (expanded) {
                return {
                    expandedTaskIds: {
                        ...state.expandedTaskIds,
                        [taskId]: true,
                    },
                };
            }
            const nextExpanded = { ...state.expandedTaskIds };
            delete nextExpanded[taskId];
            return { expandedTaskIds: nextExpanded };
        }),
    toggleTaskExpanded: (taskId) =>
        set((state) => {
            const isExpanded = Boolean(state.expandedTaskIds[taskId]);
            if (isExpanded) {
                const nextExpanded = { ...state.expandedTaskIds };
                delete nextExpanded[taskId];
                return { expandedTaskIds: nextExpanded };
            }
            return {
                expandedTaskIds: {
                    ...state.expandedTaskIds,
                    [taskId]: true,
                },
            };
        }),
    boardFilters: {
        selectedProjectIds: [],
    },
    setBoardFilters: (partial) =>
        set((state) => ({ boardFilters: { ...state.boardFilters, ...partial } })),
    projectView: {
        selectedProjectId: null,
    },
    setProjectView: (partial) =>
        set((state) => ({ projectView: { ...state.projectView, ...partial } })),
}));
