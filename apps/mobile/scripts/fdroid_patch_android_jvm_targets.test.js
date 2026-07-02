import { describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');

describe('fdroid_patch_android_jvm_targets', () => {
  it('covers Mindwtr local Android modules with Kotlin sources', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'fdroid_patch_android_jvm_targets.js'),
      'utf8'
    );

    expect(source).toContain('modules/notification-open-intents/android/build.gradle');
    expect(source).toContain('modules/system-bars/android/build.gradle');
    expect(source).toContain('appendJava17OverrideIfExists(relativePath)');
  });
});
