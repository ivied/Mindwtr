#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(
  repoRoot,
  'apps/mobile/ios-app-intents/MindwtrSiriCaptureIntents.swift'
);
const source = fs.readFileSync(sourcePath, 'utf8');

const supportedModesMatches = source.match(/static\s+var\s+supportedModes\s*:\s*IntentModes/g) || [];
if (supportedModesMatches.length === 0) {
  console.error('Expected at least one AppIntent supportedModes declaration.');
  process.exit(1);
}

const guardedSupportedModesMatches = source.match(
  /#if compiler\(>=6\.0\)\s*\n\s*@available\(iOS 26\.0, \*\)\s*\n\s*static\s+var\s+supportedModes\s*:\s*IntentModes\s*\{/g
) || [];

if (guardedSupportedModesMatches.length !== supportedModesMatches.length) {
  console.error(
    `Every AppIntent supportedModes declaration must be guarded; found ${guardedSupportedModesMatches.length} guarded of ${supportedModesMatches.length}.`
  );
  console.error('IntentModes is iOS 26-only and the release archive targets older iOS versions.');
  process.exit(1);
}

const appShortcutPhrases = source.match(/phrases:\s*\[[\s\S]*?\]/g) || [];
if (appShortcutPhrases.length === 0) {
  console.error('Expected Mindwtr AppShortcut phrases.');
  process.exit(1);
}

const parameterWrappedValueDefaults = source.match(
  /@Parameter\([^)]*\)\s*\n\s*var\s+\w+\s*:[^\n=]+=[^\n]+/g
) || [];
if (parameterWrappedValueDefaults.length > 0) {
  console.error(
    'AppIntent @Parameter defaults must use the default: argument instead of a wrapped property assignment.'
  );
  console.error(
    'Xcode 26 AppIntents rejects wrappedValue defaults for these parameters:'
  );
  console.error(parameterWrappedValueDefaults.join('\n---\n'));
  process.exit(1);
}

const stringParameterInterpolation = /\\\(\\\.\$(task|note|tags|project)\)/;
if (appShortcutPhrases.some((phraseBlock) => stringParameterInterpolation.test(phraseBlock))) {
  console.error(
    'Mindwtr AppShortcut phrases must not interpolate String parameters.'
  );
  console.error(
    'The iOS 26 AppIntents metadata processor only accepts AppEntity/AppEnum values in shortcut phrases.'
  );
  process.exit(1);
}

console.log('iOS App Intents availability guard is valid.');
