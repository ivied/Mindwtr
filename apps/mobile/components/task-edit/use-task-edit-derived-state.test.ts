import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';

import { DEFAULT_TASK_EDITOR_ORDER } from './task-edit-modal.utils';
import { getMonthlyRecurrenceAnchorDate, useTaskEditDerivedState } from './use-task-edit-derived-state';

const baseTask: Task = {
    id: 'task-1',
    title: 'Monthly check',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
};

describe('getMonthlyRecurrenceAnchorDate', () => {
    it('uses the edited start date for start-only monthly recurrence setup', () => {
        const anchor = getMonthlyRecurrenceAnchorDate(
            {
                startTime: '2026-06-04T09:00',
            },
            baseTask,
        );

        expect(anchor.getFullYear()).toBe(2026);
        expect(anchor.getMonth()).toBe(5);
        expect(anchor.getDate()).toBe(4);
        expect(anchor.getDay()).toBe(4);
    });

    it('prefers the edited due date when both due and start dates are present', () => {
        const anchor = getMonthlyRecurrenceAnchorDate(
            {
                dueDate: '2026-06-10',
                startTime: '2026-06-04T09:00',
            },
            baseTask,
        );

        expect(anchor.getDate()).toBe(10);
    });
});

describe('useTaskEditDerivedState', () => {
    it('hides status when the task editor layout disables it even for non-inbox tasks', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const settings: AppData['settings'] = {
            gtd: {
                taskEditor: {
                    hidden: ['status'],
                },
            },
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                editedTask: { status: 'next' },
                settings,
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.basicFields).not.toContain('status');
        expect(derived?.showStatusField).toBe(false);
    });

    it('hides every configured field when hidden fields have no task content', () => {
        let derived: ReturnType<typeof useTaskEditDerivedState> | undefined;
        const settings: AppData['settings'] = {
            gtd: {
                taskEditor: {
                    hidden: [...DEFAULT_TASK_EDITOR_ORDER],
                },
            },
        };

        function Probe() {
            derived = useTaskEditDerivedState({
                task: baseTask,
                editedTask: { status: 'next' },
                settings,
                projects: [],
                sections: [],
                prioritiesEnabled: true,
                timeEstimatesEnabled: true,
                contextInputDraft: '',
                descriptionDraft: '',
                tagInputDraft: '',
                visibleAttachmentsLength: 0,
                t: (key) => key,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        expect(derived?.basicFields).toEqual([]);
        expect(derived?.schedulingFields).toEqual([]);
        expect(derived?.organizationFields).toEqual([]);
        expect(derived?.detailsFields).toEqual([]);
        expect(derived?.showStatusField).toBe(false);
    });
});
