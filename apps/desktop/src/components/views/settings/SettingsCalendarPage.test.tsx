import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { labelFallback } from './labels';
import { SettingsCalendarPage } from './SettingsCalendarPage';

const baseProps = {
    t: labelFallback.en,
    newCalendarName: '',
    newCalendarUrl: '',
    calendarError: null,
    externalCalendars: [],
    showSystemCalendarSection: false,
    systemCalendarPermission: 'unsupported' as const,
    onCalendarNameChange: vi.fn(),
    onCalendarUrlChange: vi.fn(),
    onAddCalendar: vi.fn(),
    onToggleCalendar: vi.fn(),
    onRemoveCalendar: vi.fn(),
    onRequestSystemCalendarPermission: vi.fn(),
    maskCalendarUrl: (url: string) => url,
};

describe('SettingsCalendarPage', () => {
    it('offers a local ICS file picker when available', () => {
        const onChooseLocalCalendarFile = vi.fn();
        const { getByRole } = render(
            <SettingsCalendarPage
                {...baseProps}
                onChooseLocalCalendarFile={onChooseLocalCalendarFile}
            />,
        );

        fireEvent.click(getByRole('button', { name: 'Choose local .ics file' }));

        expect(onChooseLocalCalendarFile).toHaveBeenCalledTimes(1);
    });
});
