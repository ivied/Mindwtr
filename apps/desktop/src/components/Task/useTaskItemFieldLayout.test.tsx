import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Task } from '@mindwtr/core';

import { DEFAULT_TASK_EDITOR_ORDER } from './task-item-helpers';
import { useTaskItemFieldLayout } from './useTaskItemFieldLayout';

const baseTask: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
};

const buildParams = (overrides: Partial<Parameters<typeof useTaskItemFieldLayout>[0]> = {}): Parameters<typeof useTaskItemFieldLayout>[0] => ({
    settings: {},
    task: {
        ...baseTask,
        dueDate: '2026-03-20',
        checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: false }],
    },
    editStatus: 'next',
    editProjectId: '',
    editSectionId: '',
    editAreaId: '',
    editPriority: 'high',
    editContexts: '@home',
    editDescription: 'Reference notes',
    editDueDate: '2026-03-20',
    editRecurrence: 'daily',
    editReviewAt: '2026-03-21T09:00',
    editStartTime: '2026-03-19T09:00',
    editTags: '#notes',
    editLocation: 'Office',
    editTimeEstimate: '30min',
    prioritiesEnabled: true,
    timeEstimatesEnabled: true,
    visibleEditAttachmentsLength: 1,
    ...overrides,
});

describe('useTaskItemFieldLayout', () => {
    it('keeps the default editor shallow while leaving optional metadata hidden until used', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            editPriority: '',
            editEnergyLevel: '',
            editAssignedTo: '',
            editLocation: '',
            editTimeEstimate: '',
        })));

        expect(result.current.basicFields).toEqual(expect.arrayContaining(['status', 'contexts', 'dueDate']));
        expect(result.current.organizationFields).not.toContain('priority');
        expect(result.current.organizationFields).not.toContain('energyLevel');
        expect(result.current.organizationFields).not.toContain('assignedTo');
        expect(result.current.organizationFields).not.toContain('timeEstimate');
        expect(result.current.detailsFields).not.toContain('location');
        expect(result.current.sectionOpenDefaults.details).toBe(false);
    });

    it('hides status when the task editor layout disables it even for non-inbox tasks', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: ['status'],
                    },
                },
            },
            editStatus: 'next',
        })));

        expect(result.current.basicFields).not.toContain('status');
    });

    it('hides every configured field when hidden fields have no task content', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: [...DEFAULT_TASK_EDITOR_ORDER],
                    },
                },
            },
            task: baseTask,
            editStatus: 'next',
            editProjectId: '',
            editSectionId: '',
            editAreaId: '',
            editPriority: '',
            editEnergyLevel: '',
            editAssignedTo: '',
            editContexts: '',
            editDescription: '',
            editDueDate: '',
            editRecurrence: '',
            editReviewAt: '',
            editStartTime: '',
            editTags: '',
            editLocation: '',
            editTimeEstimate: '',
            visibleEditAttachmentsLength: 0,
        })));

        expect(result.current.showProjectField).toBe(false);
        expect(result.current.showAreaField).toBe(false);
        expect(result.current.showSectionField).toBe(false);
        expect(result.current.basicFields).toEqual([]);
        expect(result.current.schedulingFields).toEqual([]);
        expect(result.current.organizationFields).toEqual([]);
        expect(result.current.detailsFields).toEqual([]);
    });

    it('hides action-only fields while a task is being edited as reference', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            editStatus: 'reference',
        })));

        expect(result.current.basicFields).toContain('status');
        expect(result.current.basicFields).not.toContain('dueDate');
        expect(result.current.schedulingFields).toEqual([]);
        expect(result.current.basicFields).toContain('contexts');
        expect(result.current.organizationFields).toContain('tags');
        expect(result.current.organizationFields).not.toContain('priority');
        expect(result.current.organizationFields).not.toContain('timeEstimate');
        expect(result.current.detailsFields).toContain('description');
        expect(result.current.detailsFields).toContain('attachments');
        expect(result.current.detailsFields).not.toContain('checklist');
    });

    it('uses the draft status rather than the persisted task status for field visibility', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            task: {
                ...baseTask,
                status: 'reference',
                checklist: [{ id: 'item-1', title: 'Checklist item', isCompleted: false }],
            },
            editStatus: 'next',
        })));

        expect(result.current.basicFields).toContain('dueDate');
        expect(result.current.schedulingFields).toHaveLength(3);
        expect(result.current.schedulingFields).toEqual(expect.arrayContaining(['startTime', 'recurrence', 'reviewAt']));
        expect(result.current.basicFields).toContain('contexts');
        expect(result.current.organizationFields).toContain('priority');
        expect(result.current.organizationFields).toContain('timeEstimate');
        expect(result.current.detailsFields).toContain('checklist');
    });

    it('moves due date into scheduling when configured and preserves section open defaults', () => {
        const { result } = renderHook(() => useTaskItemFieldLayout(buildParams({
            settings: {
                gtd: {
                    taskEditor: {
                        sections: {
                            dueDate: 'scheduling',
                        },
                        sectionOpen: {
                            scheduling: true,
                            details: false,
                        },
                    },
                },
            },
        })));

        expect(result.current.basicFields).not.toContain('dueDate');
        expect(result.current.schedulingFields).toContain('dueDate');
        expect(result.current.sectionOpenDefaults).toEqual({
            basic: true,
            scheduling: true,
            organization: false,
            details: false,
        });
    });
});
