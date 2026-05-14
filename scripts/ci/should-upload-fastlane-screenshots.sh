#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <screenshot-source-root>" >&2
  exit 1
fi

SOURCE_ROOT="$1"

if [ "${FORCE_FASTLANE_SCREENSHOTS:-false}" = "true" ]; then
  echo "true"
  exit 0
fi

if [ ! -d "${SOURCE_ROOT}" ]; then
  echo "false"
  exit 0
fi

git fetch --force --tags --depth=1 origin 'refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || true

CURRENT_TAG="${GITHUB_REF_NAME:-}"
if ! [[ "${CURRENT_TAG}" =~ ^v[0-9] ]]; then
  CURRENT_TAG="$(git tag --points-at HEAD --list 'v[0-9]*' | sort -V | tail -n 1 || true)"
fi

PREVIOUS_TAG="$(
  git tag --list 'v[0-9]*' --sort=-v:refname \
    | awk -v current="${CURRENT_TAG}" '$0 != current { print; exit }'
)"

if [ -z "${PREVIOUS_TAG}" ]; then
  echo "true"
  exit 0
fi

if git diff --quiet "${PREVIOUS_TAG}..HEAD" -- "${SOURCE_ROOT}"; then
  echo "false"
else
  echo "true"
fi
