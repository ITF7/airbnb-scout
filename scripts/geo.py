"""
Geography helpers for Airbnb Scout (London for now). Standard library only.

  py -3 scripts/geo.py stations [--refresh]
      Cache London Underground stations (name, lat, lon, zone, lines) from TfL to data/london_tube_stations.json.

  py -3 scripts/geo.py tiles --max-zone 3 [--min-zone 1] [--scouts 3] [--per-scout 14]
                             [--radius-m 650] [--base-url "<airbnb search url without map bounds>"]
      Plan a map sweep: one small map box per station (most central first), split into contiguous
      sectors, one per scout. With --base-url, each tile gets a ready Airbnb URL (search-as-I-move-the-map).

  py -3 scripts/geo.py safety --station "Stockwell" [--station "Pimlico" ...]
  py -3 scripts/geo.py safety --lat 51.47 --lon -0.12
      Street-crime counts within ~1 mile for the latest month published by data.police.uk
      (England & Wales only). Counts reflect footfall too, so compare areas, don't read them alone.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "london_tube_stations.json"
CENTRE = (51.5080, -0.1247)  # Charing Cross
UA = {"User-Agent": "AirbnbScout/1.0 (personal trip planner)"}


def get_json(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def dist_m(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def zone_min(z: str) -> int:
    nums = [int(x) for x in str(z).replace("+", "/").split("/") if x.strip().isdigit()]
    return min(nums) if nums else 99


# ---------------------------------------------------------------- stations

def load_stations(refresh: bool = False) -> list[dict]:
    if CACHE.exists() and not refresh:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    data = get_json("https://api.tfl.gov.uk/StopPoint/Mode/tube")
    out = []
    for sp in data.get("stopPoints", []):
        if sp.get("stopType") != "NaptanMetroStation":
            continue
        zone = next((p.get("value") for p in sp.get("additionalProperties", []) if p.get("key") == "Zone"), "")
        lines = sorted({l.get("name") for l in sp.get("lines", []) if l.get("name")})
        name = sp.get("commonName", "").replace(" Underground Station", "").strip()
        out.append({"name": name, "lat": sp["lat"], "lon": sp["lon"], "zone": zone, "lines": lines})
    out.sort(key=lambda s: s["name"])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def find_station(stations, name: str) -> dict | None:
    n = name.lower().replace("station", "").replace("underground", "").strip()
    exact = [s for s in stations if s["name"].lower() == n]
    if exact:
        return exact[0]
    part = [s for s in stations if n in s["name"].lower()]
    return part[0] if part else None


# ---------------------------------------------------------------- tiles

def box(lat, lon, r_m):
    dlat = r_m / 111320
    dlon = r_m / (111320 * math.cos(math.radians(lat)))
    return {"ne_lat": round(lat + dlat, 5), "ne_lng": round(lon + dlon, 5),
            "sw_lat": round(lat - dlat, 5), "sw_lng": round(lon - dlon, 5)}


def with_bounds(base_url: str, b: dict) -> str:
    p = urllib.parse.urlsplit(base_url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
         if k not in ("ne_lat", "ne_lng", "sw_lat", "sw_lng", "search_by_map", "search_type", "zoom_level")]
    q += [("ne_lat", b["ne_lat"]), ("ne_lng", b["ne_lng"]), ("sw_lat", b["sw_lat"]), ("sw_lng", b["sw_lng"]),
          ("search_by_map", "true"), ("search_type", "user_map_move"), ("zoom_level", "15")]
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, urllib.parse.urlencode(q, safe="[]/"), ""))


def plan_tiles(max_zone, min_zone, scouts, per_scout, radius_m, base_url):
    st = [s for s in load_stations() if min_zone <= zone_min(s["zone"]) <= max_zone]
    st.sort(key=lambda s: (zone_min(s["zone"]), dist_m(CENTRE, (s["lat"], s["lon"]))))
    picked = []
    for s in st:  # skip stations whose box is mostly covered by an already-picked neighbour
        if all(dist_m((s["lat"], s["lon"]), (p["lat"], p["lon"])) > radius_m * 0.9 for p in picked):
            picked.append(s)
    # contiguous, equal-sized sectors around the centre, one per scout
    def ang(s):
        return math.degrees(math.atan2(s["lat"] - CENTRE[0], (s["lon"] - CENTRE[1]) * math.cos(math.radians(CENTRE[0])))) % 360
    by_angle = sorted(picked, key=ang)
    size = math.ceil(len(by_angle) / scouts) if by_angle else 0
    sectors = [by_angle[i * size:(i + 1) * size] for i in range(scouts)]
    names = ["East", "North-east", "North", "North-west", "West", "South-west", "South", "South-east"]
    out = []
    for i, sec in enumerate(sectors):
        sec.sort(key=lambda s: (zone_min(s["zone"]), dist_m(CENTRE, (s["lat"], s["lon"]))))
        if sec:
            angs = sorted(ang(s) for s in sec)
            mid = angs[len(angs) // 2]
        else:
            mid = 0
        label = names[int(((mid + 22.5) % 360) // 45)]
        tiles = []
        for s in sec[:per_scout]:
            b = box(s["lat"], s["lon"], radius_m)
            t = {"station": s["name"], "zone": s["zone"], "lines": s["lines"], **b}
            if base_url:
                t["url"] = with_bounds(base_url, b)
            tiles.append(t)
        sector = {"scout": i + 1, "sector": label, "tiles": tiles, "remaining": max(0, len(sec) - per_scout)}
        if sec:  # one wide box over the whole sector (all its stations), for the first, cheap pass
            pad = radius_m
            lats = [s["lat"] for s in sec]; lons = [s["lon"] for s in sec]
            nb = box(max(lats), max(lons), pad); sb = box(min(lats), min(lons), pad)
            wide = {"ne_lat": nb["ne_lat"], "ne_lng": nb["ne_lng"], "sw_lat": sb["sw_lat"], "sw_lng": sb["sw_lng"]}
            sector["wideBox"] = wide
            if base_url:
                sector["wideUrl"] = with_bounds(base_url, wide).replace("zoom_level=15", "zoom_level=12")
        out.append(sector)
    return {"maxZone": max_zone, "radiusM": radius_m, "stationsInRange": len(st), "tilesPlanned": sum(len(o["tiles"]) for o in out), "scouts": out}


# ---------------------------------------------------------------- city centres

CENTRES = ROOT / "data" / "city_centres.json"


def city_centre(place: str):
    """(lat, lon) of a city's centre from OpenStreetMap (free; one request per city, then cached)."""
    key = place.strip().lower()
    if not key:
        return None
    cache = json.loads(CENTRES.read_text(encoding="utf-8")) if CENTRES.exists() else {}
    if key in cache:
        return tuple(cache[key]) if cache[key] else None
    try:
        url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + urllib.parse.quote(place)
        res = get_json(url, timeout=30)
        hit = (float(res[0]["lat"]), float(res[0]["lon"])) if res else None
    except Exception:  # noqa: BLE001
        return None
    cache[key] = list(hit) if hit else None
    CENTRES.parent.mkdir(parents=True, exist_ok=True)
    CENTRES.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return hit


# ---------------------------------------------------------------- safety

NIGHT_CATS = ("violent-crime", "robbery", "theft-from-the-person", "public-order", "possession-of-weapons")


def latest_month() -> str:
    dates = get_json("https://data.police.uk/api/crimes-street-dates")
    return dates[0]["date"]


def safety_at(lat, lon, month):
    url = f"https://data.police.uk/api/crimes-street/all-crime?lat={lat:.5f}&lng={lon:.5f}&date={month}"
    crimes = get_json(url, timeout=90)
    counts = {}
    for c in crimes:
        counts[c["category"]] = counts.get(c["category"], 0) + 1
    street = sum(counts.get(k, 0) for k in NIGHT_CATS)
    return {"month": month, "total": len(crimes), "streetCrime": street,
            "breakdown": {k: counts.get(k, 0) for k in NIGHT_CATS}}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("stations"); a.add_argument("--refresh", action="store_true")
    t = sub.add_parser("tiles")
    t.add_argument("--max-zone", type=int, default=2); t.add_argument("--min-zone", type=int, default=1)
    t.add_argument("--scouts", type=int, default=3); t.add_argument("--per-scout", type=int, default=14)
    t.add_argument("--radius-m", type=int, default=650); t.add_argument("--base-url", default="")
    s = sub.add_parser("safety")
    s.add_argument("--station", action="append", default=[]); s.add_argument("--lat", type=float); s.add_argument("--lon", type=float)
    args = ap.parse_args()

    if args.cmd == "stations":
        st = load_stations(args.refresh)
        print(json.dumps({"stations": len(st), "cache": str(CACHE)}))
    elif args.cmd == "tiles":
        print(json.dumps(plan_tiles(args.max_zone, args.min_zone, max(1, min(4, args.scouts)), args.per_scout, args.radius_m, args.base_url), ensure_ascii=False, indent=1))
    elif args.cmd == "safety":
        month = latest_month()
        res = []
        points = []
        stations = load_stations() if args.station else []
        for name in args.station:
            s = find_station(stations, name)
            if s:
                points.append((s["name"], s["zone"], s["lat"], s["lon"]))
            else:
                res.append({"station": name, "error": "not found"})
        if args.lat is not None and args.lon is not None:
            points.append((f"{args.lat},{args.lon}", "", args.lat, args.lon))
        for name, zone, lat, lon in points:
            try:
                res.append({"station": name, "zone": zone, **safety_at(lat, lon, month)})
            except Exception as e:  # noqa: BLE001
                res.append({"station": name, "error": str(e)[:200]})
        print(json.dumps({"source": "data.police.uk street-level crime, ~1 mile radius", "results": res}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
