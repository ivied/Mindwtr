import {
    recordPromptActivity,
    type UserPromptState,
} from '@mindwtr/core';

export const LOCAL_USER_PROMPT_STATE_KEY = 'mindwtr:local-user-prompts:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readLocalUserPromptState(storage = getStorage()): UserPromptState {
    if (!storage) return {};
    const raw = storage.getItem(LOCAL_USER_PROMPT_STATE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed as UserPromptState : {};
    } catch {
        return {};
    }
}

export function writeLocalUserPromptState(
    promptState: UserPromptState,
    storage = getStorage(),
): void {
    if (!storage) return;
    storage.setItem(LOCAL_USER_PROMPT_STATE_KEY, JSON.stringify(promptState));
}

export function updateLocalUserPromptState(
    updater: (promptState: UserPromptState) => UserPromptState,
    storage = getStorage(),
): UserPromptState {
    const current = readLocalUserPromptState(storage);
    const next = updater(current);
    writeLocalUserPromptState(next, storage);
    return next;
}

export function recordLocalPromptActivity(nowMs = Date.now()): UserPromptState {
    return updateLocalUserPromptState((promptState) => recordPromptActivity(promptState, nowMs));
}
