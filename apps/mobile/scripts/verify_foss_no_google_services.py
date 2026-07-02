#!/usr/bin/env python3
import sys
import zipfile


DISALLOWED_CLASS_PACKAGES = {
    "Google User Messaging Platform": b"com/google/android/ump",
    "Google Play services": b"com/google/android/gms",
    "Firebase": b"com/google/firebase",
    "Google datatransport": b"com/google/android/datatransport",
    "ML Kit": b"com/google/mlkit",
    "Play Core": b"com/google/android/play/core",
    "Play App Update": b"com/google/android/play/appupdate",
    "Play Feature Delivery": b"com/google/android/play/feature",
    "Play In-App Review": b"com/google/android/play/review",
    "Play Integrity": b"com/google/android/play/integrity",
    "Play Billing": b"com/android/billingclient",
    "Play Install Referrer": b"com/android/installreferrer",
    "Play Store update module": b"tech/dongdongbh/mindwtr/playstoreupdates",
}


def find_disallowed_entries(apk_path):
    matches = []
    with zipfile.ZipFile(apk_path) as apk:
        dex_entries = [entry for entry in apk.infolist() if entry.filename.endswith(".dex")]
        for entry in dex_entries:
            content = apk.read(entry)
            for label, pattern in DISALLOWED_CLASS_PACKAGES.items():
                if pattern in content:
                    matches.append((entry.filename, label, pattern.decode("ascii")))
    return matches


def main(argv):
    if len(argv) != 2:
        print("Usage: verify_foss_no_google_services.py <apk>", file=sys.stderr)
        return 2

    apk_path = argv[1]
    matches = find_disallowed_entries(apk_path)
    if matches:
        print("FOSS APK contains Google service library classes:", file=sys.stderr)
        for entry, label, pattern in matches:
            print(f"- {entry}: {label} ({pattern})", file=sys.stderr)
        return 1

    print("Verified FOSS APK excludes Google service library classes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
