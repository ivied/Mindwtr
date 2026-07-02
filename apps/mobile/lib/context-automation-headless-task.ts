import { AppRegistry, Platform } from 'react-native';

import {
  parseContextAutomationUrl,
  type ContextAutomationAction,
  type ContextAutomationPayload,
} from './context-automation';

export const CONTEXT_AUTOMATION_HEADLESS_TASK_NAME = 'MindwtrContextAutomation';

type ContextAutomationHeadlessTaskData = {
  action?: unknown;
  context?: unknown;
  url?: unknown;
};

const normalizeAction = (value: unknown): ContextAutomationAction | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'activate' || normalized === 'active' || normalized === 'on') return 'activate';
  if (normalized === 'deactivate' || normalized === 'inactive' || normalized === 'off') return 'deactivate';
  return null;
};

const normalizeText = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
};

export const parseContextAutomationHeadlessTaskData = (
  data: ContextAutomationHeadlessTaskData | null | undefined
): ContextAutomationPayload | null => {
  if (!data) return null;

  const url = normalizeText(data.url);
  if (url) {
    const payload = parseContextAutomationUrl(url);
    if (payload) return payload;
  }

  const action = normalizeAction(data.action);
  const context = normalizeText(data.context);
  if (!action || !context) return null;

  return { action, context };
};

export async function runContextAutomationHeadlessTask(data: ContextAutomationHeadlessTaskData): Promise<void> {
  if (Platform.OS !== 'android') return;

  const payload = parseContextAutomationHeadlessTaskData(data);
  if (!payload) return;

  const [
    { setStorageAdapter, useTaskStore },
    {
      defaultContextAutomationText,
      handleContextAutomationPayload,
      wasContextAutomationRecentlyHandled,
    },
    { mobileStorage },
  ] = await Promise.all([
    import('@mindwtr/core'),
    import('./context-automation-handler'),
    import('./storage-adapter'),
  ]);

  if (wasContextAutomationRecentlyHandled(payload)) return;

  setStorageAdapter(mobileStorage);
  await useTaskStore.getState().fetchData({ silent: true });
  await handleContextAutomationPayload(payload, defaultContextAutomationText);
}

AppRegistry.registerHeadlessTask(CONTEXT_AUTOMATION_HEADLESS_TASK_NAME, () => runContextAutomationHeadlessTask);
