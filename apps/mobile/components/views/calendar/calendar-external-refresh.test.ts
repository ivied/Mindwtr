import { describe, expect, it } from 'vitest';

import { shouldRefreshExternalCalendarOnAppStateChange } from './calendar-external-refresh';

describe('shouldRefreshExternalCalendarOnAppStateChange', () => {
  it('refreshes when the app returns from background or inactive state', () => {
    expect(shouldRefreshExternalCalendarOnAppStateChange('background', 'active')).toBe(true);
    expect(shouldRefreshExternalCalendarOnAppStateChange('inactive', 'active')).toBe(true);
  });

  it('does not refresh for active-to-active or backgrounding transitions', () => {
    expect(shouldRefreshExternalCalendarOnAppStateChange('active', 'active')).toBe(false);
    expect(shouldRefreshExternalCalendarOnAppStateChange('active', 'background')).toBe(false);
    expect(shouldRefreshExternalCalendarOnAppStateChange('inactive', 'background')).toBe(false);
  });
});
