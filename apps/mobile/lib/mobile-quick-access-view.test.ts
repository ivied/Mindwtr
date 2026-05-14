import { describe, expect, it } from 'vitest';

import {
  coerceMobileQuickAccessView,
  DEFAULT_MOBILE_QUICK_ACCESS_VIEW,
  MOBILE_QUICK_ACCESS_STACK_ROUTE,
  MOBILE_QUICK_ACCESS_TAB_ROUTE,
  MOBILE_QUICK_ACCESS_VIEWS,
} from './mobile-quick-access-view';

describe('mobile quick access view', () => {
  it('defaults unsupported values to review', () => {
    expect(coerceMobileQuickAccessView(undefined)).toBe(DEFAULT_MOBILE_QUICK_ACCESS_VIEW);
    expect(coerceMobileQuickAccessView('trash')).toBe(DEFAULT_MOBILE_QUICK_ACCESS_VIEW);
  });

  it('maps every quick access view to a tab and fallback stack route', () => {
    for (const view of MOBILE_QUICK_ACCESS_VIEWS) {
      expect(MOBILE_QUICK_ACCESS_TAB_ROUTE[view]).toBeTruthy();
      expect(MOBILE_QUICK_ACCESS_STACK_ROUTE[view]).toMatch(/^\//);
    }
  });
});

