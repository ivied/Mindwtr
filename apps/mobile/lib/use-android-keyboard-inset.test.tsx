import React from 'react';
import { Keyboard, Platform, Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAndroidKeyboardInset } from './use-android-keyboard-inset';

const originalPlatformOs = Platform.OS;

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};

function Probe({ active }: { active?: boolean }) {
  const inset = useAndroidKeyboardInset(active);
  return <Text>{`inset:${inset}`}</Text>;
}

const insetText = (tree: ReturnType<typeof create>): string => {
  const node = tree.root.findByType(Text);
  return String(node.props.children);
};

afterEach(() => {
  setPlatform(originalPlatformOs);
  vi.restoreAllMocks();
});

describe('useAndroidKeyboardInset', () => {
  it('tracks the measured keyboard height on Android and resets on hide', () => {
    setPlatform('android');
    const listeners = new Map<string, (event?: any) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, cb: any) => {
      listeners.set(event, cb);
      return { remove: vi.fn() } as any;
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active />);
    });

    expect(insetText(tree)).toBe('inset:0');

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320 } });
    });
    expect(insetText(tree)).toBe('inset:320');

    act(() => {
      listeners.get('keyboardDidHide')?.();
    });
    expect(insetText(tree)).toBe('inset:0');
  });

  it('does not attach listeners or report an inset on iOS', () => {
    setPlatform('ios');
    const addListener = vi.spyOn(Keyboard, 'addListener');

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active />);
    });

    expect(addListener).not.toHaveBeenCalled();
    expect(insetText(tree)).toBe('inset:0');
  });

  it('stays at zero while inactive', () => {
    setPlatform('android');
    const addListener = vi.spyOn(Keyboard, 'addListener');

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active={false} />);
    });

    expect(addListener).not.toHaveBeenCalled();
    expect(insetText(tree)).toBe('inset:0');
  });
});
