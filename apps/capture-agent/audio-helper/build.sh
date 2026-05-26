#!/usr/bin/env bash
# Build the native audio helpers via Swift Package Manager.
#
# gtd-audio-capture is wrapped into a proper macOS .app bundle
# (GTDAudioCapture.app) so macOS TCC can attribute mic permission to a
# stable bundle identifier instead of trying to track an unsigned CLI.
# This is the only way launchd-spawned helpers reliably get the mic.
#
# gtd-audio-enroll / gtd-audio-diarize stay as bare CLI binaries — they
# don't need TCC attribution (enroll is invoked from Terminal once,
# diarize only reads WAV files).

set -euo pipefail
cd "$(dirname "$0")"

echo "🔨 swift build --configuration release"
swift build --configuration release

BIN_DIR=".build/release"

# --- bare binaries (enroll, diarize) -------------------------------------
for OUT in gtd-audio-enroll gtd-audio-diarize; do
  SRC="$BIN_DIR/$OUT"
  if [[ ! -f "$SRC" ]]; then
    echo "⚠️  expected binary not found: $SRC"
    continue
  fi
  cp "$SRC" "./$OUT"
  echo "🔐 codesign $OUT"
  codesign --force --sign - --entitlements entitlements.plist "./$OUT" 2>&1 | sed 's/^/   /'
done

# --- gtd-audio-capture wrapped in GTDAudioCapture.app --------------------
BUNDLE="GTDAudioCapture.app"
SRC="$BIN_DIR/gtd-audio-capture"
if [[ ! -f "$SRC" ]]; then
  echo "⚠️  gtd-audio-capture binary not found"
  exit 1
fi

echo "📦 assembling $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp Info.plist "$BUNDLE/Contents/Info.plist"
cp "$SRC" "$BUNDLE/Contents/MacOS/gtd-audio-capture"

echo "🔐 codesign --deep $BUNDLE"
codesign --force --deep --sign - --entitlements entitlements.plist "$BUNDLE" 2>&1 | sed 's/^/   /'

# Verify
echo "🔎 codesign --verify $BUNDLE"
codesign --verify --deep --strict --verbose=2 "$BUNDLE" 2>&1 | sed 's/^/   /' || true

# Keep a top-level symlink so tooling that hasn't migrated to the bundle
# path still resolves (TCC follows the bundle anyway through the bin path).
ln -sf "$BUNDLE/Contents/MacOS/gtd-audio-capture" gtd-audio-capture

echo "✅ built:"
ls -lhd ./GTDAudioCapture.app ./gtd-audio-* 2>/dev/null | sed 's/^/   /'
echo "   bundle binary: $(pwd)/$BUNDLE/Contents/MacOS/gtd-audio-capture"
