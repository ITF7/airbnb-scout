// Scout geography for the extension: stations and walk times (London tube data bundled), police street-crime
// counts (data.police.uk), TfL journeys and city centres (OpenStreetMap). All free public services, called
// directly from the user's browser, cached in chrome.storage.local so repeat searches don't ask again.
"use strict";

const Geo = (() => {
  const WALK_M_PER_MIN = 80, WALK_DETOUR = 1.3;
  const PLACES = {
    LGW: [51.1565, -0.1610, "London Gatwick Airport (LGW)"], LHR: [51.4700, -0.4543, "London Heathrow Airport (LHR)"],
    STN: [51.8860, 0.2389, "London Stansted Airport (STN)"], LTN: [51.8747, -0.3683, "London Luton Airport (LTN)"],
    LCY: [51.5048, 0.0495, "London City Airport (LCY)"], STP: [51.5320, -0.1263, "London St Pancras International"]
  };
  let stations = null;

  async function loadStations() {
    if (!stations) stations = await (await fetch(chrome.runtime.getURL("data/london_tube_stations.json"))).json();
    return stations;
  }
  const distM = (a, b) => {
    const r = x => x * Math.PI / 180;
    const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  const isLondon = loc => !loc || /london/i.test(loc);
  function nearestStation(lat, lon) {
    let best = null, bd = Infinity;
    for (const s of stations || []) { const d = distM([lat, lon], [s.lat, s.lon]); if (d < bd) { best = s; bd = d; } }
    if (!best) return null;
    return { name: best.name, zone: best.zone, lines: best.lines, walkMin: Math.max(1, Math.round(bd * WALK_DETOUR / WALK_M_PER_MIN)),
             approx: true, lat: best.lat, lon: best.lon, type: `Tube · ${best.lines.slice(0, 2).join(", ")} · Zone ${best.zone}` };
  }
  function findStation(name) {
    const n = String(name || "").toLowerCase().replace("station", "").replace("underground", "").trim();
    return (stations || []).find(s => s.name.toLowerCase() === n) || (stations || []).find(s => s.name.toLowerCase().includes(n)) || null;
  }

  // small cache in chrome.storage.local
  async function cached(key, maxAgeDays, fn) {
    const k = "cache:" + key;
    try {
      const got = (await chrome.storage.local.get(k))[k];
      if (got && Date.now() - got.t < maxAgeDays * 86400e3) return got.v;
    } catch (e) {}
    const v = await fn();
    if (v != null) try { await chrome.storage.local.set({ [k]: { t: Date.now(), v } }); } catch (e) {}
    return v;
  }
  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
    return r.json();
  }

  // police street crime within ~1 mile, latest month (England & Wales)
  const NIGHT_CATS = ["violent-crime", "robbery", "theft-from-the-person", "public-order", "possession-of-weapons"];
  async function latestMonth() { return cached("police-month", 7, async () => (await getJson("https://data.police.uk/api/crimes-street-dates"))[0].date); }
  async function streetCrime(lat, lon) {
    const month = await latestMonth();
    return cached(`police:${month}:${lat.toFixed(3)},${lon.toFixed(3)}`, 60, async () => {
      const crimes = await getJson(`https://data.police.uk/api/crimes-street/all-crime?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&date=${month}`);
      return { streetCrime: crimes.filter(c => NIGHT_CATS.includes(c.category)).length, month };
    });
  }

  // TfL journey planner (free, no key needed for light use)
  function placeCoords(p) {
    p = String(p || "");
    for (const [code, v] of Object.entries(PLACES)) if (new RegExp(`\\b${code}\\b`, "i").test(p) || p.toLowerCase().includes(v[2].toLowerCase())) return v;
    for (const [word, code] of [["gatwick", "LGW"], ["heathrow", "LHR"], ["stansted", "STN"], ["luton", "LTN"], ["city airport", "LCY"], ["st pancras", "STP"]])
      if (p.toLowerCase().includes(word)) return PLACES[code];
    const s = findStation(p);
    return s ? [s.lat, s.lon, s.name] : null;
  }
  async function tflJourney(from, to, date, hhmm) {
    const key = `tfl:${from[0].toFixed(4)},${from[1].toFixed(4)}>${to[0].toFixed(4)},${to[1].toFixed(4)}@${date}${hhmm}`;
    return cached(key, 14, async () => {
      const d = await getJson(`https://api.tfl.gov.uk/Journey/JourneyResults/${from[0].toFixed(5)},${from[1].toFixed(5)}/to/${to[0].toFixed(5)},${to[1].toFixed(5)}?date=${date}&time=${hhmm}&timeIs=Departing&journeyPreference=leasttime`);
      const js = d.journeys || [];
      if (!js.length) return null;
      const best = js.reduce((a, b) => (a.arrivalDateTime <= b.arrivalDateTime ? a : b));
      const legs = (best.legs || []).map(lg => ({ mode: (lg.mode || {}).name || "", summary: (lg.instruction || {}).summary || "",
        dep: (lg.departureTime || "").slice(11, 16), arr: (lg.arrivalTime || "").slice(11, 16), min: lg.duration }));
      const ride = legs.filter(l => l.mode !== "walking");
      return { leaveAt: (best.startDateTime || "").slice(11, 16), arriveAt: (best.arrivalDateTime || "").slice(11, 16), totalMin: best.duration,
               changes: Math.max(0, ride.length - 1), legs, summary: ride.map(l => l.summary).join(" → ") || "Walk" };
    });
  }
  function taxiEstimate(from, to) {
    const km = distM(from, to) / 1000 * 1.35;
    const lo = Math.round((20 + 1.6 * km) / 5) * 5, hi = Math.round((30 + 2.3 * km) / 5) * 5;
    return { minutes: Math.round(km / 65 * 60 + 8), fare: `£${lo}–${hi} (est.)` };
  }

  // city centre from OpenStreetMap (one request per city, then cached)
  async function cityCentre(place) {
    if (!place) return null;
    return cached("centre:" + place.toLowerCase(), 365, async () => {
      const res = await getJson("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(place));
      return res && res[0] ? [Number(res[0].lat), Number(res[0].lon)] : null;
    });
  }

  return { loadStations, nearestStation, findStation, isLondon, distM, streetCrime, placeCoords, tflJourney, taxiEstimate, cityCentre };
})();
