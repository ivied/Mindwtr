#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("validate-fastlane-metadata.py")
SPEC = importlib.util.spec_from_file_location("validate_fastlane_metadata", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_required_metadata(root: Path) -> None:
    for locale in MODULE.REQUIRED_LOCALES:
        locale_dir = root / locale
        locale_dir.mkdir()
        for filename in MODULE.APP_STORE_TEXT_FILES:
            (locale_dir / filename).write_text(f"{locale} {filename}\n", encoding="utf-8")


class ValidateFastlaneMetadataTest(unittest.TestCase):
    def test_allows_required_localized_non_emoji_text(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_required_metadata(root)
            (root / "zh-Hans" / "description.txt").write_text("本地优先的 GTD 任务管理器。\n", encoding="utf-8")

            self.assertEqual(MODULE.find_invalid_metadata(root), [])

    def test_requires_french_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_required_metadata(root)
            for path in (root / "fr-FR").iterdir():
                path.unlink()
            (root / "fr-FR").rmdir()

            errors = MODULE.find_invalid_metadata(root)

        self.assertIn("fr-FR: required App Store metadata locale is missing", errors)

    def test_rejects_emoji_in_app_store_text_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_required_metadata(root)
            (root / "en-US" / "description.txt").write_text("Private GTD capture 🚀\n", encoding="utf-8")

            errors = MODULE.find_invalid_metadata(root)

        self.assertEqual(len(errors), 1)
        self.assertIn("description.txt", errors[0])
        self.assertIn("🚀", errors[0])

    def test_ignores_non_app_store_text_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_required_metadata(root)
            (root / "en-US" / "support_url.txt").write_text("https://example.com/🚀\n", encoding="utf-8")

            self.assertEqual(MODULE.find_invalid_metadata(root), [])


if __name__ == "__main__":
    unittest.main()
