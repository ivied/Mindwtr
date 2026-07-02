import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

import { getAndroidKeyboardFrame } from './android-keyboard-frame';

/**
 * Track the on-screen Android keyboard inset (its height in px) while `active`.
 *
 * Transparent React Native modals run in their own Android window that does not
 * resize for the soft keyboard, so any sheet or popup that floats content above
 * the keyboard has to measure the inset itself and lift its content by that
 * amount. Returns 0 on iOS (where KeyboardAvoidingView / automatic insets handle
 * it) and whenever the keyboard is closed, so callers can apply the value as
 * `paddingBottom` unconditionally.
 */
export function useAndroidKeyboardInset(active = true): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!active) {
      setInset(0);
      return;
    }
    if (typeof Keyboard?.addListener !== 'function') return;
    const applyFrame = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
      setInset(getAndroidKeyboardFrame(event).inset);
    };
    const reset = () => setInset(0);
    const showSub = Keyboard.addListener('keyboardDidShow', applyFrame);
    const changeSub = Keyboard.addListener('keyboardDidChangeFrame', applyFrame);
    const hideSub = Keyboard.addListener('keyboardDidHide', reset);
    return () => {
      showSub.remove();
      changeSub.remove();
      hideSub.remove();
    };
  }, [active]);

  return inset;
}
