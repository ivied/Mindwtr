#!/usr/bin/env bash
set -euo pipefail

if [ -z "${FASTLANE_METADATA_DIR:-}" ]; then
  echo "FASTLANE_METADATA_DIR is required" >&2
  exit 1
fi

APP_SUPPORT_URL="${APP_SUPPORT_URL:-https://github.com/dongdongbh/Mindwtr/issues}"
APP_MARKETING_URL="${APP_MARKETING_URL:-https://github.com/dongdongbh/Mindwtr}"

rm -rf "${FASTLANE_METADATA_DIR}"
mkdir -p "${FASTLANE_METADATA_DIR}"

if [ -f "metadata/copyright.txt" ]; then
  cp "metadata/copyright.txt" "${FASTLANE_METADATA_DIR}/copyright.txt"
fi

map_metadata() {
  local src_locale="$1"
  local dst_locale="$2"
  local src_dir="metadata/${src_locale}"
  local dst_dir="${FASTLANE_METADATA_DIR}/${dst_locale}"

  if [ ! -d "${src_dir}" ]; then
    echo "Skipping ${src_locale} (missing metadata folder)"
    return
  fi

  mkdir -p "${dst_dir}"

  if [ -f "${src_dir}/description.txt" ]; then
    cp "${src_dir}/description.txt" "${dst_dir}/description.txt"
  elif [ -f "${src_dir}/full_description.txt" ]; then
    cp "${src_dir}/full_description.txt" "${dst_dir}/description.txt"
  fi

  if [ -f "${src_dir}/name.txt" ]; then
    cp "${src_dir}/name.txt" "${dst_dir}/name.txt"
  elif [ -f "${src_dir}/title.txt" ]; then
    cp "${src_dir}/title.txt" "${dst_dir}/name.txt"
  fi

  if [ -f "${src_dir}/subtitle.txt" ]; then
    cp "${src_dir}/subtitle.txt" "${dst_dir}/subtitle.txt"
  elif [ -f "${src_dir}/short_description.txt" ]; then
    cp "${src_dir}/short_description.txt" "${dst_dir}/subtitle.txt"
  fi

  if [ -f "${src_dir}/keywords.txt" ]; then
    cp "${src_dir}/keywords.txt" "${dst_dir}/keywords.txt"
  fi

  if [ -f "${src_dir}/support_url.txt" ]; then
    cp "${src_dir}/support_url.txt" "${dst_dir}/support_url.txt"
  elif [ -n "${APP_SUPPORT_URL}" ]; then
    printf '%s\n' "${APP_SUPPORT_URL}" > "${dst_dir}/support_url.txt"
  fi

  if [ -f "${src_dir}/marketing_url.txt" ]; then
    cp "${src_dir}/marketing_url.txt" "${dst_dir}/marketing_url.txt"
  elif [ -n "${APP_MARKETING_URL}" ]; then
    printf '%s\n' "${APP_MARKETING_URL}" > "${dst_dir}/marketing_url.txt"
  fi

  if [ -f "${src_dir}/release_notes.txt" ]; then
    cp "${src_dir}/release_notes.txt" "${dst_dir}/release_notes.txt"
    echo "Release notes source for ${src_locale}: release_notes.txt"
    return
  fi

  if [ -d "${src_dir}/changelogs" ]; then
    local latest_log=""
    latest_log="$(
      ls -1 "${src_dir}/changelogs" 2>/dev/null \
        | sed -E 's/\.txt$//' \
        | grep -E '^[0-9]+$' \
        | sort -n \
        | tail -n 1 || true
    )"
    if [ -n "${latest_log}" ] && [ -f "${src_dir}/changelogs/${latest_log}.txt" ]; then
      cp "${src_dir}/changelogs/${latest_log}.txt" "${dst_dir}/release_notes.txt"
      echo "Release notes source for ${src_locale}: changelogs/${latest_log}.txt"
      return
    fi
  fi

  if [ -n "${RELEASE_BODY:-}" ]; then
    printf '%s\n' "${RELEASE_BODY}" > "${dst_dir}/release_notes.txt"
    echo "Release notes source for ${src_locale}: github release body"
    return
  fi

  echo "No release notes found for ${src_locale}"
}

map_metadata "en-US" "en-US"
map_metadata "es-ES" "es-ES"
map_metadata "zh-CN" "zh-Hans"

python3 scripts/ci/validate-fastlane-metadata.py "${FASTLANE_METADATA_DIR}"

echo "Generated fastlane metadata files:"
find "${FASTLANE_METADATA_DIR}" -type f | sort
