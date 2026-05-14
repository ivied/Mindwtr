#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("prepare-google-play-listing-metadata.py")
SPEC = importlib.util.spec_from_file_location("prepare_google_play_listing_metadata", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_listing(
    root: Path,
    locale: str,
    *,
    title: str = "Mindwtr",
    short_description: str = "Mindwtr (mind water): local-first GTD capture.",
    full_description: str = 'Mindwtr (pronounced "mind water") keeps GTD tasks local.',
) -> None:
    locale_dir = root / locale
    locale_dir.mkdir(parents=True)
    (locale_dir / "title.txt").write_text(title + "\n", encoding="utf-8")
    (locale_dir / "short_description.txt").write_text(short_description + "\n", encoding="utf-8")
    (locale_dir / "full_description.txt").write_text(full_description + "\n", encoding="utf-8")


class PrepareGooglePlayListingMetadataTest(unittest.TestCase):
    def test_collects_localized_listing_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_listing(root, "en-US")
            write_listing(
                root,
                "es-ES",
                short_description="Un sistema GTD completo.",
                full_description="Mindwtr es un sistema GTD privado.",
            )
            (root / "chocolatey").mkdir()

            listings = MODULE.collect_listings(root)

        self.assertEqual([listing["language"] for listing in listings], ["en-US", "es-ES"])
        self.assertEqual(listings[0]["title"], "Mindwtr")
        self.assertIn("shortDescription", listings[0])
        self.assertIn("fullDescription", listings[0])

    def test_en_us_metadata_must_include_mind_water(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_listing(
                root,
                "en-US",
                short_description="Local-first GTD capture.",
                full_description="A private GTD task manager.",
            )

            with self.assertRaisesRegex(ValueError, "mind water"):
                MODULE.collect_listings(root)

    def test_rejects_short_descriptions_over_google_play_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_listing(root, "en-US", short_description="Mindwtr mind water " + ("x" * 80))

            with self.assertRaisesRegex(ValueError, "shortDescription"):
                MODULE.collect_listings(root)


if __name__ == "__main__":
    unittest.main()
