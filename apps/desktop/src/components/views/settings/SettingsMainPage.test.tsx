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
});
