"""
Build the store-ready ZIP of the Chrome extension: dist/scout-extension-<version>.zip
(the same file works for the Chrome Web Store and Microsoft Edge Add-ons).

  py -3 scripts/package_extension.py

Checks first that the extension's copies of shared files match the originals and that every file the
manifest points to exists, then zips only the extension folder (no tests, results or personal data).
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"
SHARED = [("scripts/extract/search.js", "extension/extract/search.js"),
          ("scripts/extract/listing.js", "extension/extract/listing.js"),
          ("config/scoring.json", "extension/config/scoring.json"),
          ("data/london_tube_stations.json", "extension/data/london_tube_stations.json")]
SKIP = {".DS_Store", "Thumbs.db"}


def main() -> int:
    problems = []
    for src, copy in SHARED:
        a, b = ROOT / src, ROOT / copy
        if not b.exists() or a.read_bytes() != b.read_bytes():
            problems.append(f"{copy} is out of date: copy {src} over it")
    m = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    refs = list(m.get("icons", {}).values()) + list((m.get("action", {}).get("default_icon") or {}).values())
    refs.append(m["background"]["service_worker"])
    for r in refs:
        if not (EXT / r).exists():
            problems.append(f"manifest points to a missing file: {r}")
    for page in ("app.html", "report.html"):
        html = (EXT / page).read_text(encoding="utf-8")
        for src in __import__("re").findall(r'<script src="([^"]+)"', html):
            if not (EXT / src).exists():
                problems.append(f"{page} loads a missing script: {src}")
    if problems:
        print("Not packaged:\n  " + "\n  ".join(problems))
        return 1
    DIST.mkdir(exist_ok=True)
    out = DIST / f"scout-extension-{m['version']}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and p.name not in SKIP)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(EXT).as_posix())
    print(f"{out.relative_to(ROOT)}  ({len(files)} files, {out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
