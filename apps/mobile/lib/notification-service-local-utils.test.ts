import { describe, expect, it } from 'vitest';

import { getDuplicateAlarmRetryFireAt } from './notification-service-local-utils';

describe('getDuplicateAlarmRetryFireAt', () => {
  it('keeps the first attempt at the original time', () => {
    const baseFireAt = new Date('2026-03-06T23:38:00.000Z');

    expect(getDuplicateAlarmRetryFireAt(baseFireAt, 0).toISOString()).toBe('2026-03-06T23:38:00.000Z');
  });

  it('moves duplicate retries to later minutes instead of later seconds', () => {
    const baseFireAt = new Date('2026-03-06T23:38:00.000Z');

    expect(getDuplicateAlarmRetryFireAt(baseFireAt, 1).toISOString()).toBe('2026-03-06T23:39:00.000Z');
    expect(getDuplicateAlarmRetryFireAt(baseFireAt, 2).toISOString()).toBe('2026-03-06T23:40:00.000Z');
  });

  it('preserves the original seconds while shifting to the next minute bucket', () => {
    const baseFireAt = new Date('2026-03-06T23:38:27.000Z');

    expect(getDuplicateAlarmRetryFireAt(baseFireAt, 1).toISOString()).toBe('2026-03-06T23:39:27.000Z');
  });
});
