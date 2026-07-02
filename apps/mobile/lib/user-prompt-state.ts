import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  recordPromptActivity,
  type UserPromptState,
} from '@mindwtr/core';

export const LOCAL_USER_PROMPT_STATE_KEY = 'mindwtr:local-user-prompts:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readLocalUserPromptState(): Promise<UserPromptState> {
  const raw = await AsyncStorage.getItem(LOCAL_USER_PROMPT_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed as UserPromptState : {};
  } catch {
    return {};
  }
}

export async function writeLocalUserPromptState(promptState: UserPromptState): Promise<void> {
  await AsyncStorage.setItem(LOCAL_USER_PROMPT_STATE_KEY, JSON.stringify(promptState));
}

export async function updateLocalUserPromptState(
  updater: (promptState: UserPromptState) => UserPromptState,
): Promise<UserPromptState> {
  const current = await readLocalUserPromptState();
  const next = updater(current);
  await writeLocalUserPromptState(next);
  return next;
}

export async function recordLocalPromptActivity(nowMs = Date.now()): Promise<UserPromptState> {
  return updateLocalUserPromptState((promptState) => recordPromptActivity(promptState, nowMs));
}
