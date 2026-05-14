import { useCallback, useEffect, useState } from 'react';
import { generateUUID, type AppData, type ExternalCalendarSubscription } from '@mindwtr/core';
import { ExternalCalendarService } from '../../../lib/external-calendar-service';
import {
    getCalendarSourceFileName,
    isSupportedCalendarSourceUrl,
    localPathToCalendarFileUrl,
} from '../../../lib/external-calendar-source';
import { reportError } from '../../../lib/report-error';
import { isTauriRuntime } from '../../../lib/runtime';
import {
    getSystemCalendarPermissionStatus,
    requestSystemCalendarPermission,
    type SystemCalendarPermissionStatus,
} from '../../../lib/system-calendar';

type UseCalendarSettingsOptions = {
    showSaved: () => void;
    settings: AppData['settings'] | undefined;
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    isMac: boolean;
};

export function useCalendarSettings({ showSaved, settings, updateSettings, isMac }: UseCalendarSettingsOptions) {
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [calendarError, setCalendarError] = useState<string | null>(null);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('unsupported');

    useEffect(() => {
        let cancelled = false;
        ExternalCalendarService.getCalendars()
            .then(async (stored) => {
                if (cancelled) return;
                if (Array.isArray(settings?.externalCalendars)) {
                    setExternalCalendars(settings.externalCalendars);
                    if (settings.externalCalendars.length || stored.length) {
                        await ExternalCalendarService.setCalendars(settings.externalCalendars);
                    }
                    return;
                }
                setExternalCalendars(stored);
            })
            .catch((error) => reportError('Failed to load calendars', error));
        return () => {
            cancelled = true;
        };
    }, [settings?.externalCalendars]);

    const refreshSystemCalendarPermission = useCallback(async () => {
        if (!isMac) {
            setSystemCalendarPermission('unsupported');
            return;
        }
        const status = await getSystemCalendarPermissionStatus();
        setSystemCalendarPermission(status);
    }, [isMac]);

    useEffect(() => {
        void refreshSystemCalendarPermission();
        const onFocus = () => {
            void refreshSystemCalendarPermission();
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [refreshSystemCalendarPermission]);

    const persistCalendars = useCallback(async (next: ExternalCalendarSubscription[]) => {
        setCalendarError(null);
        setExternalCalendars(next);
        try {
            await ExternalCalendarService.setCalendars(next);
            await updateSettings({ externalCalendars: next });
            showSaved();
        } catch (error) {
            reportError('Failed to save calendars', error);
            setCalendarError(String(error));
        }
    }, [showSaved, updateSettings]);

    const handleAddCalendar = useCallback(() => {
        const url = newCalendarUrl.trim();
        if (!url) return;
        if (!isSupportedCalendarSourceUrl(url)) {
            setCalendarError('Use an http(s), webcal, or absolute file:///path.ics source.');
            return;
        }
        const name = (newCalendarName.trim() || 'Calendar').trim();
        const next = [
            ...externalCalendars,
            { id: generateUUID(), name, url, enabled: true },
        ];
        setNewCalendarName('');
        setNewCalendarUrl('');
        persistCalendars(next);
    }, [externalCalendars, newCalendarName, newCalendarUrl, persistCalendars]);

    const handleChooseLocalCalendarFile = useCallback(async () => {
        if (!isTauriRuntime()) {
            setCalendarError('Local ICS files require the desktop app.');
            return;
        }
        setCalendarError(null);
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: false,
                directory: false,
                filters: [{ name: 'ICS calendar', extensions: ['ics'] }],
            });
            if (!selected || Array.isArray(selected)) return;
            const url = localPathToCalendarFileUrl(String(selected));
            setNewCalendarUrl(url);
            if (!newCalendarName.trim()) {
                setNewCalendarName(getCalendarSourceFileName(url).replace(/\.ics$/i, '') || 'Calendar');
            }
        } catch (error) {
            reportError('Failed to choose local ICS calendar', error);
            setCalendarError(String(error));
        }
    }, [newCalendarName]);

    const handleToggleCalendar = useCallback((id: string, enabled: boolean) => {
        const next = externalCalendars.map((calendar) => (calendar.id === id ? { ...calendar, enabled } : calendar));
        persistCalendars(next);
    }, [externalCalendars, persistCalendars]);

    const handleRemoveCalendar = useCallback((id: string) => {
        const next = externalCalendars.filter((calendar) => calendar.id !== id);
        persistCalendars(next);
    }, [externalCalendars, persistCalendars]);

    const handleRequestSystemCalendarPermission = useCallback(async () => {
        if (!isMac) return;
        const status = await requestSystemCalendarPermission();
        setSystemCalendarPermission(status);
        if (status === 'granted') {
            showSaved();
        }
    }, [isMac, showSaved]);

    return {
        externalCalendars,
        newCalendarName,
        newCalendarUrl,
        calendarError,
        systemCalendarPermission,
        setNewCalendarName,
        setNewCalendarUrl,
        handleAddCalendar,
        handleChooseLocalCalendarFile,
        handleToggleCalendar,
        handleRemoveCalendar,
        handleRequestSystemCalendarPermission,
    };
}
