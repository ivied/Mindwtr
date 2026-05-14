import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectSelector } from './ProjectSelector';

const projects: Project[] = [
    { id: 'p1', title: 'Alpha', status: 'active', color: '#3b82f6', order: 0, tagIds: [], createdAt: '', updatedAt: '' },
    { id: 'p2', title: 'Work Project', status: 'active', color: '#10b981', order: 1, tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
];

/**
 * Simulate typing into a controlled React input under bun + JSDOM.
 * React 19 intercepts the value property descriptor to track changes;
 * we must call the *native* setter so React sees a new value, then
 * dispatch an `input` event inside `act()` so the state update flushes.
 */
function setInputValue(input: HTMLInputElement, value: string) {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(input));
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
        if (nativeSetter) {
            nativeSetter.call(input, value);
        } else {
            (input as any).value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('ProjectSelector', () => {
    it('hides archived and legacy completed projects from the selectable options', () => {
        const inactiveProjects: Project[] = [
            ...projects,
            { id: 'p3', title: 'Archived Project', status: 'archived', color: '#64748b', order: 2, tagIds: [], createdAt: '', updatedAt: '' },
            { id: 'p4', title: 'Completed Project', status: 'completed' as Project['status'], color: '#64748b', order: 3, tagIds: [], createdAt: '', updatedAt: '' },
        ];

        const { getByRole, queryByRole } = render(
            <ProjectSelector
                projects={inactiveProjects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        expect(getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
        expect(queryByRole('option', { name: 'Archived Project' })).not.toBeInTheDocument();
        expect(queryByRole('option', { name: 'Completed Project' })).not.toBeInTheDocument();
    });

    it('suppresses create when an exact match exists outside the filtered list', () => {
        const { getByRole, getByLabelText, queryByText } = render(
            <ProjectSelector
                projects={[projects[0]]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                onCreateProject={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                createProjectLabel="Create project"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));
        setInputValue(getByLabelText('Search projects') as HTMLInputElement, 'Work Project');

        expect(queryByText(/Create project/i)).not.toBeInTheDocument();
    });

    it('prefers the empty label and falls back to the no-matches label', () => {
        const first = render(
            <ProjectSelector
                projects={[]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                noMatchesLabel="No matches"
                emptyLabel="No projects in this area."
            />
        );

        fireEvent.click(first.getByRole('button', { name: 'Select project' }));
        first.getByText('No projects in this area.');
        first.unmount();

        const second = render(
            <ProjectSelector
                projects={[]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                noMatchesLabel="No matches"
            />
        );

        fireEvent.click(second.getByRole('button', { name: 'Select project' }));
        second.getByText('No matches');
    });
});
