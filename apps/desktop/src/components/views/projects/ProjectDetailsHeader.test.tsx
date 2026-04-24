import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectDetailsHeader } from './ProjectDetailsHeader';

const translations: Record<string, string> = {
    'common.delete': 'Delete',
    'projects.archive': 'Archive',
    'projects.details': 'Details',
    'projects.duplicate': 'Duplicate',
    'projects.noActiveTasks': 'No active tasks',
    'projects.parallel': 'Parallel',
    'projects.reviewAt': 'Review Date',
    'projects.reactivate': 'Reactivate',
    'projects.sequential': 'Sequential',
    'projects.title': 'Project title',
    'process.remaining': 'remaining',
    'status.active': 'Active',
    'status.done': 'Done',
    'status.waiting': 'Waiting',
    'taskEdit.details': 'Details',
    'taskEdit.dueDateLabel': 'Due Date',
};

const t = (key: string) => translations[key] ?? key;

function buildProject(overrides: Partial<Project> = {}): Project {
    return {
        id: 'project-1',
        title: 'Launch site',
        status: 'active',
        color: '#3b82f6',
        order: 0,
        tagIds: [],
        createdAt: '2026-03-30T09:00:00',
        updatedAt: '2026-03-30T09:00:00',
        ...overrides,
    };
}

describe('ProjectDetailsHeader', () => {
    it('shows compact project summary metadata and toggles details', () => {
        const onToggleDetails = vi.fn();
        const project = buildProject({
            status: 'waiting',
            tagIds: ['#client'],
            dueDate: '2026-03-28',
            reviewAt: '2026-03-30T09:00:00',
        });

        render(
            <ProjectDetailsHeader
                project={project}
                projectColor="#2563eb"
                areaLabel="Ops"
                isSequential
                dueDate={project.dueDate}
                reviewAt={project.reviewAt}
                editTitle={project.title}
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded={false}
                onToggleDetails={onToggleDetails}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={vi.fn()}
                onDelete={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByRole('button', { name: /details/i })).toHaveAttribute('aria-expanded', 'false');
        screen.getByDisplayValue('Launch site');
        screen.getByText('Waiting');
        screen.getByText('Ops');
        screen.getByText('Sequential');
        screen.getByText('Due Date: Mar 28');
        screen.getByText('Review Date: Mar 30');
        screen.getByText('#client');

        fireEvent.click(screen.getByRole('button', { name: /details/i }));
        expect(onToggleDetails).toHaveBeenCalledTimes(1);
    });

    it('renders the parallel summary and expanded state without optional chips', () => {
        const project = buildProject();

        render(
            <ProjectDetailsHeader
                project={project}
                projectColor="#2563eb"
                isSequential={false}
                dueDate={project.dueDate}
                editTitle={project.title}
                onEditTitleChange={vi.fn()}
                onCommitTitle={vi.fn()}
                onResetTitle={vi.fn()}
                detailsExpanded
                onToggleDetails={vi.fn()}
                onDuplicate={vi.fn()}
                onArchive={vi.fn()}
                onReactivate={vi.fn()}
                onDelete={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByRole('button', { name: /details/i })).toHaveAttribute('aria-expanded', 'true');
        screen.getByText('Active');
        screen.getByText('Parallel');
        expect(screen.queryByText('Ops')).not.toBeInTheDocument();
        expect(screen.queryByText(/Due Date:/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Review Date:/i)).not.toBeInTheDocument();
    });
});
