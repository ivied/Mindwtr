import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import {
    InboxProcessingScheduleFields,
    type InboxProcessingScheduleFieldControl,
    type InboxProcessingScheduleFieldsControls,
} from './InboxProcessingScheduleFields';

const t = (key: string) => {
    const labels: Record<string, string> = {
        'common.clear': 'Clear',
        'taskEdit.startDateLabel': 'Start Date',
        'taskEdit.dueDateLabel': 'Due Date',
        'taskEdit.reviewDateLabel': 'Review Date',
        'taskEdit.dateOnly': 'Date only',
        'task.aria.startTime': 'Start time',
        'task.aria.dueTime': 'Due time',
        'task.aria.reviewTime': 'Review time',
    };
    return labels[key] ?? key;
};

const createField = (
    overrides: Partial<InboxProcessingScheduleFieldControl> = {}
): InboxProcessingScheduleFieldControl => ({
    date: '',
    timeDraft: '',
    hasTime: false,
    onDateChange: vi.fn(),
    onTimeDraftChange: vi.fn(),
    onTimeCommit: vi.fn(),
    onClear: vi.fn(),
    onDateOnly: vi.fn(),
    ...overrides,
});

const createControls = (
    overrides: Partial<InboxProcessingScheduleFieldsControls> = {}
): InboxProcessingScheduleFieldsControls => ({
    start: createField(),
    due: createField(),
    review: createField(),
    ...overrides,
});

afterEach(() => {
    cleanup();
});

describe('InboxProcessingScheduleFields date-only control', () => {
    it('strips the time when the date-only button is clicked', () => {
        const onDateOnly = vi.fn();
        const fields = createControls({
            due: createField({ date: '2026-04-19', timeDraft: '11:45', hasTime: true, onDateOnly }),
        });

        const { getByRole } = render(
            <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
        );

        fireEvent.click(getByRole('button', { name: 'Date only: Due Date' }));

        expect(onDateOnly).toHaveBeenCalledTimes(1);
    });

    it('hides the date-only button when the field has no time', () => {
        const fields = createControls({
            due: createField({ date: '2026-04-19', timeDraft: '', hasTime: false }),
        });

        const { queryByRole } = render(
            <InboxProcessingScheduleFields t={t} fields={fields} visibleFieldKeys={['due']} />
        );

        expect(queryByRole('button', { name: 'Date only: Due Date' })).toBeNull();
    });
});
