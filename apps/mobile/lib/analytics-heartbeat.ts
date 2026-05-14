import { Platform } from 'react-native';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  generateUUID,
  resetHeartbeatOptOutMarker,
  sendDailyHeartbeat,
  sendHeartbeatOptOut,
  type AppSettings,
} from '@mindwtr/core';

const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';

type PlatformExtras = typeof Platform & {
  isPad?: boolean;
  constants?: {
    Release?: string;
  };
};

const platformExtras = Platform as PlatformExtras;

export type MobileAnalyticsHeartbeatConfig = {
  analyticsHeartbeatUrl: string;
  appVersion: string;
  isExpoGo: boolean;
  isFossBuild: boolean;
};

export function isMobileAnalyticsHeartbeatConfigured({
  analyticsHeartbeatUrl,
  isExpoGo,
  isFossBuild,
}: Pick<MobileAnalyticsHeartbeatConfig, 'analyticsHeartbeatUrl' | 'isExpoGo' | 'isFossBuild'>): boolean {
  return !isFossBuild && !isExpoGo && Boolean(analyticsHeartbeatUrl.trim());
}

function canSendMobileAnalyticsHeartbeat(config: MobileAnalyticsHeartbeatConfig): boolean {
  return isMobileAnalyticsHeartbeatConfigured(config) && !__DEV__;
}

async function getMobileAnalyticsChannel(isFossBuild: boolean): Promise<string> {
  if (Platform.OS === 'ios') return 'app-store';
  if (Platform.OS !== 'android') return Platform.OS || 'mobile';
  if (isFossBuild) return 'android-sideload';
  try {
    const referrer = await Application.getInstallReferrerAsync();
    return (referrer || '').trim() ? 'play-store' : 'android-sideload';
  } catch {
    return 'android-unknown';
  }
}

async function getOrCreateAnalyticsDistinctId(): Promise<string> {
  const existing = (await AsyncStorage.getItem(ANALYTICS_DISTINCT_ID_KEY) || '').trim();
  if (existing) return existing;
  const generated = generateUUID();
  await AsyncStorage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
  return generated;
}

function getMobileDeviceClass(): string {
  if (Platform.OS === 'ios') return platformExtras.isPad === true ? 'tablet' : 'phone';
  if (Platform.OS === 'android') return 'phone';
  return 'desktop';
}

function getMobileOsMajor(): string {
  if (Platform.OS === 'ios') {
    const raw = String(Platform.Version ?? '');
    const major = raw.match(/\d+/)?.[0];
    return major ? `ios-${major}` : 'ios';
  }
  if (Platform.OS === 'android') {
    const raw = String(platformExtras.constants?.Release ?? Platform.Version ?? '');
    const major = raw.match(/\d+/)?.[0];
    return major ? `android-${major}` : 'android';
  }
  return Platform.OS || 'mobile';
}

export function getDeviceLocale(): string {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
}

export async function getMobileStartupAnalyticsContext(isFossBuild: boolean) {
  return {
    channel: await getMobileAnalyticsChannel(isFossBuild).catch(() => Platform.OS || 'mobile'),
    deviceClass: getMobileDeviceClass(),
    locale: getDeviceLocale(),
    osMajor: getMobileOsMajor(),
    platform: Platform.OS,
  };
}

async function buildMobileHeartbeatOptions(config: MobileAnalyticsHeartbeatConfig) {
  const [distinctId, channel] = await Promise.all([
    getOrCreateAnalyticsDistinctId(),
    getMobileAnalyticsChannel(config.isFossBuild),
  ]);
  return {
    enabled: true,
    endpointUrl: config.analyticsHeartbeatUrl,
    distinctId,
    platform: Platform.OS,
    channel,
    appVersion: config.appVersion,
    deviceClass: getMobileDeviceClass(),
    osMajor: getMobileOsMajor(),
    locale: getDeviceLocale(),
    storage: AsyncStorage,
    fetcher: fetch,
  };
}

export async function sendMobileAnalyticsOptOut(config: MobileAnalyticsHeartbeatConfig): Promise<boolean> {
  if (!canSendMobileAnalyticsHeartbeat(config)) return false;
  return sendHeartbeatOptOut(await buildMobileHeartbeatOptions(config));
}

export async function resetMobileAnalyticsOptOutMarker(): Promise<void> {
  await resetHeartbeatOptOutMarker(AsyncStorage);
}

export async function sendMobileDailyHeartbeat(
  config: MobileAnalyticsHeartbeatConfig,
  settings: AppSettings
): Promise<boolean> {
  if (!canSendMobileAnalyticsHeartbeat(config)) return false;
  const options = await buildMobileHeartbeatOptions(config);
  if (settings.analytics?.heartbeatEnabled === false) {
    return sendHeartbeatOptOut(options);
  }
  return sendDailyHeartbeat(options);
}
