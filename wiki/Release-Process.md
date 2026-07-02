# Release Process

This page documents the normal Mindwtr release flow at a practical level. It is intended for maintainers working from the repository.

---

## Source Files

Release automation and version metadata are centered in:

- `scripts/bump-version.sh`
- `scripts/update-versions.js`
- `docs/release-notes/`
- `docs/release-notes/google-play/`
- `metadata/`
- `metadata/metadata.json`
- `apps/desktop/src-tauri/linux/Mindwtr.metainfo.xml`
- `https://github.com/dongdongbh/mindwtr-web/tree/main/docs` for public docs changes
- `wiki/` only for legacy GitHub Wiki pages that still need mirroring
- `.github/workflows/`
- `.github/workflows/release-rc.yml` for release-candidate automation

---

## RC Train for Bi-Weekly Releases

Use a release-candidate train for normal bi-weekly minor releases. This is not a general beta program. An RC is the build intended to become stable unless testers find a blocker.

Use SemVer prerelease names:

- first candidate: `v1.1.0-rc.1`
- follow-up blocker fix: `v1.1.0-rc.2`
- final stable release: `v1.1.0`

Do not replace artifacts on an existing tag. If the released artifact is wrong, fix forward with a new tag.

The RC tag carries the prerelease suffix, but app and package version files stay on the stable base version (`X.Y.Z`). Do not run `./scripts/bump-version.sh X.Y.Z-rc.1`. Run it with `X.Y.Z`, commit the base version, then tag `vX.Y.Z-rc.1`. This keeps Apple bundle versions numeric and lets Android rely on `versionCode` for ordering. The RC workflow validates this before building.

### When to Use the RC Train

Use the full RC train for:

- scheduled bi-weekly minor releases
- releases with cross-platform changes
- releases that touch sync, storage, capture, packaging, entitlements, updater metadata, or store metadata
- releases where multiple distribution artifacts changed

The maintainer may skip the RC train for trivial patch releases, such as a narrow one-line fix, documentation-only correction, or metadata-only update that does not affect installed app behavior. Skipping the train should be explicit in the release notes or release checklist.

### RC Channel Matrix

Publish RC builds only to channels that can support testers without creating high maintenance overhead.

| Platform | RC channel | Stable behavior |
| --- | --- | --- |
| All direct downloads | GitHub prerelease | Final GitHub release becomes the stable download source. |
| iOS | TestFlight | App Store remains the stable channel. |
| macOS App Store build | TestFlight | Mac App Store remains the stable channel. |
| Android Play build | Google Play internal testing by default; closed/open/custom track when configured | Production receives a later stable upload, and the internal test track is refreshed by the stable workflow. |
| Linux Flatpak | Flathub beta branch | Future automation: publish stable to both stable and beta branches so beta users are not stranded. |
| Arch Linux | `mindwtr-bin-beta` AUR package | Future automation: update the beta package to the final stable version when no newer RC exists. |
| Windows direct download | GitHub prerelease installer/portable | Microsoft Store remains stable-only unless package flights are later automated. |

Keep these stable-only unless there is a clear need and automation is already in place:

- F-Droid
- IzzyOnDroid
- Microsoft Store package flights
- winget
- Homebrew stable cask
- Chocolatey
- Scoop stable bucket
- APT/RPM repos

APT/RPM beta repos and Microsoft Store package flights are valid future additions, but they should not be part of the first RC process. Add them only after the manual RC train has proven useful and repeatable.

### Current RC Automation

The first automated RC workflow is `.github/workflows/release-rc.yml`.

It runs on `v*-rc.*` tags and can also be started manually with an RC tag. It reuses the same channel build jobs as stable where practical, then creates a GitHub prerelease from the exact Linux, macOS, Windows, Android, and Android FOSS artifacts.

It also publishes tester builds to the store-backed channels that are already wired:

- Android AAB to Google Play `internal` by default; manual runs can choose another Play track or `none`.
- iOS App Store build to TestFlight with App Store review submission disabled.
- macOS App Store build to TestFlight with App Store review submission disabled.
- Flathub beta by opening a PR against the Flathub repository's `beta` branch. The first run requires that branch to exist in `flathub/tech.dongdongbh.mindwtr`.
- AUR beta by updating the binary-only `mindwtr-bin-beta` package after the GitHub prerelease assets exist. Source-building AUR packages stay stable-only for RCs.

The stable `release.yml` remains the stable-release workflow. It is guarded so prerelease tags do not publish stable-only channels such as production Google Play, Microsoft Store, Snap stable, Linux APT/RPM repos, Flathub stable, AUR stable, Scoop, winget, Homebrew, or Chocolatey.

Because a Play testing upload consumes an Android `versionCode`, every RC that uploads to Play needs a fresh `versionCode`. The current final stable flow should also use a fresh production upload with a higher `versionCode`, or a future stable-promotion workflow should promote the already-tested Play build. Do not tag a final stable release with an Android `versionCode` that has already been uploaded to Play unless the stable workflow has been taught to promote that existing build.


### Timeline

The review-latency channels need a head start. Use this default schedule:

| Day | Action |
| --- | --- |
| T-7 to T-5 | Feature freeze. Only bug fixes, release notes, metadata, and release blockers are allowed. |
| T-5 | Create the release branch, bump app/package versions to `X.Y.Z`, generate release notes, tag `vX.Y.Z-rc.1`, and let `release-rc.yml` upload TestFlight and Google Play testing builds. |
| T-4 | Run channel artifact smoke checks as reviewed builds become available. Fix only blockers. |
| T-3 | Confirm the GitHub prerelease from `release-rc.yml`, confirm the Flathub beta PR and `mindwtr-bin-beta` AUR update succeeded, and announce the RC to testers. |
| T-2 to T-1 | Triage feedback. Cut `rc.2` only for blockers. Non-blockers move to the next cycle. |
| Release day | Tag `vX.Y.Z`, publish stable everywhere, and also update any persistent test channels that exist to the stable version. |
| T+1 to T+2 | Watch crashes, GitHub issues, Discord, store feedback, and downstream package reports. Patch with the next patch tag, such as `v1.1.1` after `v1.1.0`, if needed. |

### Blocker Bar for rc.2

Cut another RC only for one of these blockers:

- launch crash
- data loss or data corruption
- sync corruption or repeatable sync failure
- install, update, signing, entitlement, or packaging failure
- broken capture, task creation, task editing, or task completion
- broken migration from the previous stable release
- severe platform-specific regression on a supported channel

Everything else waits for the next scheduled release or a later patch. This keeps the bi-weekly train from turning into an open-ended beta loop.

### Required RC Smoke Gates

Every distribution channel is a different runtime. The RC is not ready until the artifact from each RC channel has been smoke-launched in a channel-faithful environment as far as CI or local testing allows.

Minimum smoke checks:

- launch the exact artifact that users receive
- create, edit, complete, and delete a task
- verify capture or quick-add opens and saves
- verify the app can read existing data from the previous stable release
- verify sync settings open without crashing
- verify updater, store, or sandbox-specific startup behavior where applicable
- verify logs do not show fatal startup errors

For channels with prior failure history, keep channel-specific gates:

- FOSS APK and Play APK/AAB are separate dependency sets
- Flatpak must launch inside the Flatpak runtime
- AUR packages must build in a clean Arch container before publishing
- MSIX/Microsoft Store packages must not hard-fail on tray, shortcut, or sandbox-limited capabilities
- App Store and TestFlight builds must preserve required entitlements

### Tester Announcement

The RC announcement should be short and actionable:

- version and channel links
- top user-visible changes
- known risks or areas needing testing
- exact feedback path: GitHub issue, Discord channel, or email
- reminder that this is a release candidate, not a feature preview

---

## Stable Release Flow

1. Make sure `main` is in the intended release state and commit any pre-release work first.
   - If the previous version is already released, put follow-up fixes under `docs/release-notes/unreleased.md` and link it from `CHANGELOG.md` until the next patch version is prepared, for example `v0.9.1` after `v0.9.0`.
2. Bump the version with:

```bash
./scripts/bump-version.sh 0.x.y
```

This updates workspace package versions and bumps the Android `versionCode`.

3. Run the release hard gates before tagging:
   - Type/test gate:
     - `bun run test`
     - `bun run typecheck`
     - `bun run native:test`
   - FOSS/static gate:
     - inspect `git diff vPREV..HEAD -- apps/mobile/package.json`
     - inspect F-Droid/FOSS config files (`apps/mobile/plugins/android-manifest-fixes.js`, `apps/mobile/scripts/`, `.github/workflows/release-android-foss.yml`, `config/izzyonandroid.yml`)
     - run `python3 scripts/ci/repair-package-lock.py --check apps/desktop/package-lock.json`
   - CloudKit schema gate:
     - inspect synced schema files against the previous tag
     - if a new CloudKit-backed field or record type was added, update/deploy the production schema before release
4. Prepare or update release notes and metadata:
   - `docs/release-notes/<version>.md`
   - `docs/release-notes/google-play/<version>.txt`
   - `metadata/*/release_notes.txt`
   - `metadata/*/changelogs/<androidVersionCode>.txt`
   - `metadata/metadata.json`
   - `apps/desktop/src-tauri/linux/Mindwtr.metainfo.xml`
5. Update public docs in the [Mindwtr web docs source](https://github.com/dongdongbh/mindwtr-web/tree/main/docs) when release/docs process details changed. Update `wiki/` only for legacy GitHub Wiki pages that still need mirroring. Do not run git in a separate `.wiki` checkout.
6. Review the resulting version and metadata changes carefully.
7. Commit the release prep:

```bash
git add -A
git commit -m "chore(release): v0.x.y"
```

8. Tag the release:

```bash
git tag v0.x.y
```

9. Push `main` and the tag:

```bash
git push origin main --tags
```

10. Let GitHub Actions publish the platform artifacts and any downstream packaging jobs.

---

## Before Tagging

At minimum, verify:

- release notes exist and match the actual changes
- package versions are aligned across the monorepo
- Android `versionCode` was incremented
- desktop package lock passes `repair-package-lock.py --check`
- FOSS config still strips blocked permissions and keeps only intentional ones
- CloudKit-backed schema did not change, or the production schema was updated first
- store/release metadata changes are intentional and scoped per platform
- mobile store categories in the consoles are still correct: Google Play `Productivity > Task Management` and App Store primary category `Productivity`
- Google Play locale bodies fit the 500-character API limit

For larger releases, also verify:

- desktop updater metadata
- mobile store metadata / Fastlane inputs
- docs-site changes for user-visible features in the [Mindwtr web docs source](https://github.com/dongdongbh/mindwtr-web/tree/main/docs)
- cross-backend sync smoke with a small seed dataset: add, update, delete, and attachment transfer should converge across Cloud, WebDAV/file sync, and any platform-native backend available to the release tester; a second sync should report no new conflicts

---

## Release Notes

Versioned release notes live in `docs/release-notes/`.

Guidelines:

- keep the top summary user-facing
- include the important fixes/features first
- list notable commits when helpful
- keep Google Play snippets in `docs/release-notes/google-play/` aligned when needed
- update `metadata/*/release_notes.txt` for App Store release notes
- add the new Android changelog file under `metadata/*/changelogs/<versionCode>.txt`
- keep Microsoft Store release notes in `metadata/metadata.json` aligned with the same release
- add or refresh the top AppStream entry in `apps/desktop/src-tauri/linux/Mindwtr.metainfo.xml`

---

## Post-Release Checks

After the tag is pushed:

- verify GitHub release creation
- verify expected desktop/mobile artifacts are attached
- verify store-specific workflows succeeded when applicable
- spot-check the updater/download surfaces against the new version
- verify stable was also published to persistent test channels that exist, so testers remain on the newest build

---

## Rollback Mindset

If a bad release is detected:

- stop follow-up tagging until the failure mode is understood
- prefer a fast forward fix release over rewriting published history
- keep release notes explicit about the corrective patch

---

## Related

- [[Developer Guide]]
- [[Docker Deployment]]
- [[Cloud Deployment]]
- [Repository release notes](https://github.com/dongdongbh/Mindwtr/tree/main/docs/release-notes)
- [Semantic Versioning](https://semver.org/)
- [GitHub prereleases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Google Play testing tracks](https://support.google.com/googleplay/android-developer/answer/9845334)
- [Apple TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [Flathub beta repository](https://docs.flathub.org/docs/for-app-authors/maintenance)
- [Microsoft Store package flights](https://learn.microsoft.com/en-us/windows/apps/publish/package-flights)
