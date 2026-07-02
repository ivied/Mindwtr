import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Platform, type TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAndroidQuickCaptureExpand } from './useAndroidQuickCaptureExpand';

type HookSnapshot = ReturnType<typeof useAndroidQuickCaptureExpand> & {
  clearInitialFocusTimer: ReturnType<typeof vi.fn>;
  inputRef: RefObject<TextInput | null>;
  keyboardAvoidingEnabled: boolean;
  optionsExpanded: boolean;
};

const withPlatform = async (os: typeof Platform.OS, run: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  try {
    await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(Platform, 'OS', descriptor);
    }
  }
};

function TestHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }) {
  const inputRef = useRef<TextInput | null>(null);
  const clearInitialFocusTimer = useRef(vi.fn()).current;
  const [keyboardAvoidingEnabled, setKeyboardAvoidingEnabled] = useState(true);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const controller = useAndroidQuickCaptureExpand({
    clearInitialFocusTimer,
    fallbackMs: 500,
    inputRef,
    setKeyboardAvoidingEnabled,
    setOptionsExpanded,
  });

  useEffect(() => {
    onSnapshot({
      ...controller,
      clearInitialFocusTimer,
      inputRef,
      keyboardAvoidingEnabled,
      optionsExpanded,
    });
  });

  return null;
}

describe('useAndroidQuickCaptureExpand', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('expands immediately when the Android keyboard is already hidden', async () => {
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    const dismiss = vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    const addListener = vi.spyOn(Keyboard, 'addListener');
    let snapshot!: HookSnapshot;

    await withPlatform('android', async () => {
      await act(async () => {
        create(<TestHarness onSnapshot={(next) => { snapshot = next; }} />);
        await Promise.resolve();
      });
      const blur = vi.fn();
      snapshot.inputRef.current = { blur } as unknown as TextInput;

      await act(async () => {
        snapshot.requestAndroidOptionsExpand();
        await Promise.resolve();
      });

      expect(blur).toHaveBeenCalledOnce();
      expect(dismiss).toHaveBeenCalledOnce();
      expect(addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
      expect(snapshot.optionsExpanded).toBe(true);
      expect(snapshot.keyboardAvoidingEnabled).toBe(false);
      expect(snapshot.androidOptionsExpandPhase).toBe('expanded');
    });
  });

  it('keeps the sheet lifted until the Android keyboard hide event fires', async () => {
    vi.useFakeTimers();
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    const remove = vi.fn();
    const hideListeners: Array<() => void> = [];
    const showListeners: Array<() => void> = [];
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, callback: () => void) => {
      if (event === 'keyboardDidHide') hideListeners.push(callback);
      if (event === 'keyboardDidShow') showListeners.push(callback);
      return { remove };
    }) as unknown as typeof Keyboard.addListener);
    let snapshot!: HookSnapshot;

    await withPlatform('android', async () => {
      await act(async () => {
        create(<TestHarness onSnapshot={(next) => { snapshot = next; }} />);
        await Promise.resolve();
      });
      snapshot.inputRef.current = { blur: vi.fn() } as unknown as TextInput;

      await act(async () => {
        snapshot.requestAndroidOptionsExpand();
        await Promise.resolve();
      });

      expect(hideListeners).toHaveLength(1);
      expect(snapshot.optionsExpanded).toBe(false);
      expect(snapshot.keyboardAvoidingEnabled).toBe(true);
      expect(snapshot.androidOptionsExpandPhase).toBe('hiding');

      await act(async () => {
        hideListeners[0]?.();
        await Promise.resolve();
      });

      expect(remove).toHaveBeenCalledOnce();
      expect(snapshot.optionsExpanded).toBe(true);
      expect(snapshot.keyboardAvoidingEnabled).toBe(false);
      expect(snapshot.androidOptionsExpandPhase).toBe('expanded');
      expect(showListeners).toHaveLength(1);

      await act(async () => {
        showListeners[0]?.();
        await Promise.resolve();
      });

      expect(snapshot.optionsExpanded).toBe(true);
      expect(snapshot.keyboardAvoidingEnabled).toBe(true);
      expect(snapshot.androidOptionsExpandPhase).toBe('expanded');
    });
  });

  it('uses the fallback timer if Android never reports the keyboard hide event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    vi.spyOn(Keyboard, 'dismiss').mockImplementation(vi.fn());
    vi.spyOn(Keyboard, 'addListener').mockReturnValue({ remove: vi.fn() } as unknown as ReturnType<typeof Keyboard.addListener>);
    let snapshot!: HookSnapshot;

    await withPlatform('android', async () => {
      await act(async () => {
        create(<TestHarness onSnapshot={(next) => { snapshot = next; }} />);
        await Promise.resolve();
      });

      await act(async () => {
        snapshot.requestAndroidOptionsExpand();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
      });

      expect(snapshot.optionsExpanded).toBe(true);
      expect(snapshot.keyboardAvoidingEnabled).toBe(false);
      expect(snapshot.androidOptionsExpandPhase).toBe('expanded');
    });
  });
});
