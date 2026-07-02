const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withDangerousMod } = require('@expo/config-plugins');
const { buildVectorDrawableXml } = require('../scripts/generate_android_monochrome_icon');

const RESOURCE_DIR = path.join('android', 'app', 'src', 'main', 'res');
const VECTOR_DRAWABLE_NAME = 'ic_launcher_monochrome.xml';
const MONOCHROME_REFERENCE = '@drawable/ic_launcher_monochrome';
const ADAPTIVE_ICON_FILES = ['ic_launcher.xml', 'ic_launcher_round.xml'];

const defaultAdaptiveIconXml = () => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="${MONOCHROME_REFERENCE}"/>
</adaptive-icon>
`;

const patchAdaptiveIconXml = (xml) => {
  const source = xml && xml.trim().length > 0 ? xml : defaultAdaptiveIconXml();
  const monochromeTag = `<monochrome android:drawable="${MONOCHROME_REFERENCE}"/>`;

  if (source.includes('<monochrome')) {
    return source.replace(
      /<monochrome\s+android:drawable="[^"]+"\s*\/?>/,
      monochromeTag,
    );
  }

  return source.replace(/\s*<\/adaptive-icon>\s*$/u, `\n    ${monochromeTag}\n</adaptive-icon>\n`);
};

const applyAndroidMonochromeIconResources = (projectRoot) => {
  const resDir = path.join(projectRoot, RESOURCE_DIR);
  const drawableDir = path.join(resDir, 'drawable');
  const adaptiveIconDir = path.join(resDir, 'mipmap-anydpi-v26');

  fs.mkdirSync(drawableDir, { recursive: true });
  fs.mkdirSync(adaptiveIconDir, { recursive: true });

  fs.writeFileSync(
    path.join(drawableDir, VECTOR_DRAWABLE_NAME),
    buildVectorDrawableXml(),
  );

  for (const filename of ADAPTIVE_ICON_FILES) {
    const iconXmlPath = path.join(adaptiveIconDir, filename);
    const currentXml = fs.existsSync(iconXmlPath)
      ? fs.readFileSync(iconXmlPath, 'utf8')
      : defaultAdaptiveIconXml();

    fs.writeFileSync(iconXmlPath, patchAdaptiveIconXml(currentXml));
  }
};

const withAndroidMonochromeIcon = (config) => withDangerousMod(config, [
  'android',
  async (modConfig) => {
    applyAndroidMonochromeIconResources(modConfig.modRequest.projectRoot);
    return modConfig;
  },
]);

module.exports = createRunOncePlugin(
  withAndroidMonochromeIcon,
  'mindwtr-android-monochrome-icon',
  '1.0.0',
);

module.exports.__testables = {
  ADAPTIVE_ICON_FILES,
  MONOCHROME_REFERENCE,
  RESOURCE_DIR,
  VECTOR_DRAWABLE_NAME,
  applyAndroidMonochromeIconResources,
  defaultAdaptiveIconXml,
  patchAdaptiveIconXml,
};
