"""
Scout's scoring and listing rules, driven by config/scoring.json.

  classify(c, F, cfg, ctx) -> (verdict, reasons, checks)   verdict: "drop" | "near" | "match"
  score(c, F, cfg)         -> int 0-100
  breakdown(c, F, cfg)     -> [(label, points)]  the same maths, itemised (for the tuning page and the report)
  rescore(results, cfg)    -> re-rank a saved results JSON with another config (tuning; no browsing, no network)

Used by scripts/scout_tools.py (rank) and the server's tuning page.
"""
from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "scoring.json"

DEFAULTS = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}


def load_config(path: Path | None = None) -> dict:
    try:
        return json.loads((path or CONFIG).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return deepcopy(DEFAULTS)


def zone_min(z) -> int:
    nums = [int(x) for x in str(z or "").replace("+", "/").split("/") if x.strip().isdigit()]
    return min(nums) if nums else 99


def money(cur, v):
    sym = {"ILS": "₪", "USD": "$", "EUR": "€", "GBP": "£"}.get((cur or "").upper(), "")
    return f"{sym}{v:,.0f}" if sym else f"{v:,.0f} {cur}"


def is_late(F: dict, cfg: dict) -> bool:
    a = (F.get("arrival") or {}).get("datetime")
    if not a:
        return False
    try:
        h = datetime.fromisoformat(a).hour
    except ValueError:
        return False
    r = cfg.get("rules", {})
    return h < r.get("lateArrivalBeforeHour", 6) or h >= r.get("lateArrivalFromHour", 22)


def needs_self_checkin(F: dict) -> bool:
    return bool(F.get("selfCheckIn")) or any("self check" in str(m).lower() for m in F.get("mustHaves", []))


# ---------------------------------------------------------------- rules

def classify(c: dict, F: dict, cfg: dict, ctx: dict | None = None):
    """ctx: {"london": bool, "is_tube_station": callable(name) -> bool}"""
    ctx = ctx or {}
    r = cfg.get("rules", {})
    budget, cur = F.get("budgetTotal"), F.get("currency", "")
    max_walk, min_beds = F.get("maxWalkMin"), F.get("minBeds")
    max_zone = (F.get("geography") or {}).get("maxZone")
    late, need_self = is_late(F, cfg), needs_self_checkin(F)
    reasons = []
    tp = c.get("totalPrice")
    if c.get("unavailable"):
        return "drop", ["Not available for your dates"], []
    if budget and tp:
        if tp > budget * (1 + r.get("overBudgetNearMissUpTo", 0.05)):
            return "drop", ["Over budget"], []
        if tp > budget:
            reasons.append(f"{money(cur, tp - budget)} over budget")
    if min_beds and c.get("beds") is not None and c["beds"] < min_beds:
        return "drop", ["Too few beds"], []
    ee = c.get("effectivelyEntire", True)
    if ee is False:
        return "drop", ["Shared, not the whole place"], []
    if ee == "unclear":
        reasons.append("Not clear you get the whole place")
    st = c.get("station") or {}
    if max_walk and st.get("walkMin") is not None and st["walkMin"] > max_walk:
        if st["walkMin"] > max_walk + r.get("walkNearMissExtraMin", 6):
            return "drop", ["Too far from transit"], []
        reasons.append(f"{st['walkMin']} min walk to the tube")
    if ctx.get("london") and st.get("name") and ctx.get("is_tube_station") and not ctx["is_tube_station"](st["name"]):
        reasons.append(f"{st['name']} isn't a tube station")
    z = zone_min(st.get("zone")) if st else 99
    if max_zone and z != 99 and z > max_zone:
        reasons.append(f"Zone {st.get('zone')}")
    ci = c.get("checkIn") or {}
    self_ci = ci.get("selfCheckIn")
    if need_self and self_ci is False:
        return "drop", ["No self check-in"], []
    desk24 = "24" in str(ci.get("method", ""))
    if late and self_ci is False and not desk24:
        reasons.append("Key pickup won't work for a late arrival")
    until = str(ci.get("until") or "").strip()
    late_window_ok = True
    if late and re.match(r"^\d{1,2}:\d{2}$", until):
        uh = int(until.split(":")[0])
        if not (0 < uh < 12):  # closes in the evening or at midnight: before an early-hours arrival
            late_window_ok = False
            reasons.append(f"Check-in ends {until}, before your arrival")

    checks = []
    if budget and tp:
        checks.append({"label": f"≤ {money(cur, budget)}", "pass": tp <= budget})
    if min_beds:
        checks.append({"label": f"≥ {min_beds} beds", "pass": (c.get("beds") or 0) >= min_beds})
    checks.append({"label": "Entire place", "pass": ee is True})
    if max_walk and st.get("walkMin") is not None:
        checks.append({"label": f"Tube ≤{max_walk} min", "pass": st["walkMin"] <= max_walk})
    if max_zone and z != 99:
        checks.append({"label": f"Zone ≤ {max_zone}", "pass": z <= max_zone})
    if need_self:
        checks.append({"label": "Self check-in", "pass": bool(self_ci)})
    if late:
        checks.append({"label": "Late check-in OK", "pass": (bool(self_ci) or desk24) and late_window_ok})
    own = {x["label"] for x in checks}
    checks += [x for x in (c.get("checks") or []) if x.get("label") not in own
               and not any(w in x.get("label", "") for w in ("beds", "₪", "budget", "Tube", "Zone", "Self", "Entire", "Late check-in"))]
    return ("near" if reasons else "match"), reasons, checks


# ---------------------------------------------------------------- points

def review_points(n, bands) -> float:
    pts = 0
    for at_least, p in sorted(bands, key=lambda b: b[0]):
        if (n or 0) >= at_least:
            pts = p
    return pts


def capped(n_items, each, max_total) -> float:
    """each and max_total are negative numbers (penalties)."""
    return max(max_total, each * n_items)


def breakdown(c: dict, F: dict, cfg: dict) -> list[tuple[str, float]]:
    P = cfg.get("points", {})
    out = [("Base", P.get("base", 0))]
    budget, tp = F.get("budgetTotal"), c.get("totalPrice")
    st = c.get("station") or {}
    if budget and tp:
        p = P["price"]
        out.append(("Price under budget", p["max"] * min(1, max(0, (budget - tp) / (budget * p["fullAtShareUnderBudget"])))))
    if st.get("walkMin") is not None:
        w = P["walk"]
        span = max(1, (F.get("maxWalkMin") or 10) - (w["fullWithinMin"] - 2))
        out.append(("Walk to station", w["max"] * max(0, 1 - max(0, st["walkMin"] - w["fullWithinMin"]) / span)))
    n = c.get("reviews") or 0
    rc = P["reviewCount"]
    out.append(("Number of reviews", review_points(n, rc["bands"]) * (rc["multiplierIfUserPrefersReviews"] if F.get("preferReviews", True) else 1)))
    if n >= P["rating"]["minReviews"] and c.get("rating"):
        out.append(("Star rating", (c["rating"] - 4) * P["rating"]["perStarAbove4"]))
    issues = len(c.get("reviewIssues") or [])
    if issues:
        out.append(("Problems in reviews", capped(issues, P["reviewIssue"]["each"], P["reviewIssue"]["maxTotal"])))
    if c.get("bonus"):
        out.append(("Your extra priorities", c["bonus"]))
    if (F.get("geography") or {}).get("preferCentral", True):
        zp = {1: P["centrality"].get("zone1", 0), 2: P["centrality"].get("zone2", 0)}.get(zone_min(st.get("zone")) if st else 99, 0)
        if zp:
            out.append(("Central location", zp))
    lvl = (c.get("safety") or {}).get("level")
    if lvl in P.get("safety", {}) and P["safety"][lvl]:
        out.append((f"Area safety ({lvl})", P["safety"][lvl]))
    serious = c.get("seriousFlags") or []
    if serious:
        out.append(("Serious red flags", capped(len(serious), P["seriousFlag"]["each"], P["seriousFlag"]["maxTotal"])))
    minor = [f for f in (c.get("redFlags") or []) if f not in serious]
    if minor:
        out.append(("Other red flags", capped(len(minor), P["redFlag"]["each"], P["redFlag"]["maxTotal"])))
    if c.get("onWishlist") or c.get("wishlisted"):
        out.append(("On your wishlist", P.get("wishlist", 0)))
    t = ((c.get("arrivalRoute") or {}).get("transit") or {}).get("totalMin")
    if t:
        a = P["arrival"]
        out.append(("Quick arrival", max(0, a["max"] - max(0, t - a["fullWithinMin"]) / a["losePointEveryMin"])))
    return out


def score(c: dict, F: dict, cfg: dict) -> int:
    return int(max(0, min(100, round(sum(p for _, p in breakdown(c, F, cfg))))))


# ---------------------------------------------------------------- tuning

def rescore(results: dict, cfg: dict, ctx: dict | None = None) -> dict:
    """Re-apply rules and points to the listings in a saved results JSON (which already has stations,
    safety levels, routes and review findings). Listings dropped by the original search can't come back."""
    F = results.get("filters") or {}
    r = cfg.get("rules", {})
    matches, near, dropped = [], [], []
    for l in results.get("listings", []):
        c = deepcopy(l)
        verdict, reasons, checks = classify(c, F, cfg, ctx)
        c["checks"] = checks
        c["score"] = score(c, F, cfg)
        c["breakdown"] = [[k, round(v, 1)] for k, v in breakdown(c, F, cfg)]
        c["was"] = {"score": l.get("score"), "nearMiss": l.get("nearMiss"), "topPick": l.get("topPick")}
        if verdict == "drop":
            c["dropReason"] = "; ".join(reasons)
            dropped.append(c)
        elif verdict == "near":
            c["nearMiss"], c["nearMissReason"] = True, "; ".join(reasons)
            near.append(c)
        else:
            c["nearMiss"], c["nearMissReason"] = False, ""
            matches.append(c)
    matches.sort(key=lambda c: -c["score"])
    near.sort(key=lambda c: -c["score"])
    matches, near = matches[: r.get("keepMatches", 8)], near[: r.get("keepNearMisses", 4)]
    for i, c in enumerate(matches):
        c["topPick"] = i == 0
    return {"matches": matches, "nearMisses": near, "dropped": dropped}
