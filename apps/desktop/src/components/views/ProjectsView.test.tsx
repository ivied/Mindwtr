import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectsView } from './ProjectsView';

const setProjectView = vi.fn();
const showToast = vi.fn();
const requestConfirmation = vi.fn();
let resizeObserverCallback: ResizeObserverCallback | null = null;
let animationFrameId = 0;
const queuedAnimationFrames = new Map<number, FrameRequestCallback>();

const flushAnimationFrames = () => {
    const callbacks = Array.from(queuedAnimationFrames.values());
    queuedAnimationFrames.clear();
    callbacks.forEach((callback) => callback(Date.now()));
};

vi.mock('../ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../PromptModal', () => ({
    PromptModal: () => null,
}));

vi.mock('./projects/AreaManagerModal', () => ({
    AreaManagerModal: () => null,
}));

vi.mock('./projects/ProjectsSidebar', () => ({
    ProjectsSidebar: () => <div data-testid="projects-sidebar">Projects sidebar</div>,
}));

vi.mock('./projects/ProjectWorkspace', () => ({
    ProjectWorkspace: () => <div data-testid="project-workspace">Workspace</div>,
}));

vi.mock('../../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'projects.resizeSidebar': 'Resize projects panel',
        }[key] ?? key),
        language: 'en',
    }),
}));

vi.mock('../../hooks/useConfirmDialog', () => ({
    useConfirmDialog: () => ({
        requestConfirmation,
        confirmModal: null,
    }),
}));

vi.mock('../../hooks/usePerformanceMonitor', () => ({
    usePerformanceMonitor: () => ({
        enabled: false,
        metrics: {},
    }),
}));

vi.mock('../../config/performanceBudgets', () => ({
    checkBudget: vi.fn(),
}));

vi.mock('../../store/ui-store', () => ({
    useUiStore: (selector: (state: unknown) => unknown) => selector({
        projectView: { selectedProjectId: null },
        setProjectView,
        showToast,
    }),
}));

vi.mock('./projects/useAreaSidebarState', () => ({
    useAreaSidebarState: () => ({
        selectedArea: '__all__',
        sortedAreas: [],
        areaById: new Map(),
        areaFilterLabel: null,
        areaSensors: [],
        toggleAreaCollapse: vi.fn(),
        handleAreaDragEnd: vi.fn(),
        handleDeleteArea: vi.fn(),
    }),
}));

vi.mock('./projects/useProjectsViewStore', () => ({
    useProjectsViewStore: () => ({
        projects: [],
        tasks: [],
        sections: [],
        areas: [],
        addArea: vi.fn(),
        updateArea: vi.fn(),
        deleteArea: vi.fn(),
        reorderAreas: vi.fn(),
        reorderProjects: vi.fn(),
        reorderProjectTasks: vi.fn(),
        addProject: vi.fn(),
        updateProject: vi.fn(),
        deleteProject: vi.fn(),
        duplicateProject: vi.fn(),
        updateTask: vi.fn(),
        addSection: vi.fn(),
        updateSection: vi.fn(),
        deleteSection: vi.fn(),
        addTask: vi.fn(),
        toggleProjectFocus: vi.fn(),
        allTasks: [],
        highlightTaskId: null,
        setHighlightTask: vi.fn(),
        settings: {},
        getDerivedState: () => ({
            allContexts: [],
            allTags: [],
        }),
    }),
}));

describe('ProjectsView', () => {
    beforeEach(() => {
        setProjectView.mockReset();
        showToast.mockReset();
        requestConfirmation.mockReset();
        resizeObserverCallback = null;
        animationFrameId = 0;
        queuedAnimationFrames.clear();
        window.localStorage.clear();
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            writable: true,
            value: vi.fn((callback: FrameRequestCallback) => {
                animationFrameId += 1;
                queuedAnimationFrames.set(animationFrameId, callback);
                return animationFrameId;
            }),
        });
        Object.defineProperty(window, 'cancelAnimationFrame', {
            configurable: true,
            writable: true,
            value: vi.fn((id: number) => {
                queuedAnimationFrames.delete(id);
            }),
        });
        class ResizeObserverMock {
            observe = vi.fn();
            disconnect = vi.fn();

            constructor(callback: ResizeObserverCallback) {
                resizeObserverCallback = callback;
            }
        }
        Object.defineProperty(window, 'ResizeObserver', {
            configurable: true,
            writable: true,
            value: ResizeObserverMock,
        });
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            writable: true,
            value: ResizeObserverMock,
        });
    });

    it('allows keyboard resizing of the projects sidebar and persists the width', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 1500,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 1800,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const separator = screen.getByRole('separator', { name: 'Resize projects panel' });
        const sidebar = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        const layout = sidebar?.parentElement;

        expect(sidebar).not.toBeNull();
        expect(layout).not.toBeNull();
        expect(sidebar).toHaveStyle({ width: '304px' });
        expect(layout).toHaveStyle({ maxWidth: '1344px' });

        fireEvent.keyDown(separator, { key: 'ArrowRight' });

        await waitFor(() => {
            expect(sidebar).toHaveStyle({ width: '328px' });
        });
        await waitFor(() => {
            expect(layout).toHaveStyle({ maxWidth: '1368px' });
        });
        await waitFor(() => {
            expect(window.localStorage.getItem('mindwtr:projects:sidebarWidth')).toBe('328');
        });

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });

    it('allows ultra-wide desktops to expand the projects sidebar beyond the compact cap', async () => {
        const originalInnerWidth = window.innerWidth;
        const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 4480,
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get: () => 4480,
        });

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });

        const separator = screen.getByRole('separator', { name: 'Resize projects panel' });
        const sidebar = screen.getByTestId('projects-sidebar').parentElement?.parentElement;
        const layout = sidebar?.parentElement;

        expect(sidebar).not.toBeNull();
        expect(layout).not.toBeNull();
        expect(separator).toHaveAttribute('aria-valuemax', '1920');
        expect(layout).not.toHaveClass('mx-auto');

        fireEvent.keyDown(separator, { key: 'End' });

        await waitFor(() => {
            expect(sidebar).toHaveStyle({ width: '1920px' });
        });
        await waitFor(() => {
            expect(layout).toHaveStyle({ maxWidth: '3024px' });
        });

        if (originalClientWidthDescriptor) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
        } else {
            delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        }
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        });
    });

    it('coalesces ResizeObserver sidebar sync work into a single animation frame', () => {
        const requestAnimationFrameMock = window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;

        render(<ProjectsView />);
        act(() => {
            flushAnimationFrames();
        });
        requestAnimationFrameMock.mockClear();

        expect(resizeObserverCallback).not.toBeNull();

        act(() => {
            resizeObserverCallback?.([], {} as ResizeObserver);
            resizeObserverCallback?.([], {} as ResizeObserver);
        });

        expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);
    });
});
