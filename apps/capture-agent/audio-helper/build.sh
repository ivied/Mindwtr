#!/usr/bin/env bash
# Build the native macOS audio capture helper. Uses AVAudioEngine +
# VoiceProcessingIO so we get the same voice DSP stack as Zoom/FaceTime.
# Output binary is gitignored; rebuild on each fresh checkout.
#
# Ad-hoc code-signs with the audio-input entitlement so macOS treats the
# helper as a first-class voice-chat app and coordinates VPIO with other
# voice apps (Zoom etc.) instead of system-wide ducking them.

set -euo pipefail
cd "$(dirname "$0")"

OUT=gtd-audio-capture
echo "🔨 swiftc -O main.swift -o $OUT"
swiftc -O main.swift -o "$OUT"

echo "🔐 codesign --force --sign - --entitlements entitlements.plist $OUT"
codesign --force --sign - --entitlements entitlements.plist "$OUT"
codesign --display --entitlements - "$OUT" 2>&1 | sed 's/^/   /' | head -10

echo "✅ built $(pwd)/$OUT"
file "$OUT" | sed 's/^/   /'
