#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const mobileRoot = path.join(__dirname, '..');
const moduleRoots = [
  path.join(mobileRoot, 'node_modules', 'expo-application'),
  path.join(mobileRoot, '..', '..', 'node_modules', 'expo-application'),
];

function replaceInstallReferrerBlock(text) {
  const marker = '    AsyncFunction("getInstallReferrerAsync") { promise: Promise ->';
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('[fdroid] getInstallReferrerAsync block not found in expo-application');
  }

  const blockStart = text.lastIndexOf('\n', markerIndex) + 1;
  const braceStart = text.indexOf('{', markerIndex);
  if (braceStart === -1) {
    throw new Error('[fdroid] malformed getInstallReferrerAsync block in expo-application');
  }

  let depth = 0;
  let blockEnd = -1;
  for (let index = braceStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        blockEnd = index + 1;
        break;
      }
    }
  }

  if (blockEnd === -1) {
    throw new Error('[fdroid] could not find end of getInstallReferrerAsync block');
  }

  const replacement = [
    '    AsyncFunction("getInstallReferrerAsync") { promise: Promise ->',
    '      promise.reject(',
    '        "ERR_APPLICATION_INSTALL_REFERRER_UNAVAILABLE",',
    '        "Install referrer is unavailable in F-Droid builds.",',
    '        null',
    '      )',
    '    }',
  ].join('\n');

  return `${text.slice(0, blockStart)}${replacement}${text.slice(blockEnd)}`;
}

let patchedModuleCount = 0;

for (const moduleRoot of moduleRoots) {
  const buildGradlePath = path.join(moduleRoot, 'android', 'build.gradle');
  const applicationModulePath = path.join(
    moduleRoot,
    'android',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'application',
    'ApplicationModule.kt',
  );

  if (!fs.existsSync(buildGradlePath) || !fs.existsSync(applicationModulePath)) {
    continue;
  }

  let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
  const originalBuildGradle = buildGradle;
  buildGradle = buildGradle.replace(
    /^\s*implementation ['"]com\.android\.installreferrer:installreferrer:[^'"]+['"]\s*\n/m,
    '',
  );

  if (buildGradle.includes('com.android.installreferrer')) {
    throw new Error('[fdroid] installreferrer dependency still present in expo-application build.gradle');
  }
  if (buildGradle !== originalBuildGradle) {
    fs.writeFileSync(buildGradlePath, buildGradle);
  }

  let applicationModule = fs.readFileSync(applicationModulePath, 'utf8');
  const originalApplicationModule = applicationModule;
  applicationModule = applicationModule
    .replace(/^import android\.os\.RemoteException\n/m, '')
    .replace(/^import com\.android\.installreferrer\.api\.InstallReferrerClient\n/m, '')
    .replace(/^import com\.android\.installreferrer\.api\.InstallReferrerStateListener\n/m, '');

  if (applicationModule.includes('InstallReferrerClient')) {
    applicationModule = replaceInstallReferrerBlock(applicationModule);
  }

  if (applicationModule.includes('com.android.installreferrer') || applicationModule.includes('InstallReferrerClient')) {
    throw new Error('[fdroid] install referrer references still present in expo-application sources');
  }
  if (applicationModule !== originalApplicationModule) {
    fs.writeFileSync(applicationModulePath, applicationModule);
  }

  patchedModuleCount += 1;
}

if (patchedModuleCount === 0) {
  throw new Error('[fdroid] expo-application Android sources not found; run npm ci first');
}

console.log('[fdroid] patched expo-application to remove Play Install Referrer');
