"""
Offline self-test for Airbnb Scout's scripts. Needs no browser, no network and no Claude.
Runs on Windows (py -3 scripts/selftest.py) and Linux/macOS/cloud sessions (python3 scripts/selftest.py).

Checks: the sweep planner, the stage-1 pre-filter, and merge + ranking on a saved London run
(tests/fixtures/london_run). Caches are redirected to a temp folder, so nothing in data/ changes.
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import geo  # noqa: E402
import scout_tools as st  # noqa: E402

FIX = HERE.parent / "tests" / "fixtures" / "london_run"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        failures.append(name)


def run(fn, args):
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn(args)
    return json.loads(buf.getvalue().strip().splitlines()[-1])


def main():
    tmp = Path(tempfile.mkdtemp(prefix="scout-selftest-"))
    st.LISTING_CACHE, st.SAFETY_CACHE, st.ROUTE_CACHE = tmp / "l.json", tmp / "s.json", tmp / "r.json"

    stations = geo.load_stations()
    check("tube stations load", len(stations) > 250, f"{len(stations)} stations")

    plan = geo.plan_tiles(3, 1, 2, 16, 900, "https://www.airbnb.com/s/London/homes?adults=2")
    check("sweep plan: 2 sectors with wide URLs", len(plan["scouts"]) == 2 and all("wideUrl" in s for s in plan["scouts"]))

    cards = [  # Leyton (near the Central line), Richmond Park (far from any tube), over budget
        {"id": "a", "lat": 51.5585, "lon": -0.0070, "total": 2158, "beds": 2, "rating": 4.54, "reviews": 146},
        {"id": "b", "lat": 51.4430, "lon": -0.2740, "total": 2518, "beds": 2, "rating": 4.81, "reviews": 31},  # Richmond Park
        {"id": "c", "lat": 51.5000, "lon": -0.1200, "total": 3600, "beds": 2, "rating": 4.9, "reviews": 80},
    ]
    cf = tmp / "cards.json"
    cf.write_text(json.dumps({"results": cards}), encoding="utf-8")
    near = run(st.cmd_near, SimpleNamespace(inp=str(cf), max_walk=10, max_zone=3, min_zone=0, budget=3000, min_beds=2, city="London", top=8, price_mode="cap"))
    ids = [r["id"] for r in near["open"]]
    check("pre-filter keeps the Leyton card", ids == ["a"], f"kept {ids}, dropped {near['dropped']}")
    check("pre-filter finds Leyton station", near["open"] and near["open"][0]["station"]["name"] == "Leyton")

    out = tmp / "out.json"
    summary = run(st.cmd_rank, SimpleNamespace(filters=str(FIX / "filters.json"), scouts=str(FIX), out=str(out),
                                               keep=8, no_safety=True, no_routes=True))
    R = json.loads(out.read_text(encoding="utf-8"))
    picks = [l for l in R["listings"] if not l.get("nearMiss")]
    check("rank writes picks and near misses", summary["matches"] >= 5 and summary["nearMisses"] >= 1,
          f"{summary['matches']} matches, {summary['nearMisses']} near misses")
    check("exactly one top pick", sum(1 for l in picks if l.get("topPick")) == 1)
    check("everything shown is within budget +5%", all((l.get("totalPrice") or 0) <= 3150 for l in R["listings"]))
    check("non-tube station becomes a near miss",
          any("isn't a tube station" in (l.get("nearMissReason") or "") for l in R["listings"]))
    check("every listing has checks and a why", all(l.get("checks") and l.get("why") for l in R["listings"]))

    ext = HERE.parent / "extension" / "extract"
    same = all((ext / n).exists() and (ext / n).read_bytes() == (HERE / "extract" / n).read_bytes() for n in ("search.js", "listing.js"))
    check("extension uses the same page-reading scripts", same, "" if same else "copy scripts/extract/*.js into extension/extract/")

    print("\nAll good." if not failures else f"\n{len(failures)} check(s) failed: {', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
