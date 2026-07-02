#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export FOSS_BUILD=1
export FDROID_EXPO_BUILD_FROM_SOURCE="${FDROID_EXPO_BUILD_FROM_SOURCE:-1}"

node scripts/fdroid_strip_deps.js
