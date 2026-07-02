import { useTaskStore } from '@mindwtr/core';

import {
  buildContextAutomationNotificationCopy,
  CONTEXT_AUTOMATION_NOTIFICATION_KIND,
  selectContextNextActions,
  type ContextAutomationPayload,
} from './context-automation';
import { sendMobileImmediateNotification } from './notification-service';

export type ResolveContextAutomationText = (key: string, fallback: string) => string;

const RECENT_CONTEXT_AUTOMATION_TTL_MS = 10_000;
const recentlyHandledContextAutomation = new Map<string, number>();

export const defaultContextAutomationText: ResolveContextAutomationText = (_key, fallback) => fallback;

export function __resetContextAutomationDedupeForTests(): void {
  recentlyHandledContextAutomation.clear();
}

export function wasContextAutomationRecentlyHandled(payload: ContextAutomationPayload, nowMs = Date.now()): boolean {
  for (const [handledKey, handledAtMs] of recentlyHandledContextAutomation.entries()) {
    if (nowMs - handledAtMs > RECENT_CONTEXT_AUTOMATION_TTL_MS) {
      recentlyHandledContextAutomation.delete(handledKey);
    }
  }

  const key = `${payload.action}:${payload.context}`;
  const previousHandledAtMs = recentlyHandledContextAutomation.get(key);
  if (previousHandledAtMs !== undefined && nowMs - previousHandledAtMs <= RECENT_CONTEXT_AUTOMATION_TTL_MS) {
    return true;
  }

  recentlyHandledContextAutomation.set(key, nowMs);
  return false;
}

export async function handleContextAutomationPayload(
  payload: ContextAutomationPayload,
  resolveText: ResolveContextAutomationText = defaultContextAutomationText
): Promise<void> {
  if (payload.action === 'deactivate') return;

  const state = useTaskStore.getState();
  const matchingTasks = selectContextNextActions(state.tasks ?? [], state.projects ?? [], payload.context);
  if (matchingTasks.length === 0) return;

  const copy = buildContextAutomationNotificationCopy(payload.context, matchingTasks, {
    noTasksTitle: resolveText('contextAutomation.noNextActionsTitle', 'No {{context}} next actions'),
    noTasksMessage: resolveText('contextAutomation.noNextActionsBody', 'Mindwtr did not find any /next tasks for {{context}}.'),
    oneTaskTitle: resolveText('contextAutomation.oneNextActionTitle', '{{context}} next action'),
    manyTasksTitle: resolveText('contextAutomation.manyNextActionsTitle', '{{count}} {{context}} next actions'),
    moreTasksLine: resolveText('contextAutomation.moreTasksLine', '+{{count}} more'),
  });

  await sendMobileImmediateNotification(copy.title, copy.message, {
    kind: CONTEXT_AUTOMATION_NOTIFICATION_KIND,
    context: payload.context,
  });
}
