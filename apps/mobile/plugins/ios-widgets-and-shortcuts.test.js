import { describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');
const plugin = require('./ios-widgets-and-shortcuts');

const {
  APP_INTENTS_FOLDER,
  SIRI_CAPTURE_SHORTCUTS_PROVIDER,
  addSiriShortcutsRegistrationToAppDelegate,
  collectSwiftFiles,
  ensureSourceFileInTarget,
} = plugin.__testables;

describe('ios-widgets-and-shortcuts', () => {
  it('ships an App Intents source for Siri Inbox capture', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(collectSwiftFiles(sourceDir)).toContain('MindwtrSiriCaptureIntents.swift');
    expect(source).toContain('struct MindwtrSiriCaptureIntent: AppIntent');
    expect(source).toContain('struct MindwtrSiriCaptureShortcuts: AppShortcutsProvider');
    expect(source).toContain('"Capture \\(\\.$task) in \\(.applicationName)"');
    expect(source).toContain('mindwtr');
    expect(source).toContain('/capture');
    expect(source).toContain('.foreground(.immediate)');
  });

  it('registers App Shortcuts from AppDelegate idempotently', () => {
    const appDelegate = `public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

    const patched = addSiriShortcutsRegistrationToAppDelegate(appDelegate);

    expect(patched).toContain('if #available(iOS 16.0, *)');
    expect(patched).toContain(`${SIRI_CAPTURE_SHORTCUTS_PROVIDER}.updateAppShortcutParameters()`);
    expect(addSiriShortcutsRegistrationToAppDelegate(patched)).toBe(patched);
  });

  it('adds App Intents Swift files to the main target once', () => {
    const calls = [];
    const xcodeProject = {
      hasFile: (filePath) => filePath === 'Mindwtr/Existing.swift',
      addSourceFile: (...args) => calls.push(args),
    };

    expect(ensureSourceFileInTarget(xcodeProject, {
      filePath: 'Mindwtr/MindwtrSiriCaptureIntents.swift',
      groupKey: 'MAIN_GROUP',
      targetUuid: 'MAIN_TARGET',
    })).toBe(true);
    expect(ensureSourceFileInTarget(xcodeProject, {
      filePath: 'Mindwtr/Existing.swift',
      groupKey: 'MAIN_GROUP',
      targetUuid: 'MAIN_TARGET',
    })).toBe(false);

    expect(calls).toEqual([
      [
        'Mindwtr/MindwtrSiriCaptureIntents.swift',
        { target: 'MAIN_TARGET' },
        'MAIN_GROUP',
      ],
    ]);
  });
});
