#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

const parseInteger = (label, raw, { allowEmpty = false, min = 1 } = {}) => {
  const value = String(raw ?? '').trim();
  if (!value) {
    if (allowEmpty) return null;
    throw new Error(`Missing ${label}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const appJsonPath = path.resolve(process.env.APP_JSON_PATH || 'apps/mobile/app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const localCode = parseInteger('expo.android.versionCode in apps/mobile/app.json', appJson.expo?.android?.versionCode);
const requestedCode = parseInteger('requested Android versionCode', process.env.REQUESTED_VERSION_CODE, { allowEmpty: true });
const remoteMaxCode = parseInteger('remote Android versionCode maximum', process.env.REMOTE_MAX_VERSION_CODE || '0', { min: 0 });
const allowUntracked = truthy(process.env.ALLOW_UNTRACKED_VERSION_CODE);
const writeAppJson = truthy(process.env.WRITE_APP_JSON);
const autoBumpAppJson = truthy(process.env.AUTO_BUMP_APP_JSON_VERSION_CODE);

let resolvedCode = requestedCode ?? localCode;

if (requestedCode !== null && !allowUntracked && requestedCode !== localCode) {
  throw new Error(
    `Stable Android release builds must use the git-tracked versionCode from apps/mobile/app.json. `
    + `Requested ${requestedCode}, but app.json has ${localCode}. Bump apps/mobile/app.json before tagging instead of overriding versionCode in CI.`
  );
}

if (requestedCode === null && remoteMaxCode >= localCode) {
  if (writeAppJson && autoBumpAppJson) {
    resolvedCode = remoteMaxCode + 1;
    console.log(
      `Google Play already has versionCode ${remoteMaxCode}; bumping app.json to tracked versionCode ${resolvedCode}.`
    );
  } else if (!allowUntracked) {
    throw new Error(
      `Google Play already has Android versionCode ${remoteMaxCode}, but apps/mobile/app.json has ${localCode}. `
      + `Stable release artifacts must be reproducible from the tag, so bump apps/mobile/app.json above ${remoteMaxCode} before tagging. `
      + `Release prep can do this with ANDROID_REMOTE_MAX_VERSION_CODE=${remoteMaxCode} ./scripts/bump-version.sh <version>.`
    );
  } else {
    resolvedCode = remoteMaxCode + 1;
    console.log(`Google Play already has versionCode ${remoteMaxCode}; using generated versionCode ${resolvedCode} for this non-stable build.`);
  }
} else if (requestedCode === null) {
  console.log(`versionCode ok: local ${localCode} > store ${remoteMaxCode}`);
}

if (writeAppJson) {
  appJson.expo = appJson.expo || {};
  appJson.expo.android = appJson.expo.android || {};
  const previousCode = appJson.expo.android.versionCode;
  if (previousCode !== resolvedCode) {
    appJson.expo.android.versionCode = resolvedCode;
    fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
    console.log(`Android versionCode: ${previousCode} -> ${resolvedCode}`);
  } else {
    console.log(`Android versionCode already matches app.json: ${resolvedCode}`);
  }
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(output, `local_code=${localCode}\n`);
  fs.appendFileSync(output, `remote_max_code=${remoteMaxCode}\n`);
  fs.appendFileSync(output, `resolved_code=${resolvedCode}\n`);
}

console.log(`Resolved Android versionCode ${resolvedCode} (local ${localCode}, remote max ${remoteMaxCode}, untracked allowed: ${allowUntracked ? 'yes' : 'no'}).`);
