#!/usr/bin/env bash
set -euo pipefail

MAIN_BRANCH="${MAIN_BRANCH:-main}"

repo_root="$(git rev-parse --show-toplevel)"

git -C "$repo_root" push origin "$MAIN_BRANCH" --tags

echo "Pushed $MAIN_BRANCH and tags."
echo "Wiki pages are synced from wiki/ by GitHub Actions after changes land on $MAIN_BRANCH."
