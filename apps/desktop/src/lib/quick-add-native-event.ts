export const QUICK_ADD_NATIVE_TARGET_MAIN = 'main';
export const QUICK_ADD_NATIVE_TARGET_WINDOW = 'quick-add-window';

export type QuickAddNativeTarget =
    | typeof QUICK_ADD_NATIVE_TARGET_MAIN
    | typeof QUICK_ADD_NATIVE_TARGET_WINDOW;

export type QuickAddNativePayload = {
    target?: string;
};

export function getQuickAddNativeTarget(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const target = (payload as QuickAddNativePayload).target;
    return typeof target === 'string' ? target : null;
}

export function shouldHandleQuickAddNativeEvent(
    payload: unknown,
    currentTarget: QuickAddNativeTarget,
): boolean {
    const eventTarget = getQuickAddNativeTarget(payload);
    if (currentTarget === QUICK_ADD_NATIVE_TARGET_WINDOW) {
        return eventTarget === null || eventTarget === QUICK_ADD_NATIVE_TARGET_WINDOW;
    }
    return eventTarget === QUICK_ADD_NATIVE_TARGET_MAIN;
}
