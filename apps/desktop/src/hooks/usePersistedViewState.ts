import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

type SanitizePersistedViewState<T> = (value: unknown, fallback: T) => T;

function readPersistedViewState<T>(
    storageKey: string,
    fallback: T,
    sanitize?: SanitizePersistedViewState<T>
): T {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as unknown;
        return sanitize ? sanitize(parsed, fallback) : parsed as T;
    } catch {
        return fallback;
    }
}

function savePersistedViewState<T>(storageKey: string, value: T) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
        // View state is a convenience. Storage failures should not block UI changes.
    }
}

export function usePersistedViewState<T>(
    storageKey: string,
    fallback: T,
    sanitize?: SanitizePersistedViewState<T>
): [T, Dispatch<SetStateAction<T>>] {
    const [state, setState] = useState<T>(() => readPersistedViewState(storageKey, fallback, sanitize));

    const setPersistedState = useCallback<Dispatch<SetStateAction<T>>>((nextState) => {
        setState((current) => {
            const next = typeof nextState === 'function'
                ? (nextState as (value: T) => T)(current)
                : nextState;
            savePersistedViewState(storageKey, next);
            return next;
        });
    }, [storageKey]);

    return [state, setPersistedState];
}
