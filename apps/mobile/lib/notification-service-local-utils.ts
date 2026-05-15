const DUPLICATE_ALARM_RETRY_INTERVAL_MS = 60_000;

export function getDuplicateAlarmRetryFireAt(baseFireAt: Date, retry: number): Date {
  const normalizedRetry = Math.max(0, Math.floor(retry));
  return new Date(baseFireAt.getTime() + normalizedRetry * DUPLICATE_ALARM_RETRY_INTERVAL_MS);
}
