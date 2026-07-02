import { Platform } from 'react-native';
import { describe, expect, it } from 'vitest';

import { getControlledTextInputSelection } from './text-input-selection';

const withPlatform = (os: typeof Platform.OS, run: () => void) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

describe('getControlledTextInputSelection', () => {
  it('does not control Android TextInput selection during normal typing', () => {
    withPlatform('android', () => {
      expect(getControlledTextInputSelection({ start: 2, end: 2 })).toBeUndefined();
    });
  });

  it('allows Android selection control during programmatic caret restoration', () => {
    withPlatform('android', () => {
      expect(getControlledTextInputSelection({ start: 2, end: 2 }, { force: true })).toEqual({ start: 2, end: 2 });
    });
  });

  it('keeps controlled selection on iOS', () => {
    withPlatform('ios', () => {
      expect(getControlledTextInputSelection({ start: 2, end: 2 })).toEqual({ start: 2, end: 2 });
    });
  });
});
