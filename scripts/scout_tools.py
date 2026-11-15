"""
Airbnb Scout helpers that replace work the model used to do by hand. Standard library only.

  py -3 scripts/scout_tools.py near --in cards.json [--max-walk 10] [--max-zone 3] [--min-zone 1]
                                    [--budget 3000] [--min-beds 2] [--city London] [--top 12]
      Stage 1 pre-filter. Takes search cards (output of scripts/extract/search.js, or a list of them),
      adds the nearest tube station, walk minutes and zone from the card's coordinates (London),
      marks cached listings, drops clear misses and prints the best few to open. Compact output.

  py -3 scripts/scout_tools.py cache get <id> [<id> ...]
  py -3 scripts/scout_tools.py cache put <file.json>
      Listing cache (data/listing_cache.json): verified facts that don't depend on dates
      (description notes, reviews, whole-flat verdict, check-in). Kept 30 days. Prices are never cached.

  py -3 scripts/scout_tools.py rank --filters filters.json --scouts results/runs/<run> --out results/<run>.json
                                    [--no-safety] [--no-routes]
      Merge the scouts' files, apply the hard filters and the scoring rules, add police street-crime
      levels and arrival routes (TfL Journey Planner, per station, cached), draft a "why" line per pick,
      and write the full results JSON that build-report.ps1 and the app read.

  py -3 scripts/scout_tools.py route --from LGW --date 20261129 --time 0145 --station "Brent Cross" ...
      TfL journeys from an airport/station/"lat,lon" to tube stations (debugging; rank uses it).
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geo  # noqa: E402
import scoring  # noqa: E402

ROOT = geo.ROOT
DATA = ROOT / "data"
LISTING_CACHE = DATA / "listing_cache.json"
SAFETY_CACHE = DATA / "safety_cache.json"
ROUTE_CACHE = DATA / "route_cache.json"
CACHE_DAYS = 30
WALK_M_PER_MIN = 80        # brisk-ish walk
WALK_DETOUR = 1.3          # streets aren't straight lines

PLACES = {  # common arrival points (lat, lon)
    "LGW": (51.1565, -0.1610, "London Gatwick Airport (LGW)"),
    "LHR": (51.4700, -0.4543, "London Heathrow Airport (LHR)"),
    "STN": (51.8860, 0.2389, "London Stansted Airport (STN)"),
    "LTN": (51.8747, -0.3683, "London Luton Airport (LTN)"),
    "LCY": (51.5048, 0.0495, "London City Airport (LCY)"),
    "SEN": (51.5714, 0.6956, "London Southend Airport (SEN)"),
    "STP": (51.5320, -0.1263, "London St Pancras International"),
}


def load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def save(p: Path, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


# ---------------------------------------------------------------- stations

def nearest_station(lat, lon, stations):
    best, bd = None, 1e18
    for s in stations:
        d = geo.dist_m((lat, lon), (s["lat"], s["lon"]))
        if d < bd:
            best, bd = s, d
    if not best:
        return None
    walk = round(bd * WALK_DETOUR / WALK_M_PER_MIN)
    return {"name": best["name"], "zone": best["zone"], "lines": best["lines"], "walkMin": max(1, walk),
            "distM": round(bd), "approx": True, "lat": best["lat"], "lon": best["lon"]}


def is_london(city: str | None) -> bool:
    return not city or "london" in city.lower()


# ---------------------------------------------------------------- cache

def cache_get(ids):
    c = load(LISTING_CACHE, {})
    cutoff = time.time() - CACHE_DAYS * 86400
    return {i: c[i] for i in ids if i in c and c[i].get("savedAt", 0) >= cutoff}


def cache_put(items):
    c = load(LISTING_CACHE, {})
    keep = ("title", "image", "area", "propertyType", "listedAs", "effectivelyEntire", "entireEvidence", "beds",
            "bedrooms", "baths", "maxGuests", "rating", "reviews", "superhost", "lastReviewDate", "reviewSummary",
            "reviewIssues", "hostNotes", "checkIn", "cancellation", "redFlags", "seriousFlags", "notes", "lat", "lon")
    n = 0
    for it in items:
        if not it.get("id"):
            continue
        rec = {k: it[k] for k in keep if k in it and it[k] not in (None, "", [])}
        rec["savedAt"] = int(time.time())
        c[str(it["id"])] = rec
        n += 1
    save(LISTING_CACHE, c)
    return n


# ---------------------------------------------------------------- stage 1

def cards_from(path):
    raw = load(Path(path), [])
    cards = []
    def take(x):
        if isinstance(x, list):
            for y in x:
                take(y)
        elif isinstance(x, dict):
            if "results" in x:
                take(x["results"])
            elif x.get("id"):
                cards.append(x)
    take(raw)
    seen, uniq = set(), []
    for c in cards:
        if str(c["id"]) not in seen:
            seen.add(str(c["id"]))
            uniq.append(c)
    return uniq


def review_pts(n):
    return scoring.review_points(n, scoring.load_config()["points"]["reviewCount"]["bands"])


def cmd_near(a):
    cards = cards_from(a.inp)
    stations = [s for s in geo.load_stations()] if is_london(a.city) else []
    cached = cache_get([str(c["id"]) for c in cards])
    keep, dropped = [], {"price": 0, "beds": 0, "walk": 0, "zone": 0}
    for c in cards:
        if a.budget and c.get("total") and c["total"] > a.budget * (1 + scoring.over_budget_allowance({"priceMode": a.price_mode}, scoring.load_config())):
            dropped["price"] += 1; continue
        if a.min_beds and c.get("beds") is not None and c["beds"] < a.min_beds:
            dropped["beds"] += 1; continue
        st = nearest_station(c["lat"], c["lon"], stations) if stations and c.get("lat") is not None else None
        if st:
            # coordinates are blurred, so keep everything up to the near-miss cutoff; the full check decides
            if a.max_walk and st["walkMin"] > scoring.walk_cutoff(a.max_walk, scoring.load_config()):
                dropped["walk"] += 1; continue
            z = geo.zone_min(st["zone"])
            if (a.max_zone and z > a.max_zone) or (a.min_zone and z < a.min_zone):
                dropped["zone"] += 1; continue
        pre = 0.0
        if a.budget and c.get("total"):
            pre += scoring.price_points(c["total"], {"budgetTotal": a.budget, "priceMode": a.price_mode}, scoring.load_config())
        pre += review_pts(c.get("reviews")) + dict(scoring.breakdown({"reviews": c.get("reviews"), "rating": c.get("rating")}, {}, scoring.load_config())).get("Star rating", 0)
        if st:
            pre += scoring.walk_points(st["walkMin"], a.max_walk or None, scoring.load_config())
            pre += {1: 8, 2: 4}.get(geo.zone_min(st["zone"]), 0)
        row = {"id": str(c["id"]), "name": c.get("name") or c.get("title"), "type": c.get("title"), "area": c.get("area"),
               "total": c.get("total"), "beds": c.get("beds"), "info": c.get("info"), "rating": c.get("rating"),
               "reviews": c.get("reviews"), "lat": c.get("lat"), "lon": c.get("lon"), "image": c.get("image"),
               "badges": c.get("badges") or [], "pre": round(pre, 1)}
        if st:
            row["station"] = {k: st[k] for k in ("name", "zone", "lines", "walkMin", "approx")}
        if str(c["id"]) in cached:
            row["cached"] = True
        keep.append(row)
    keep.sort(key=lambda r: -r["pre"])
    out({"cards": len(cards), "kept": len(keep), "dropped": dropped, "open": keep[: a.top], "rest": [r["id"] for r in keep[a.top:]]})


# ---------------------------------------------------------------- safety

def safety_for(stations_named, stations_all):
    cache = load(SAFETY_CACHE, {})
    try:
        month = geo.latest_month()
    except Exception:  # noqa: BLE001
        month = cache.get("_month")
    res = {}
    for name in stations_named:
        key = f"{month}|{name}"
        if key in cache:
            res[name] = cache[key]; continue
        s = geo.find_station(stations_all, name)
        if not s or not month:
            continue
        try:
            r = geo.safety_at(s["lat"], s["lon"], month)
            cache[key] = {"streetCrime": r["streetCrime"], "month": month}
            res[name] = cache[key]
        except Exception:  # noqa: BLE001
            pass
    cache["_month"] = month
    save(SAFETY_CACHE, cache)
    return res


# ---------------------------------------------------------------- routes

def place_coords(p: str):
    p = p.strip()
    up = p.upper()
    for code, (lat, lon, label) in PLACES.items():
        if code == up or code in up.replace("(", " ").replace(")", " ").split() or label.lower() in p.lower():
            return lat, lon, label
    if "," in p:
        try:
            lat, lon = [float(x) for x in p.split(",")[:2]]
            return lat, lon, p
        except ValueError:
            pass
    s = geo.find_station(geo.load_stations(), p)
    if s:
        return s["lat"], s["lon"], s["name"]
    if "gatwick" in p.lower():
        return PLACES["LGW"]
    if "heathrow" in p.lower():
        return PLACES["LHR"]
    if "stansted" in p.lower():
        return PLACES["STN"]
    if "luton" in p.lower():
        return PLACES["LTN"]
    return None


def tfl_journey(frm, to, date, hhmm):
    cache = load(ROUTE_CACHE, {})
    key = f"{frm[0]:.4f},{frm[1]:.4f}>{to[0]:.4f},{to[1]:.4f}@{date}{hhmm}"
    if key in cache:
        return cache[key]
    url = (f"https://api.tfl.gov.uk/Journey/JourneyResults/{frm[0]:.5f},{frm[1]:.5f}/to/{to[0]:.5f},{to[1]:.5f}"
           f"?date={date}&time={hhmm}&timeIs=Departing&journeyPreference=leasttime")
    try:
        data = geo.get_json(url, timeout=60)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:160]}
    js = data.get("journeys") or []
    if not js:
        return {"error": "no journeys"}
    best = min(js, key=lambda j: j.get("arrivalDateTime", "9"))
    legs = []
    for lg in best.get("legs", []):
        mode = (lg.get("mode") or {}).get("name", "")
        summ = (lg.get("instruction") or {}).get("summary", "")
        legs.append({"mode": mode, "summary": summ, "dep": lg.get("departureTime", "")[11:16],
                     "arr": lg.get("arrivalTime", "")[11:16], "min": lg.get("duration")})
    ride = [l for l in legs if l["mode"] not in ("walking",)]
    r = {"leaveAt": best.get("startDateTime", "")[11:16], "arriveAt": best.get("arrivalDateTime", "")[11:16],
         "totalMin": best.get("duration"), "changes": max(0, len(ride) - 1), "legs": legs,
         "summary": " → ".join(l["summary"] for l in ride) or "Walk"}
    cache[key] = r
    save(ROUTE_CACHE, cache)
    time.sleep(0.3)  # be gentle with the open API
    return r


def taxi_est(frm, to):
    km = geo.dist_m(frm, to) / 1000 * 1.35
    mins = round(km / 65 * 60 + 8)  # quiet roads at night
    lo, hi = round((20 + 1.6 * km) / 5) * 5, round((30 + 2.3 * km) / 5) * 5
    return {"minutes": mins, "fare": f"£{lo}–{hi} (est.)"}


def cmd_route(a):
    pc = place_coords(a.frm)
    st_all = geo.load_stations()
    res = []
    for name in a.station:
        s = geo.find_station(st_all, name)
        if s and pc:
            res.append({"station": s["name"], **tfl_journey(pc[:2], (s["lat"], s["lon"]), a.date, a.time)})
    out(res)


# ---------------------------------------------------------------- rank

def norm_zone(st):
    return geo.zone_min((st or {}).get("zone", "")) if st else 99


def money(cur, v):
    sym = {"ILS": "₪", "USD": "$", "EUR": "€", "GBP": "£"}.get((cur or "").upper(), "")
    return f"{sym}{v:,.0f}" if sym else f"{v:,.0f} {cur}"


def cmd_rank(a):
    F = load(Path(a.filters), {})
    budget = F.get("budgetTotal")
    cur = F.get("currency", "")
    max_walk = F.get("maxWalkMin")
    geo_f = F.get("geography") or {}
    max_zone, min_zone = geo_f.get("maxZone"), geo_f.get("minZone")
    min_beds = F.get("minBeds")
    need_self = any("self check" in str(m).lower() for m in F.get("mustHaves", [])) or F.get("selfCheckIn")
    prefer_reviews = F.get("preferReviews", True)
    arrival = F.get("arrival") or {}
    london = is_london(F.get("location"))
    stations_all = geo.load_stations() if london else []

    # merge scout files
    scouts, cands = [], {}
    files = sorted(glob.glob(str(Path(a.scouts) / "scout-*.json")))
    for fp in files:
        d = load(Path(fp), {})
        if isinstance(d, list):
            d = {"candidates": d}
        scouts.append({"label": d.get("slice") or Path(fp).stem, "url": d.get("url", ""), "status": d.get("status", "ok"),
                       "found": len(d.get("candidates", [])), "note": d.get("note", "")})
        for c in d.get("candidates", []):
            cid = str(c.get("id"))
            if cid in cands:  # keep the more complete record
                old = cands[cid]
                for k, v in c.items():
                    if old.get(k) in (None, "", []) and v not in (None, "", []):
                        old[k] = v
            else:
                cands[cid] = dict(c)

    # fill gaps from the cache, then refresh the cache with what scouts verified
    cached = cache_get(list(cands))
    for cid, c in cands.items():
        for k, v in (cached.get(cid) or {}).items():
            if k != "savedAt" and c.get(k) in (None, "", []):
                c[k] = v
    cache_put([c for c in cands.values() if c.get("reviewSummary") or c.get("hostNotes")])

    # stations from coordinates where the scout didn't give one
    for c in cands.values():
        st = c.get("station") or {}
        if london and c.get("lat") is not None:
            ns = nearest_station(c["lat"], c["lon"], stations_all)
            if ns and (not st.get("name") or st.get("walkMin") is None):
                c["station"] = {"name": ns["name"], "type": f"Tube · {', '.join(ns['lines'][:2])} · Zone {ns['zone']}",
                                "walkMin": ns["walkMin"], "approx": True, "zone": ns["zone"]}
            elif ns and not st.get("zone"):
                st["zone"] = ns["zone"]
        if c.get("totalPrice") and F.get("nights") and not c.get("perNight"):
            c["perNight"] = round(c["totalPrice"] / F["nights"])
        c.setdefault("currency", cur)
        c.setdefault("url", f"https://www.airbnb.com/rooms/{c.get('id')}?check_in={F.get('checkin','')}&check_out={F.get('checkout','')}&adults={F.get('guests',2)}&locale=en")

    cfg = scoring.load_config()
    ctx = {"london": london, "is_tube_station": lambda name: bool(geo.find_station(stations_all, name))}

    # hard rules (config/scoring.json → rules): drop, near miss, or match
    matches, near = [], []
    for c in cands.values():
        verdict, reasons, checks = scoring.classify(c, F, cfg, ctx)
        if verdict == "drop":
            continue
        c["checks"] = checks
        if verdict == "near":
            c["nearMiss"], c["nearMissReason"] = True, "; ".join(reasons)
            near.append(c)
        else:
            c["nearMiss"] = False
            matches.append(c)

    # safety (relative across the shortlist)
    pool = matches + near
    if london and not a.no_safety:
        sf = safety_for(sorted({(c.get("station") or {}).get("name") for c in pool if (c.get("station") or {}).get("name")}), stations_all)
        vals = sorted(v["streetCrime"] for v in sf.values())
        lo_cut = vals[len(vals) // 3] if vals else 0
        hi_cut = vals[(2 * len(vals)) // 3] if vals else 0
        for c in pool:
            s = sf.get((c.get("station") or {}).get("name"))
            if s:
                lvl = "calmer" if s["streetCrime"] <= lo_cut else "busier" if s["streetCrime"] > hi_cut else "average"
                prev = c.get("safety") or {}
                c["safety"] = {"level": lvl, "streetCrime": s["streetCrime"], "month": s["month"], "note": prev.get("note", "")}

    # arrival routes per station (TfL), shared across listings at the same station
    airport_opts = []
    if arrival.get("datetime") and london and not a.no_routes:
        pc = place_coords(arrival.get("place", ""))
        if pc:
            land = datetime.fromisoformat(arrival["datetime"])
            buf = 45 if arrival.get("type", "flight") == "flight" else 10
            ready = land + timedelta(minutes=buf)
            date, hhmm = ready.strftime("%Y%m%d"), ready.strftime("%H%M")
            by_station = {}
            ranked_pool = sorted(pool, key=lambda c: c.get("totalPrice") or 9e9)
            for c in ranked_pool:
                st = c.get("station") or {}
                s = geo.find_station(stations_all, st.get("name", "")) if st.get("name") else None
                if not s:
                    continue
                if s["name"] not in by_station:
                    by_station[s["name"]] = tfl_journey(pc[:2], (s["lat"], s["lon"]), date, hhmm)
                j = by_station[s["name"]]
                if "error" in j:
                    continue
                walk = st.get("walkMin") or 0
                arr = (datetime.strptime(j["arriveAt"], "%H:%M") + timedelta(minutes=walk)).strftime("%H:%M") if j.get("arriveAt") else ""
                waits = sum(1 for _ in j.get("legs", []))
                c["arrivalRoute"] = {
                    "transit": {"totalMin": (j.get("totalMin") or 0) + walk, "leaveAt": j.get("leaveAt"), "arriveAt": arr,
                                "summary": j.get("summary", "") + (f", walk {walk}" if walk else ""), "changes": j.get("changes"),
                                "legs": j.get("legs"), "source": "TfL Journey Planner"},
                    "taxi": taxi_est(pc[:2], (s["lat"], s["lon"])),
                    "verdict": ""}
            # shared first leg from the airport
            firsts = {}
            for j in by_station.values():
                if "error" in j or not j.get("legs"):
                    continue
                lg = next((l for l in j["legs"] if l["mode"] != "walking"), None)
                if lg:
                    firsts.setdefault((lg["summary"], lg["dep"]), lg)
            for lg in list(firsts.values())[:3]:
                airport_opts.append({"mode": lg["mode"].replace("-", " ").title(), "operator": lg["summary"], "departs": lg["dep"],
                                     "to": "", "arrives": lg["arr"], "frequency": "", "source": "TfL Journey Planner"})
            a_route = {"place": pc[2], "landing": arrival["datetime"], "readyAt": ready.strftime("%H:%M"), "bufferMin": buf,
                       "weekday": land.strftime("%A")}
        else:
            a_route = {"place": arrival.get("place"), "landing": arrival.get("datetime")}
    else:
        a_route = None

    # a price far below the rest of this search is often an error, a scam or a catch
    prices = sorted(c["totalPrice"] for c in pool if c.get("totalPrice"))
    share = cfg.get("rules", {}).get("muchCheaperFlagBelowMedianShare")
    if share and len(prices) >= 4:
        median = prices[len(prices) // 2]
        for c in pool:
            flag = "Much cheaper than similar places: check carefully"
            if c.get("totalPrice") and c["totalPrice"] < median * share and flag not in (c.get("redFlags") or []):
                c.setdefault("redFlags", []).append(flag)

    # points (config/scoring.json → points)
    for c in pool:
        c["score"] = scoring.score(c, F, cfg)

    matches.sort(key=lambda c: -c["score"])
    near.sort(key=lambda c: -c["score"])
    rules = cfg.get("rules", {})
    matches, near = matches[: min(a.keep, rules.get("keepMatches", 8))], near[: rules.get("keepNearMisses", 4)]
    fastest = min((((c.get("arrivalRoute") or {}).get("transit") or {}).get("arriveAt") or "99") for c in matches + near) if (matches or near) else None
    for i, c in enumerate(matches):
        c["topPick"] = i == 0
    for c in matches + near:
        c["why"] = c.get("why") or draft_why(c, budget, cur, fastest)
        tr = (c.get("arrivalRoute") or {}).get("transit") or {}
        if tr and not c["arrivalRoute"].get("verdict"):
            c["arrivalRoute"]["verdict"] = ("Fastest of the set" if tr.get("arriveAt") == fastest else
                                            f"{tr.get('changes')} change{'s' if tr.get('changes') != 1 else ''}")
        c.setdefault("redFlags", [])

    R = {"query": F.get("query", ""), "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "filters": {k: v for k, v in F.items() if k not in ("query",)}, "slices": scouts,
         "listings": matches + near}
    if a_route:
        R["arrival"] = a_route
        R["airportOptions"] = airport_opts
        R["arrivalNotes"] = ("Routes from TfL's journey planner for that exact night, door times include the walk from the station. "
                             "Taxi fares are rough estimates. Re-check engineering works a few days before you fly.")
    save(Path(a.out), R)
    out({"out": a.out, "matches": len(matches), "nearMisses": len(near), "candidates": len(cands),
         "top": [{"id": c["id"], "score": c["score"], "total": c.get("totalPrice"), "station": (c.get("station") or {}).get("name"),
                  "why": c["why"]} for c in matches[:5]]})


def draft_why(c, budget, cur, fastest):
    parts = []
    tp = c.get("totalPrice")
    if budget and tp:
        parts.append(f"{money(cur, budget - tp)} under the cap" if tp <= budget else f"{money(cur, tp - budget)} over")
    st = c.get("station") or {}
    if st.get("name"):
        parts.append(f"{st.get('walkMin')} min to {st['name']}" + (f" (zone {st['zone']})" if st.get("zone") else ""))
    n = c.get("reviews") or 0
    parts.append(f"{n} reviews" + (f" ★{c['rating']}" if c.get("rating") and n else "") if n else "no reviews yet")
    lvl = (c.get("safety") or {}).get("level")
    if lvl in ("calmer", "busier"):
        parts.append(f"{lvl} area")
    s = ", ".join(parts)
    s = (s[:1].upper() + s[1:]) + "."
    tr = ((c.get("arrivalRoute") or {}).get("transit") or {})
    if tr.get("arriveAt"):
        s += f" Airport → door ~{tr['arriveAt']}."
    if c.get("reviewSummary"):
        s += " " + c["reviewSummary"].rstrip(".") + "."
    return s


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("near")
    n.add_argument("--in", dest="inp", required=True)
    n.add_argument("--max-walk", type=int, default=0); n.add_argument("--max-zone", type=int, default=0)
    n.add_argument("--min-zone", type=int, default=0); n.add_argument("--budget", type=float, default=0)
    n.add_argument("--min-beds", type=int, default=0); n.add_argument("--city", default="London")
    n.add_argument("--top", type=int, default=12)
    n.add_argument("--price-mode", default="cap", help="cap | cheaper | range | strict (how far over budget is still worth keeping)")
    c = sub.add_parser("cache")
    c.add_argument("op", choices=["get", "put"]); c.add_argument("args", nargs="+")
    r = sub.add_parser("rank")
    r.add_argument("--filters", required=True); r.add_argument("--scouts", required=True); r.add_argument("--out", required=True)
    r.add_argument("--keep", type=int, default=8); r.add_argument("--no-safety", action="store_true"); r.add_argument("--no-routes", action="store_true")
    t = sub.add_parser("route")
    t.add_argument("--from", dest="frm", required=True); t.add_argument("--date", required=True); t.add_argument("--time", required=True)
    t.add_argument("--station", action="append", default=[])
    a = ap.parse_args()
    if a.cmd == "near":
        cmd_near(a)
    elif a.cmd == "cache":
        if a.op == "get":
            out(cache_get(a.args))
        else:
            items = []
            for p in a.args:
                d = load(Path(p), [])
                items += d.get("candidates", []) if isinstance(d, dict) else d
            out({"saved": cache_put(items)})
    elif a.cmd == "rank":
        cmd_rank(a)
    elif a.cmd == "route":
        cmd_route(a)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
