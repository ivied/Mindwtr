import type { ConfigContext, ExpoConfig } from 'expo/config';

const isFossBuild = process.env.FOSS_BUILD === '1' || process.env.FOSS_BUILD === 'true';
const analyticsHeartbeatUrl = (process.env.ANALYTICS_HEARTBEAT_URL ?? '').trim();
const dropboxAppKey = (process.env.DROPBOX_APP_KEY ?? '').trim();

// Local fork overrides for personal sideload builds.
// Upstream's app.json uses `tech.dongdongbh.mindwtr` — that bundle ID is
// registered to the upstream maintainer's Apple Developer account, so our
// personal Apple ID can't sign builds for it. Override here (and in `extra`
// for any code that reads the IDs at runtime) so prebuild produces Xcode/
// Gradle projects that build under our developer identity.
//
// Setting MINDWTR_FORK_PERSONAL=0 falls back to upstream identifiers (useful
// when comparing against the App Store build).
const useForkIdentifiers = process.env.MINDWTR_FORK_PERSONAL !== '0';
const FORK_BUNDLE_ID = 'uk.kurdy.gtd.mindwtr';
const FORK_APP_NAME = 'Mindwtr (GTD)';

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  const extra = {
    ...(base.extra ?? {}),
    isFossBuild,
    analyticsHeartbeatUrl: isFossBuild ? '' : analyticsHeartbeatUrl,
    dropboxAppKey,
  };

  if (!useForkIdentifiers) {
    return { ...base, extra };
  }

  const forkedExtra = { ...extra };
  if ('eas' in forkedExtra) {
    delete (forkedExtra as Record<string, unknown>).eas;
  }

  return {
    ...base,
    name: FORK_APP_NAME,
    slug: 'mindwtr-gtd',
    owner: undefined,
    ios: {
      ...base.ios,
      bundleIdentifier: FORK_BUNDLE_ID,
    },
    android: {
      ...base.android,
      package: FORK_BUNDLE_ID,
    },
    plugins: (base.plugins ?? []).map((entry) => {
      if (Array.isArray(entry) && entry[0] === 'expo-share-intent') {
        return [
          entry[0],
          {
            ...(entry[1] as Record<string, unknown>),
            iosAppGroupIdentifier: `group.${FORK_BUNDLE_ID}`,
          },
        ];
      }
      return entry;
    }),
    extra: forkedExtra,
  };
};
