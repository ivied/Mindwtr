import { describe, expect, it } from 'vitest';

import { resolveAndroidSystemBarStyle } from './android-system-bars';

describe('android-system-bars', () => {
  it('uses dark navigation buttons on light Mindwtr themes', () => {
    expect(resolveAndroidSystemBarStyle({ bg: '#F6F7FB' }, false)).toEqual({
      navigationBarColor: '#F6F7FB',
      darkNavigationButtons: true,
    });
  });

  it('uses light navigation buttons on dark Mindwtr themes', () => {
    expect(resolveAndroidSystemBarStyle({ bg: '#151718' }, true)).toEqual({
      navigationBarColor: '#151718',
      darkNavigationButtons: false,
    });
  });

  it('uses the actual background for preset theme navigation button contrast', () => {
    expect(resolveAndroidSystemBarStyle({ bg: '#000000' }, false).darkNavigationButtons).toBe(false);
    expect(resolveAndroidSystemBarStyle({ bg: '#FFFFFF' }, true).darkNavigationButtons).toBe(true);
  });
});
