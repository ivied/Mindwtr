import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { BoardView } from './BoardView';
import { LanguageProvider } from '../../contexts/language-context';
import { useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../../store/ui-store';

vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PointerSensor: class {},
    useDroppable: () => ({ setNodeRef: () => {} }),
    useDraggable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        transform: null,
        isDragging: false,
    }),
    useSensor: () => ({}),
    useSensors: () => ([]),
    closestCorners: () => null,
}));

const renderWithProviders = () => {
    return render(
        <LanguageProvider>
            <BoardView />
        </LanguageProvider>
    );
};

describe('BoardView', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState({
            tasks: [],
            projects: [],
            areas: [],
            settings: {},
        });
        useUiStore.setState({
            boardFilters: { selectedProjectIds: [] },
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
        useTaskStore.setState({
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
});
