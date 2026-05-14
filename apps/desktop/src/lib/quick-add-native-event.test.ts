import { describe, expect, it } from 'vitest';
import {
    QUICK_ADD_NATIVE_TARGET_MAIN,
    QUICK_ADD_NATIVE_TARGET_WINDOW,
    getQuickAddNativeTarget,
    shouldHandleQuickAddNativeEvent,
} from './quick-add-native-event';

describe('quick add native event targeting', () => {
    it('reads native quick add event targets', () => {
        expect(getQuickAddNativeTarget({ target: QUICK_ADD_NATIVE_TARGET_MAIN })).toBe(QUICK_ADD_NATIVE_TARGET_MAIN);
        expect(getQuickAddNativeTarget({ target: QUICK_ADD_NATIVE_TARGET_WINDOW })).toBe(QUICK_ADD_NATIVE_TARGET_WINDOW);
        expect(getQuickAddNativeTarget({ target: 1 })).toBeNull();
        expect(getQuickAddNativeTarget(undefined)).toBeNull();
    });

    it('keeps popup events out of the main app modal', () => {
        expect(shouldHandleQuickAddNativeEvent({ target: QUICK_ADD_NATIVE_TARGET_WINDOW }, QUICK_ADD_NATIVE_TARGET_MAIN)).toBe(false);
        expect(shouldHandleQuickAddNativeEvent({ target: QUICK_ADD_NATIVE_TARGET_MAIN }, QUICK_ADD_NATIVE_TARGET_MAIN)).toBe(true);
    });

    it('allows the popup window to handle popup and legacy untargeted events', () => {
        expect(shouldHandleQuickAddNativeEvent({ target: QUICK_ADD_NATIVE_TARGET_WINDOW }, QUICK_ADD_NATIVE_TARGET_WINDOW)).toBe(true);
        expect(shouldHandleQuickAddNativeEvent(undefined, QUICK_ADD_NATIVE_TARGET_WINDOW)).toBe(true);
        expect(shouldHandleQuickAddNativeEvent({ target: QUICK_ADD_NATIVE_TARGET_MAIN }, QUICK_ADD_NATIVE_TARGET_WINDOW)).toBe(false);
    });

    it('ignores legacy untargeted native events in the main app', () => {
        expect(shouldHandleQuickAddNativeEvent(undefined, QUICK_ADD_NATIVE_TARGET_MAIN)).toBe(false);
    });
});
