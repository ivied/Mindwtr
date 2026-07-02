import type { AppStateStatus } from 'react-native';

export const EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS = 1_000;

export function shouldRefreshExternalCalendarOnAppStateChange(
  previousAppState: AppStateStatus,
  nextAppState: AppStateStatus,
): boolean {
  const wasInactiveOrBackground = previousAppState === 'inactive' || previousAppState === 'background';
  return wasInactiveOrBackground && nextAppState === 'active';
}
