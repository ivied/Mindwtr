import type { MobileQuickAccessView } from '@mindwtr/core';

export const DEFAULT_MOBILE_QUICK_ACCESS_VIEW: MobileQuickAccessView = 'review';

export const MOBILE_QUICK_ACCESS_VIEWS: MobileQuickAccessView[] = [
  'review',
  'projects',
  'calendar',
  'contexts',
];

export const MOBILE_QUICK_ACCESS_TAB_ROUTE: Record<MobileQuickAccessView, string> = {
  review: 'review-tab',
  projects: 'projects',
  calendar: 'calendar-tab',
  contexts: 'contexts-tab',
};

export const MOBILE_QUICK_ACCESS_STACK_ROUTE: Record<MobileQuickAccessView, string> = {
  review: '/review',
  projects: '/projects-screen',
  calendar: '/calendar',
  contexts: '/contexts',
};

export function coerceMobileQuickAccessView(value: unknown): MobileQuickAccessView {
  return MOBILE_QUICK_ACCESS_VIEWS.includes(value as MobileQuickAccessView)
    ? value as MobileQuickAccessView
    : DEFAULT_MOBILE_QUICK_ACCESS_VIEW;
}
