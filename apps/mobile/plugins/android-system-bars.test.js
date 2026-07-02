import { describe, expect, it } from 'vitest';

const plugin = require('./android-system-bars');

const {
  DARK_BACKGROUND,
  LIGHT_BACKGROUND,
  SYSTEM_BAR_BACKGROUND,
  setSystemBarColor,
  setSystemBarStyles,
} = plugin.__testables;

const getColors = (xml) => Object.fromEntries(xml.resources.color.map((item) => [item.$.name, item._]));

const getAppThemeItems = (xml) => {
  const appTheme = xml.resources.style.find((style) => style.$.name === 'AppTheme');
  return Object.fromEntries(appTheme.item.map((item) => [item.$.name, item]));
};

describe('android-system-bars plugin', () => {
  it('sets light and night system bar background resources', () => {
    const colors = { resources: { color: [] } };

    expect(getColors(setSystemBarColor(colors, LIGHT_BACKGROUND))[SYSTEM_BAR_BACKGROUND]).toBe(LIGHT_BACKGROUND);
    expect(getColors(setSystemBarColor(colors, DARK_BACKGROUND))[SYSTEM_BAR_BACKGROUND]).toBe(DARK_BACKGROUND);
  });

  it('points Android status and navigation bars at the Mindwtr theme resource', () => {
    const styles = {
      resources: {
        style: [
          {
            $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
            item: [],
          },
        ],
      },
    };

    const items = getAppThemeItems(setSystemBarStyles(styles));
    expect(items['android:statusBarColor']._).toBe(`@color/${SYSTEM_BAR_BACKGROUND}`);
    expect(items['android:navigationBarColor']._).toBe(`@color/${SYSTEM_BAR_BACKGROUND}`);
    expect(items['android:windowLightStatusBar']._).toBe('true');
    expect(items['android:windowLightStatusBar'].$['tools:targetApi']).toBe('23');
    expect(items['android:windowLightNavigationBar']._).toBe('true');
    expect(items['android:windowLightNavigationBar'].$['tools:targetApi']).toBe('27');
    expect(items['android:enforceNavigationBarContrast']._).toBe('false');
    expect(items['android:enforceNavigationBarContrast'].$['tools:targetApi']).toBe('29');
  });
});
