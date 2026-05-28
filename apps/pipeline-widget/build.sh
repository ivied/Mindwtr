#!/usr/bin/env bash
# Regenerate the Xcode project from project.yml and build a release.app.
#
# Usage:
#   ./build.sh              # full pipeline: generate → build → copy app
#   ./build.sh gen          # only regenerate .xcodeproj
#
# Output: ./build/Release/GTDPipelineStatus.app
# Install: open ./build/Release/GTDPipelineStatus.app (run once, then add
#          the widget from Notification Center → Edit Widgets).
set -euo pipefail
cd "$(dirname "$0")"

echo "🛠  xcodegen generate"
xcodegen generate

if [[ "${1:-}" == "gen" ]]; then
  echo "✅ project regenerated: GTDPipelineStatus.xcodeproj"
  exit 0
fi

echo "🔨 xcodebuild -scheme GTDPipelineStatus -configuration Release"
xcodebuild \
  -project GTDPipelineStatus.xcodeproj \
  -scheme GTDPipelineStatus \
  -configuration Release \
  -derivedDataPath ./build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES \
  build | grep -E "(error:|warning:|\*\*|Build succeeded)" || true

APP="./build/Build/Products/Release/GTDPipelineStatus.app"
if [[ ! -d "$APP" ]]; then
  echo "❌ build failed — app not found at $APP"
  exit 1
fi

mkdir -p ./build/Release
rsync -a --delete "$APP" ./build/Release/

OUT="./build/Release/GTDPipelineStatus.app"

# Re-sign explicitly with entitlements so WidgetKit accepts the extension.
# Xcode's ad-hoc signing for app-extension targets is sometimes only linker-
# signed, which leaves "Info.plist=not bound" and pluginkit refuses to index.
echo "🔐 re-signing widget extension"
codesign --force --sign - --entitlements Widget/Widget.entitlements \
  "$OUT/Contents/PlugIns/GTDPipelineStatusWidget.appex"

echo "🔐 re-signing host app"
codesign --force --sign - --entitlements App/App.entitlements --deep "$OUT"

echo "🔎 verify"
codesign --verify --deep --strict --verbose=2 "$OUT" 2>&1 | sed 's/^/   /'

# Tell LaunchServices about the new bundle so the widget gallery picks it up.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$LSREG" ]] && "$LSREG" -f "$OUT" || true


# Build the standalone widget-reload helper (used by capture-agent for
# near-real-time refreshes; without this WidgetKit only updates every 15-30
# minutes on its own schedule).
echo "🛠  swiftc Helper/gtd-widget-reload.swift"
swiftc -O -o ./build/Release/gtd-widget-reload Helper/gtd-widget-reload.swift
codesign --force --sign - ./build/Release/gtd-widget-reload 2>&1 | sed 's/^/   /'

echo "✅ $OUT"
echo "✅ ./build/Release/gtd-widget-reload"
echo "👉 open $OUT  # then add the widget from Edit Widgets"
