import AsyncStorage from '@react-native-async-storage/async-storage';

import type { SyncBackend } from './sync-service-utils';

export const MOBILE_ONBOARDING_STORAGE_KEY = 'mindwtr:mobile:first-run-onboarding:v1';

type MobileFirstRunOnboardingState = {
  dataReady: boolean;
  dismissed: boolean;
  syncBackend: SyncBackend;
  visibleDataCount: number;
};

const listeners = new Set<() => void>();

export function shouldOpenMobileFirstRunOnboarding({
  dataReady,
  dismissed,
  syncBackend,
  visibleDataCount,
}: MobileFirstRunOnboardingState): boolean {
  return dataReady
    && !dismissed
    && visibleDataCount === 0
    && syncBackend === 'off';
}

export function dispatchMobileOnboardingEvent(): void {
  Array.from(listeners).forEach((listener) => listener());
}

export function subscribeMobileOnboardingEvent(handler: () => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export async function readMobileOnboardingDismissed(): Promise<boolean> {
  try {
    return await AsyncStorage.getItem(MOBILE_ONBOARDING_STORAGE_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export async function writeMobileOnboardingDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(MOBILE_ONBOARDING_STORAGE_KEY, 'dismissed');
  } catch {
    // Onboarding is convenience UI; storage failures should not block the app.
  }
}
