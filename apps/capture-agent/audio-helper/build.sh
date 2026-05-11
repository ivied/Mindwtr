#!/usr/bin/env bash
# Build the native macOS audio capture helper. Uses AVAudioEngine +
# VoiceProcessingIO so we get the same voice DSP stack as Zoom/FaceTime.
# Output binary is gitignored; rebuild on each fresh checkout.

set -euo pipefail
cd "$(dirname "$0")"

OUT=gtd-audio-capture
echo "🔨 swiftc -O main.swift -o $OUT"
swiftc -O main.swift -o "$OUT"
echo "✅ built $(pwd)/$OUT"
file "$OUT" | sed 's/^/   /'
