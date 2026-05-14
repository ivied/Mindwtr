import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile index startup order', () => {
  it('loads Expo Metro runtime before background task modules', () => {
    const source = readFileSync(resolve(process.cwd(), 'index.js'), 'utf8');
    const metroRuntimeIndex = source.indexOf("require('@expo/metro-runtime')");
    const backgroundTaskIndex = source.indexOf("require('./lib/background-sync-task')");

    expect(metroRuntimeIndex).toBeGreaterThanOrEqual(0);
    expect(backgroundTaskIndex).toBeGreaterThanOrEqual(0);
    expect(metroRuntimeIndex).toBeLessThan(backgroundTaskIndex);
  });
});
