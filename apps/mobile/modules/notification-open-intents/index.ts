import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  kind?: string;
};

type NotificationOpenIntentsModule = {
  consumePendingOpenPayload(): Record<string, string> | null;
};

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NotificationOpenIntentsModule>('NotificationOpenIntents')
  : null;

export async function consumePendingNotificationOpenPayload(): Promise<NotificationOpenPayload | null> {
  const payload = nativeModule?.consumePendingOpenPayload?.();
  if (!payload) return null;
  return {
    notificationId: payload.alarmKey || payload.id,
    actionIdentifier: 'open',
    taskId: payload.taskId,
    projectId: payload.projectId,
    kind: payload.kind,
  };
}
