import type { ExternalCalendarEvent, ExternalCalendarSubscription } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { reportError } from './report-error';

export type SystemCalendarPermissionStatus = 'undetermined' | 'granted' | 'denied' | 'unsupported';

export type SystemCalendarPushTarget = {
    id: string;
    name: string;
    sourceName?: string;
    color?: string;
    isMindwtrDedicated: boolean;
};

export type SystemCalendarEventDetails = {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    notes?: string;
    location?: string;
};

type MacOsCalendarReadResult = {
    permission: SystemCalendarPermissionStatus;
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
};

type MacOsCalendarEventWriteResult = {
    ok?: boolean;
    eventId?: string;
    error?: string;
};

export type SystemCalendarEventWriteResult = {
    ok: boolean;
    eventId: string | null;
    error?: string;
};

const UNSUPPORTED_RESULT: MacOsCalendarReadResult = {
    permission: 'unsupported',
    calendars: [],
    events: [],
};

const normalizePermissionStatus = (value: unknown): SystemCalendarPermissionStatus => {
    if (value === 'undetermined' || value === 'granted' || value === 'denied' || value === 'unsupported') {
        return value;
    }
    return 'denied';
};

const isMacOsEnvironment = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const source = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    return source.includes('mac');
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as never, args as never);
}

export async function getSystemCalendarPermissionStatus(): Promise<SystemCalendarPermissionStatus> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) return 'unsupported';
    try {
        const status = await tauriInvoke<string>('get_macos_calendar_permission_status');
        return normalizePermissionStatus(status);
    } catch (error) {
        reportError('Failed to read macOS calendar permission status', error);
        return 'denied';
    }
}

export async function requestSystemCalendarPermission(): Promise<SystemCalendarPermissionStatus> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) return 'unsupported';
    try {
        const status = await tauriInvoke<string>('request_macos_calendar_permission');
        return normalizePermissionStatus(status);
    } catch (error) {
        reportError('Failed to request macOS calendar permission', error);
        return 'denied';
    }
}

export async function fetchSystemCalendarEvents(rangeStart: Date, rangeEnd: Date): Promise<MacOsCalendarReadResult> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) return UNSUPPORTED_RESULT;
    try {
        const payload = await tauriInvoke<MacOsCalendarReadResult>('get_macos_calendar_events', {
            rangeStart: rangeStart.toISOString(),
            rangeEnd: rangeEnd.toISOString(),
        });
        return {
            permission: normalizePermissionStatus(payload?.permission),
            calendars: Array.isArray(payload?.calendars) ? payload.calendars : [],
            events: Array.isArray(payload?.events) ? payload.events : [],
        };
    } catch (error) {
        reportError('Failed to read macOS EventKit events', error);
        return {
            permission: 'denied',
            calendars: [],
            events: [],
        };
    }
}

const sanitizePushTarget = (target: SystemCalendarPushTarget): SystemCalendarPushTarget | null => {
    const id = typeof target?.id === 'string' ? target.id.trim() : '';
    if (!id) return null;
    const name = typeof target?.name === 'string' && target.name.trim().length > 0
        ? target.name.trim()
        : 'Calendar';
    return {
        id,
        name,
        sourceName: typeof target.sourceName === 'string' && target.sourceName.trim().length > 0
            ? target.sourceName.trim()
            : undefined,
        color: typeof target.color === 'string' && target.color.trim().length > 0 ? target.color.trim() : undefined,
        isMindwtrDedicated: target.isMindwtrDedicated === true,
    };
};

export async function getSystemCalendarPushTargets(): Promise<SystemCalendarPushTarget[]> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) return [];
    try {
        const targets = await tauriInvoke<SystemCalendarPushTarget[]>('get_macos_writable_calendars');
        return Array.isArray(targets)
            ? targets.map(sanitizePushTarget).filter((target): target is SystemCalendarPushTarget => Boolean(target))
            : [];
    } catch (error) {
        reportError('Failed to read writable macOS calendars', error);
        return [];
    }
}

export async function ensureSystemMindwtrCalendar(storedCalendarId?: string | null): Promise<SystemCalendarPushTarget | null> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) return null;
    try {
        const target = await tauriInvoke<SystemCalendarPushTarget | null>('ensure_macos_mindwtr_calendar', {
            storedCalendarId: storedCalendarId?.trim() || null,
        });
        return target ? sanitizePushTarget(target) : null;
    } catch (error) {
        reportError('Failed to create Mindwtr macOS calendar', error);
        return null;
    }
}

const normalizeWriteResult = (result: MacOsCalendarEventWriteResult | null | undefined): SystemCalendarEventWriteResult => {
    const eventId = typeof result?.eventId === 'string' ? result.eventId.trim() : '';
    const error = typeof result?.error === 'string' && result.error.trim().length > 0
        ? result.error.trim()
        : undefined;
    return {
        ok: result?.ok === true,
        eventId: eventId || null,
        error,
    };
};

export async function createSystemCalendarEventResult(details: SystemCalendarEventDetails): Promise<SystemCalendarEventWriteResult> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const result = await tauriInvoke<MacOsCalendarEventWriteResult>('create_macos_calendar_event', { details });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to create macOS calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function createSystemCalendarEvent(details: SystemCalendarEventDetails): Promise<string | null> {
    const result = await createSystemCalendarEventResult(details);
    return result.ok ? result.eventId : null;
}

export async function updateSystemCalendarEventResult(
    eventId: string,
    details: SystemCalendarEventDetails
): Promise<SystemCalendarEventWriteResult> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const result = await tauriInvoke<MacOsCalendarEventWriteResult>('update_macos_calendar_event', { eventId, details });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to update macOS calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function updateSystemCalendarEvent(eventId: string, details: SystemCalendarEventDetails): Promise<string | null> {
    const result = await updateSystemCalendarEventResult(eventId, details);
    return result.ok ? result.eventId : null;
}

export async function deleteSystemCalendarEventResult(eventId: string): Promise<SystemCalendarEventWriteResult> {
    if (!isTauriRuntime() || !isMacOsEnvironment()) {
        return { ok: false, eventId: null, error: 'unsupported' };
    }
    try {
        const result = await tauriInvoke<MacOsCalendarEventWriteResult>('delete_macos_calendar_event', { eventId });
        return normalizeWriteResult(result);
    } catch (error) {
        reportError('Failed to delete macOS calendar event', error);
        return { ok: false, eventId: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function deleteSystemCalendarEvent(eventId: string): Promise<boolean> {
    const result = await deleteSystemCalendarEventResult(eventId);
    return result.ok;
}
