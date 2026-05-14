#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

APP_STORE_TEXT_FILES = {
    "description.txt",
    "keywords.txt",
    "name.txt",
    "release_notes.txt",
    "subtitle.txt",
}

EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0000FE0F"
    "]"
)


def find_invalid_metadata(metadata_dir: Path) -> list[str]:
    errors: list[str] = []

    if not metadata_dir.is_dir():
        raise ValueError(f"Fastlane metadata directory does not exist: {metadata_dir}")

    for path in sorted(metadata_dir.rglob("*.txt")):
        if path.name not in APP_STORE_TEXT_FILES:
            continue

        text = path.read_text(encoding="utf-8")
        invalid_chars = sorted(set(EMOJI_RE.findall(text)))
        if invalid_chars:
            rel_path = path.relative_to(metadata_dir)
            chars = " ".join(invalid_chars)
            errors.append(f"{rel_path}: App Store text metadata cannot contain emoji: {chars}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate generated Fastlane App Store metadata.")
    parser.add_argument("metadata_dir", type=Path)
    args = parser.parse_args()

    try:
        errors = find_invalid_metadata(args.metadata_dir)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
