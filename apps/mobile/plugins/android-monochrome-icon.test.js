const fs = require('fs');
const os = require('os');
const path = require('path');
import { describe, expect, it } from 'vitest';
const { buildVectorDrawableXml } = require('../scripts/generate_android_monochrome_icon');
const {
  __testables: {
    ADAPTIVE_ICON_FILES,
    MONOCHROME_REFERENCE,
    RESOURCE_DIR,
    VECTOR_DRAWABLE_NAME,
    applyAndroidMonochromeIconResources,
    patchAdaptiveIconXml,
  },
} = require('./android-monochrome-icon');

describe('android monochrome icon packaging', () => {
  it('builds a transparent vector drawable glyph', () => {
    const xml = buildVectorDrawableXml();

    expect(xml).toContain('<vector');
    expect(xml).toContain('android:width="108dp"');
    expect(xml).toContain('android:viewportWidth="1024"');
    expect(xml).toContain('android:fillColor="#FFFFFFFF"');
    expect(xml).toContain('android:fillColor="#00000000"');
    expect(xml).toContain('android:strokeColor="#FFFFFFFF"');
    expect(xml).toContain('android:strokeWidth="56.507"');
    expect(xml).toContain('android:strokeLineCap="round"');
    expect(xml).toContain('android:strokeLineJoin="round"');
    expect((xml.match(/<path/g) || []).length).toBe(2);
    expect(xml).toContain('M438.993,484.065 L505.168,549.282 L751.144,302.33');
    expect(xml).not.toContain('<background');
  });

  it('rewrites adaptive icon XML to use the vector monochrome drawable', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;

    const patched = patchAdaptiveIconXml(xml);

    expect(patched).toContain(`<monochrome android:drawable="${MONOCHROME_REFERENCE}"/>`);
    expect(patched).not.toContain('@mipmap/ic_launcher_monochrome');
    expect(patchAdaptiveIconXml(patched)).toBe(patched);
  });

  it('adds a monochrome layer if Expo has not generated one yet', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

    expect(patchAdaptiveIconXml(xml)).toContain(`<monochrome android:drawable="${MONOCHROME_REFERENCE}"/>`);
  });

  it('writes vector resources and patches both launcher XML files', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-monochrome-icon-'));

    try {
      applyAndroidMonochromeIconResources(projectRoot);

      const resDir = path.join(projectRoot, RESOURCE_DIR);
      const vectorPath = path.join(resDir, 'drawable', VECTOR_DRAWABLE_NAME);
      expect(fs.readFileSync(vectorPath, 'utf8')).toContain('<vector');

      for (const filename of ADAPTIVE_ICON_FILES) {
        const iconXml = fs.readFileSync(path.join(resDir, 'mipmap-anydpi-v26', filename), 'utf8');
        expect(iconXml).toContain(`<monochrome android:drawable="${MONOCHROME_REFERENCE}"/>`);
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
