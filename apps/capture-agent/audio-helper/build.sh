#!/usr/bin/env bash
# Build the three native audio helpers via Swift Package Manager:
#   gtd-audio-capture — AVCaptureSession mic capture (no deps)
#   gtd-audio-enroll  — voice enrollment via FluidAudio (256-d embedding)
#   gtd-audio-diarize — diarization via FluidAudio (segments + user/other)
#
# All three are ad-hoc code-signed with the audio-input entitlement so
# macOS treats them as legit peer voice-chat consumers.

set -euo pipefail
cd "$(dirname "$0")"

echo "🔨 swift build --configuration release"
swift build --configuration release

BIN_DIR=".build/release"
for OUT in gtd-audio-capture gtd-audio-enroll gtd-audio-diarize; do
  SRC="$BIN_DIR/$OUT"
  if [[ ! -f "$SRC" ]]; then
    echo "⚠️  expected binary not found: $SRC"
    continue
  fi
  cp "$SRC" "./$OUT"
  echo "🔐 codesign $OUT"
  codesign --force --sign - --entitlements entitlements.plist "./$OUT" 2>&1 | sed 's/^/   /'
done

echo "✅ binaries:"
ls -lh ./gtd-audio-* 2>/dev/null | sed 's/^/   /'
