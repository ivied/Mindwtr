import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting } from '@mindwtr/core';

import { useTaskEditDates } from './use-task-edit-dates';

const t = (key: string) => ({
    'common.notSet': 'Not set',
}[key] ?? key);

afterEach(() => {
    configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
});

function DateFormatterProbe({ startDate, dueDate }: { startDate: string; dueDate: string }) {
    const { formatDate, formatDueDate } = useTaskEditDates({
        editedTask: {},
        pendingDueDate: null,
        pendingStartDate: null,
        setEditedTask: vi.fn(),
        setPendingDueDate: vi.fn(),
        setPendingStartDate: vi.fn(),
        setShowDatePicker: vi.fn(),
        showDatePicker: null,
        t,
    });

    return <Text>{`${formatDate(startDate)}|${formatDueDate(dueDate)}`}</Text>;
}

describe('useTaskEditDates', () => {
    it('formats task edit dates with the configured app date and time format', () => {
        configureDateFormatting({ language: 'en', dateFormat: 'ymd', timeFormat: '24h', systemLocale: 'en-US' });

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <DateFormatterProbe
                    startDate="2026-06-05"
                    dueDate="2026-06-05T17:00:00"
                />
            );
        });

        expect(tree.root.findByType(Text).props.children).toBe('2026-06-05|2026-06-05 17:00');
    });
});
