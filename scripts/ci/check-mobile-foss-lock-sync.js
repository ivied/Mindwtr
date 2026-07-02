#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobilePackagePath = path.join(repoRoot, 'apps/mobile/package.json');
const mobileLockPath = path.join(repoRoot, 'apps/mobile/package-lock.json');

const pkg = JSON.parse(fs.readFileSync(mobilePackagePath, 'utf8'));

if (pkg.dependencies && pkg.dependencies['expo-dev-client']) {
  delete pkg.dependencies['expo-dev-client'];
}
if (pkg.devDependencies && pkg.devDependencies['expo-dev-client']) {
  delete pkg.devDependencies['expo-dev-client'];
}

if (!pkg.expo || typeof pkg.expo !== 'object' || Array.isArray(pkg.expo)) {
  pkg.expo = {};
}
if (!pkg.expo.autolinking || typeof pkg.expo.autolinking !== 'object' || Array.isArray(pkg.expo.autolinking)) {
  pkg.expo.autolinking = {};
}
const existingExclude = Array.isArray(pkg.expo.autolinking.exclude)
  ? pkg.expo.autolinking.exclude.filter((value) => typeof value === 'string')
  : [];
for (const excludedModule of ['play-store-updates', 'expo-store-review']) {
  if (!existingExclude.includes(excludedModule)) {
    existingExclude.push(excludedModule);
  }
}
pkg.expo.autolinking.exclude = existingExclude;
if (pkg.dependencies && pkg.dependencies['@mindwtr/core'] === 'workspace:*') {
  pkg.dependencies['@mindwtr/core'] = 'file:../../packages/core';
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-mobile-foss-package-'));
const tmpPackagePath = path.join(tmpDir, 'package.json');
fs.writeFileSync(tmpPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const result = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, 'scripts/ci/check-package-lock-sync.js'),
    tmpPackagePath,
    mobileLockPath,
  ],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
