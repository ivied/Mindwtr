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
    calendarPushEnabled: false,
    calendarPushTargetCalendarId: null,
    calendarPushTargets: [],
    calendarPushLoading: false,
    onCalendarNameChange: vi.fn(),
    onCalendarUrlChange: vi.fn(),
    onAddCalendar: vi.fn(),
    onToggleCalendar: vi.fn(),
    onCalendarColorChange: vi.fn(),
    onRemoveCalendar: vi.fn(),
    onRequestSystemCalendarPermission: vi.fn(),
    onToggleCalendarPush: vi.fn(),
    onCalendarPushTargetChange: vi.fn(),
    onRefreshCalendarPushTargets: vi.fn(),
    maskCalendarUrl: (url: string) => url,
};

describe('SettingsCalendarPage', () => {
    it('links to the calendar integration guide in the docs site', () => {
        const { getByRole } = render(<SettingsCalendarPage {...baseProps} />);

        expect(getByRole('link', { name: /Calendar integration guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/use/calendar-integration',
        );
    });

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

    it('changes an external calendar color from the swatches', () => {
        const onCalendarColorChange = vi.fn();
        const { getByRole } = render(
            <SettingsCalendarPage
                {...baseProps}
                externalCalendars={[{
                    id: 'work',
                    name: 'Work',
                    url: 'https://calendar.example/work.ics',
                    enabled: true,
                    color: '#2563EB',
                }]}
                onCalendarColorChange={onCalendarColorChange}
            />,
        );

        fireEvent.click(getByRole('button', { name: 'Work #7C3AED' }));
        expect(onCalendarColorChange).toHaveBeenCalledWith('work', '#7C3AED');
    });
});
