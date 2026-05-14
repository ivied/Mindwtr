import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { TaskEditAreaPicker } from './TaskEditAreaPicker';
import { TaskEditProjectPicker } from './TaskEditProjectPicker';
import { TaskEditSectionPicker } from './TaskEditSectionPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tc = {
    cardBg: '#111',
    border: '#333',
    text: '#fff',
    inputBg: '#111',
    secondaryText: '#aaa',
    tint: '#3b82f6',
};

describe('Task edit pickers', () => {
    it('adds modal accessibility metadata to the area picker', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditAreaPicker
                    visible
                    areas={[]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectArea={vi.fn()}
                    onCreateArea={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const modal = tree!.root.find(
            (node) => node.props.accessibilityViewIsModal === true
        );
        const title = tree!.root.find(
            (node) => node.props.accessibilityRole === 'header' && node.props.children === 'taskEdit.areaLabel'
        );
        const input = tree!.root.find(
            (node) => node.props.accessibilityLabel === 'taskEdit.areaLabel' && node.props.accessibilityHint === 'common.search'
        );

        expect(modal.props.accessibilityViewIsModal).toBe(true);
        expect(title).toBeTruthy();
        expect(input).toBeTruthy();
    });

    it('announces section search misses', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditSectionPicker
                    visible
                    sections={[
                        {
                            id: 'section-1',
                            projectId: 'project-1',
                            title: 'Backlog',
                            order: 0,
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ]}
                    projectId="project-1"
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectSection={vi.fn()}
                    onCreateSection={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        const input = tree!.root.find(
            (node) => node.props.accessibilityLabel === 'taskEdit.sectionLabel'
        );

        act(() => {
            input.props.onChangeText('zzz');
        });

        const emptyMessage = tree!.root.find(
            (node) => node.props.accessibilityLiveRegion === 'polite' && node.props.children === 'common.noMatches'
        );

        expect(emptyMessage).toBeTruthy();
    });

    it('hides archived and legacy completed projects from task assignment choices', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditProjectPicker
                    visible
                    projects={[
                        {
                            id: 'project-active',
                            title: 'Active Project',
                            status: 'active',
                            color: '#3b82f6',
                            order: 0,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            id: 'project-archived',
                            title: 'Archived Project',
                            status: 'archived',
                            color: '#64748b',
                            order: 1,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                        {
                            id: 'project-completed',
                            title: 'Completed Project',
                            status: 'completed' as any,
                            color: '#64748b',
                            order: 2,
                            tagIds: [],
                            createdAt: '2025-01-01T00:00:00.000Z',
                            updatedAt: '2025-01-01T00:00:00.000Z',
                        },
                    ]}
                    tc={tc as any}
                    t={(key) => key}
                    onClose={vi.fn()}
                    onSelectProject={vi.fn()}
                    onCreateProject={vi.fn().mockResolvedValue(null)}
                />
            );
        });

        expect(tree!.root.findByProps({ accessibilityLabel: 'Active Project' })).toBeTruthy();
        expect(tree!.root.findAll((node) => node.props.accessibilityLabel === 'Archived Project')).toHaveLength(0);
        expect(tree!.root.findAll((node) => node.props.accessibilityLabel === 'Completed Project')).toHaveLength(0);
    });
});
