#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MAX_TITLE_CHARS = 30
MAX_SHORT_DESCRIPTION_CHARS = 80
MAX_FULL_DESCRIPTION_CHARS = 4000
LOCALE_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,8})?$")
REQUIRED_FILES = {
    "title": "title.txt",
    "shortDescription": "short_description.txt",
    "fullDescription": "full_description.txt",
}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def validate_length(label: str, text: str, limit: int, locale: str) -> None:
    length = len(text)
    if length > limit:
        raise ValueError(f"{locale} {label} is {length}/{limit} characters")


def validate_listing(listing: dict[str, str]) -> None:
    locale = listing["language"]
    validate_length("title", listing["title"], MAX_TITLE_CHARS, locale)
    validate_length(
        "shortDescription",
        listing["shortDescription"],
        MAX_SHORT_DESCRIPTION_CHARS,
        locale,
    )
    validate_length(
        "fullDescription",
        listing["fullDescription"],
        MAX_FULL_DESCRIPTION_CHARS,
        locale,
    )

    if locale == "en-US":
        searchable_text = " ".join(
            [
                listing["title"],
                listing["shortDescription"],
                listing["fullDescription"],
            ]
        ).lower()
        if "mind water" not in searchable_text:
            raise ValueError('en-US Google Play metadata must include "mind water"')


def load_listing(locale_dir: Path) -> dict[str, str]:
    locale = locale_dir.name
    missing = [
        filename
        for filename in REQUIRED_FILES.values()
        if not (locale_dir / filename).is_file()
    ]
    if missing:
        raise ValueError(f"{locale} missing Google Play metadata files: {', '.join(missing)}")

    listing = {"language": locale}
    for field, filename in REQUIRED_FILES.items():
        listing[field] = read_text(locale_dir / filename)

    validate_listing(listing)
    return listing


def collect_listings(metadata_root: Path) -> list[dict[str, str]]:
    if not metadata_root.is_dir():
        raise ValueError(f"Missing metadata directory: {metadata_root}")

    listings = []
    for locale_dir in sorted(path for path in metadata_root.iterdir() if path.is_dir()):
        if not LOCALE_RE.match(locale_dir.name):
            continue
        listings.append(load_listing(locale_dir))

    if not listings:
        raise ValueError(f"No Google Play listing metadata found in {metadata_root}")

    return listings


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "Usage: prepare-google-play-listing-metadata.py <metadata-root> <output-json>",
            file=sys.stderr,
        )
        return 1

    metadata_root = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    try:
        listings = collect_listings(metadata_root)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(listings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    for listing in listings:
        print(
            f"{listing['language']}: "
            f"title={len(listing['title'])}/{MAX_TITLE_CHARS}, "
            f"shortDescription={len(listing['shortDescription'])}/{MAX_SHORT_DESCRIPTION_CHARS}, "
            f"fullDescription={len(listing['fullDescription'])}/{MAX_FULL_DESCRIPTION_CHARS}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
