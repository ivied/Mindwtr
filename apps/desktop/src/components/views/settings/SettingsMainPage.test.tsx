import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { labelFallback } from './labels';
import { SettingsMainPage, type SettingsMainPageProps } from './SettingsMainPage';

const baseProps: SettingsMainPageProps = {
    t: labelFallback.en,
    themeMode: 'system',
    onThemeChange: vi.fn(),
    densityMode: 'comfortable',
    onDensityChange: vi.fn(),
    textSizeMode: 'default',
    onTextSizeChange: vi.fn(),
    showTaskAge: false,
    onShowTaskAgeChange: vi.fn(),
    language: 'en',
    onLanguageChange: vi.fn(),
    weekStart: 'sunday',
    onWeekStartChange: vi.fn(),
    dateFormat: 'system',
    onDateFormatChange: vi.fn(),
    calendarSystem: 'gregorian',
    showCalendarSystem: false,
    onCalendarSystemChange: vi.fn(),
    timeFormat: 'system',
    onTimeFormatChange: vi.fn(),
    keybindingStyle: 'vim',
    onKeybindingStyleChange: vi.fn(),
    globalQuickAddShortcut: 'Control+Alt+M',
    onGlobalQuickAddShortcutChange: vi.fn(),
    undoNotificationsEnabled: true,
    onUndoNotificationsChange: vi.fn(),
    onOpenHelp: vi.fn(),
    languages: [{ id: 'en', native: 'English' }],
};

describe('SettingsMainPage', () => {
    it('renders and toggles launch at startup when available', () => {
        const onLaunchAtStartupChange = vi.fn();

        const { getByRole, getByText } = render(
            <SettingsMainPage
                {...baseProps}
                showLaunchAtStartup
                launchAtStartupEnabled={false}
                onLaunchAtStartupChange={onLaunchAtStartupChange}
            />,
        );

        expect(getByText('Window Behavior')).toBeInTheDocument();
        expect(getByText('Start Mindwtr automatically when you sign in to this computer.')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Launch at startup' }));

        expect(onLaunchAtStartupChange).toHaveBeenCalledWith(true);
    });

    it('disables the launch at startup toggle while the OS state is updating', () => {
        const onLaunchAtStartupChange = vi.fn();

        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                showLaunchAtStartup
                launchAtStartupEnabled
                launchAtStartupLoading
                onLaunchAtStartupChange={onLaunchAtStartupChange}
            />,
        );

        fireEvent.click(getByRole('button', { name: 'Launch at startup' }));

        expect(onLaunchAtStartupChange).not.toHaveBeenCalled();
    });

    it('shows the Flatpak quick add command and disables app-owned shortcut selection', () => {
        const { getByRole, getByText } = render(
            <SettingsMainPage
                {...baseProps}
                isFlatpak
            />,
        );

        expect(getByText('Flatpak custom shortcut command')).toBeInTheDocument();
        expect(getByText('flatpak run tech.dongdongbh.mindwtr --quick-add')).toBeInTheDocument();
        expect(getByRole('combobox', { name: 'Global quick add shortcut' })).toBeDisabled();
    });

    it('offers Saturday as a week start option', () => {
        const onWeekStartChange = vi.fn();
        const { getAllByText, getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                weekStart="saturday"
                onWeekStartChange={onWeekStartChange}
            />,
        );

        expect(getAllByText('Saturday').length).toBeGreaterThan(0);
        fireEvent.change(getByRole('combobox', { name: 'Week starts on' }), {
            target: { value: 'monday' },
        });

        expect(onWeekStartChange).toHaveBeenCalledWith('monday');
    });

    it('only renders the calendar system selector when enabled', () => {
        const onCalendarSystemChange = vi.fn();
        const hidden = render(<SettingsMainPage {...baseProps} />);
        expect(hidden.queryByText('Calendar system')).toBeNull();
        hidden.unmount();

        const { getByRole, getByText } = render(
            <SettingsMainPage
                {...baseProps}
                showCalendarSystem
                calendarSystem="jalali"
                onCalendarSystemChange={onCalendarSystemChange}
            />,
        );

        expect(getByText('Calendar system')).toBeInTheDocument();
        fireEvent.change(getByRole('combobox', { name: 'Calendar system' }), {
            target: { value: 'gregorian' },
        });

        expect(onCalendarSystemChange).toHaveBeenCalledWith('gregorian');
    });

    it('offers the small text size preset', () => {
        const onTextSizeChange = vi.fn();
        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                textSizeMode="small"
                onTextSizeChange={onTextSizeChange}
            />,
        );

        const select = getByRole('combobox', { name: 'Text size' });
        expect(select).toHaveValue('small');

        fireEvent.change(select, {
            target: { value: 'large' },
        });

        expect(onTextSizeChange).toHaveBeenCalledWith('large');
    });
});
