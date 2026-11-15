// Scout pipeline for the extension (no server): build the Airbnb search link, shortlist the result cards,
// then rank the checked listings with the same rules and points as the Python version.
"use strict";

const Rank = (() => {
  let CFG = null;
  async function config() {
    if (!CFG) CFG = await (await fetch(chrome.runtime.getURL("config/scoring.json"))).json();
    return CFG;
  }
  const CAPPED_CITIES = ["london", "amsterdam", "paris", "barcelona", "new york", "berlin", "lisbon", "edinburgh"];
  const AMENITY_IDS = { selfCheckIn: 51, wifi: 4, kitchen: 8, freeParking: 9, washer: 33, airConditioning: 5, workspace: 47, pool: 7 };

  function box(lat, lon, r) {
    const dlat = r / 111320, dlon = r / (111320 * Math.cos(lat * Math.PI / 180));
    return { ne_lat: +(lat + dlat).toFixed(5), ne_lng: +(lon + dlon).toFixed(5), sw_lat: +(lat - dlat).toFixed(5), sw_lng: +(lon - dlon).toFixed(5) };
  }
  async function searchUrl(f) {
    const slug = (f.location || "").split(",").map(p => p.trim()).filter(Boolean).map(p => encodeURIComponent(p.replace(/ /g, "-"))).join("--") || "homes";
    const u = new URL(`https://www.airbnb.com/s/${slug}/homes`);
    const q = u.searchParams;
    q.set("checkin", f.checkin); q.set("checkout", f.checkout); q.set("adults", f.guests || 2);
    if (f.minBeds) q.set("min_beds", f.minBeds);
    if (f.minBedrooms) q.set("min_bedrooms", f.minBedrooms);
    if (f.entirePlace !== false) {
      q.append("room_types[]", "Entire home/apt");
      if (CAPPED_CITIES.some(c => (f.location || "").toLowerCase().includes(c))) q.append("room_types[]", "Private room");
    }
    if (f.budgetTotal && f.nights) { q.set("price_max", Math.round(f.budgetTotal)); q.set("price_filter_num_nights", f.nights); }
    const ams = [...new Set([...(f.selfCheckIn ? ["selfCheckIn"] : []), ...(f.amenities || [])])];
    for (const a of ams) if (AMENITY_IDS[a]) q.append("amenities[]", AMENITY_IDS[a]);
    q.set("currency", f.currency || "USD"); q.set("locale", "en");
    const g = f.geography || {};
    if (Geo.isLondon(f.location) && g.maxZone) {
      const st = (await Geo.loadStations()).filter(s => (g.minZone || 1) <= Scoring.zoneMin(s.zone) && Scoring.zoneMin(s.zone) <= g.maxZone);
      if (st.length) {
        const nb = box(Math.max(...st.map(s => s.lat)), Math.max(...st.map(s => s.lon)), 900), sb = box(Math.min(...st.map(s => s.lat)), Math.min(...st.map(s => s.lon)), 900);
        q.set("ne_lat", nb.ne_lat); q.set("ne_lng", nb.ne_lng); q.set("sw_lat", sb.sw_lat); q.set("sw_lng", sb.sw_lng);
        q.set("search_by_map", "true"); q.set("search_type", "user_map_move"); q.set("zoom_level", "11");
      }
    }
    return u.toString();
  }
  function prepare(f) {
    if (!f.location || !f.checkin || !f.checkout) return { needsInfo: "Add where you're going and both dates." };
    f.nights = Math.round((new Date(f.checkout) - new Date(f.checkin)) / 86400e3);
    if (!(f.nights >= 1)) return { needsInfo: "Check-out needs to be after check-in." };
    const must = (f.mustHaves || []).filter(m => !/self check|entire|whole place/i.test(m));
    if (f.selfCheckIn) must.push("Self check-in");
    if (f.entirePlace !== false) must.push("Entire place");
    f.mustHaves = must;
    f.propertyType = f.entirePlace !== false ? "Entire place" : "Any";
    return { filters: f };
  }

  // ---------------------------------------------------------------- listing facts cache (no prices, 30 days)
  async function cacheGet(ids) {
    const keys = ids.map(i => "listing:" + i);
    try {
      const got = await chrome.storage.local.get(keys);
      const out = {};
      for (const i of ids) { const v = got["listing:" + i]; if (v && Date.now() - v.t < 30 * 86400e3) out[i] = v.v; }
      return out;
    } catch (e) { return {}; }
  }
  async function cachePut(items) {
    const keep = ["title", "propertyType", "listedAs", "effectivelyEntire", "entireEvidence", "beds", "bedrooms", "maxGuests",
                  "lastReviewDate", "reviewSummary", "reviewIssues", "hostNotes", "checkIn", "cancellation", "redFlags", "seriousFlags"];
    const obj = {};
    for (const it of items) { const v = {}; for (const k of keep) if (it[k] != null && it[k] !== "") v[k] = it[k]; obj["listing:" + it.id] = { t: Date.now(), v }; }
    try { await chrome.storage.local.set(obj); } catch (e) {}
  }

  // ---------------------------------------------------------------- shortlist from search cards
  async function shortlist(f, cards, top = 5) {
    const cfg = await config();
    const london = Geo.isLondon(f.location);
    if (london) await Geo.loadStations();
    const allow = Scoring.overBudgetAllowance(f, cfg), g = f.geography || {};
    const dropped = { price: 0, beds: 0, walk: 0, zone: 0 }, keep = [];
    for (const c of cards) {
      if (f.budgetTotal && c.total && c.total > f.budgetTotal * (1 + allow)) { dropped.price++; continue; }
      if (f.minBeds && c.beds != null && c.beds < f.minBeds) { dropped.beds++; continue; }
      const st = london && c.lat != null ? Geo.nearestStation(c.lat, c.lon) : null;
      if (st) {
        if (f.maxWalkMin && st.walkMin > Scoring.walkCutoff(f.maxWalkMin, cfg)) { dropped.walk++; continue; }
        const z = Scoring.zoneMin(st.zone);
        if ((g.maxZone && z > g.maxZone) || (g.minZone && z < g.minZone)) { dropped.zone++; continue; }
      }
      let pre = 0;
      if (f.budgetTotal && c.total) pre += Scoring.pricePoints(c.total, f, cfg);
      pre += Scoring.reviewPoints(c.reviews, cfg.points.reviewCount.bands);
      const rp = cfg.points.rating;
      if ((c.reviews || 0) >= rp.minReviews && c.rating) { const d = c.rating - rp.neutralAt; pre += d * (d >= 0 ? rp.perStarAbove : rp.perStarBelow); }
      if (st) { pre += Scoring.walkPoints(st.walkMin, f.maxWalkMin, cfg); const z = Scoring.zoneMin(st.zone); pre += z === 1 ? cfg.points.centrality.zone1 : z === 2 ? cfg.points.centrality.zone2 : 0; }
      keep.push({ ...c, station: st, pre: Math.round(pre * 10) / 10 });
    }
    keep.sort((a, b) => b.pre - a.pre);
    const open = keep.slice(0, 12);
    const cached = await cacheGet(open.map(r => r.id));
    for (const r of open) r.cachedFacts = !!(cached[r.id] && cached[r.id].reviewSummary);
    return { cards: cards.length, kept: keep.length, dropped, open, check: open.filter(r => !r.cachedFacts).slice(0, top).map(r => r.id) };
  }

  // ---------------------------------------------------------------- rank
  function draftWhy(c, f, fastest) {
    const parts = [], tp = c.totalPrice, cur = f.currency;
    if (f.budgetTotal && tp) parts.push(tp <= f.budgetTotal ? `${Scoring.money(cur, f.budgetTotal - tp)} under the cap` : `${Scoring.money(cur, tp - f.budgetTotal)} over`);
    const st = c.station || {};
    if (st.name) parts.push(`${st.walkMin} min to ${st.name}${st.zone ? ` (zone ${st.zone})` : ""}`);
    else if (c.centreKm != null) parts.push(`${c.centreKm} km from the centre`);
    const n = c.reviews || 0;
    parts.push(n ? `${n} reviews${c.rating ? " ★" + c.rating : ""}` : "no reviews yet");
    const lvl = (c.safety || {}).level;
    if (lvl === "calmer" || lvl === "busier") parts.push(`${lvl} area`);
    let s = parts.join(", "); s = s.charAt(0).toUpperCase() + s.slice(1) + ".";
    const tr = (c.arrivalRoute || {}).transit || {};
    if (tr.arriveAt) s += ` Airport → door ~${tr.arriveAt}.`;
    if (c.reviewSummary) s += " " + c.reviewSummary.replace(/\.$/, "") + ".";
    return s;
  }

  async function rank(f, cardsById, judged, cachedIds, onStep = () => {}) {
    const cfg = await config();
    const london = Geo.isLondon(f.location);
    if (london) await Geo.loadStations();
    const cached = await cacheGet(cachedIds || []);
    await cachePut(judged);
    const byId = Object.fromEntries(judged.map(j => [String(j.id), j]));
    const pool = [];
    for (const [id, card] of Object.entries(cardsById)) {
      const j = byId[id] || (cached[id] ? { ...cached[id], id } : null);
      if (!j) continue;
      const c = { id, url: `https://www.airbnb.com/rooms/${id}?check_in=${f.checkin}&check_out=${f.checkout}&adults=${f.guests || 2}&locale=en`,
        title: j.title || card.name, image: j.image || card.image, area: card.area, lat: card.lat, lon: card.lon,
        totalPrice: j.totalPrice || card.total, currency: f.currency, rating: j.rating ?? card.rating, reviews: j.reviews ?? card.reviews,
        superhost: (card.badges || []).includes("Superhost"), station: card.station || null, ...j };
      c.title = c.title || card.name; c.totalPrice = j.totalPrice || card.total;
      c.station = card.station || j.station || null;   // the map-based station wins over anything merged in
      c.lat = card.lat; c.lon = card.lon; c.area = card.area || j.area;
      if (c.totalPrice && f.nights) c.perNight = Math.round(c.totalPrice / f.nights);
      pool.push(c);
    }
    const ctx = { london, isTubeStation: n => !!Geo.findStation(n) };
    let matches = [], near = [];
    for (const c of pool) {
      const [verdict, reasons, checks] = Scoring.classify(c, f, cfg, ctx);
      if (verdict === "drop") continue;
      c.checks = checks;
      if (verdict === "near") { c.nearMiss = true; c.nearMissReason = reasons.join("; "); near.push(c); } else { c.nearMiss = false; matches.push(c); }
    }
    const shown = [...matches, ...near];

    // much cheaper than the rest of this search
    const prices = shown.map(c => c.totalPrice).filter(Boolean).sort((a, b) => a - b), share = cfg.rules.muchCheaperFlagBelowMedianShare;
    if (share && prices.length >= 4) {
      const median = prices[Math.floor(prices.length / 2)], flag = "Much cheaper than similar places: check carefully";
      for (const c of shown) if (c.totalPrice && c.totalPrice < median * share && !(c.redFlags || []).includes(flag)) (c.redFlags = c.redFlags || []).push(flag);
    }

    // safety: police street crime around each station (England & Wales)
    if (london) {
      onStep("Checking street crime around each station (police data)");
      for (const c of shown) {
        const s = c.station && Geo.findStation(c.station.name);
        if (!s) continue;
        try { const sc = await Geo.streetCrime(s.lat, s.lon); c.safety = { ...(c.safety || {}), streetCrime: sc.streetCrime, month: sc.month }; } catch (e) {}
      }
      Scoring.assignSafetyLevels(shown, cfg);
    } else {
      const centre = await Geo.cityCentre(f.location).catch(() => null);
      if (centre) for (const c of shown) if (c.lat != null) c.centreKm = Math.round(Geo.distM(centre, [c.lat, c.lon]) / 100) / 10;
    }

    // arrival routes per station (TfL)
    let arrival = null, airportOptions = [];
    const A = f.arrival || {};
    if (A.datetime && london) {
      const pc = Geo.placeCoords(A.place);
      if (pc) {
        onStep("Working out routes from your arrival point (TfL)");
        const land = new Date(A.datetime), buf = (A.type || "flight") === "flight" ? 45 : 10, ready = new Date(land.getTime() + buf * 60e3);
        const pad = n => String(n).padStart(2, "0");
        const date = `${ready.getFullYear()}${pad(ready.getMonth() + 1)}${pad(ready.getDate())}`, hhmm = `${pad(ready.getHours())}${pad(ready.getMinutes())}`;
        const byStation = {};
        for (const c of [...shown].sort((a, b) => (a.totalPrice || 9e9) - (b.totalPrice || 9e9))) {
          const s = c.station && Geo.findStation(c.station.name);
          if (!s) continue;
          if (!(s.name in byStation)) byStation[s.name] = await Geo.tflJourney(pc, [s.lat, s.lon], date, hhmm).catch(() => null);
          const j = byStation[s.name];
          if (!j) continue;
          const walk = c.station.walkMin || 0;
          const [h, m] = (j.arriveAt || "00:00").split(":").map(Number), t = new Date(2000, 0, 1, h, m + walk);
          c.arrivalRoute = { transit: { totalMin: (j.totalMin || 0) + walk, leaveAt: j.leaveAt, arriveAt: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
                                        summary: j.summary + (walk ? `, walk ${walk}` : ""), changes: j.changes, legs: j.legs, source: "TfL Journey Planner" },
                             taxi: Geo.taxiEstimate(pc, [s.lat, s.lon]), verdict: "" };
        }
        const firsts = new Map();
        for (const j of Object.values(byStation)) { const lg = j && (j.legs || []).find(l => l.mode !== "walking"); if (lg && !firsts.has(lg.summary + lg.dep)) firsts.set(lg.summary + lg.dep, lg); }
        airportOptions = [...firsts.values()].slice(0, 3).map(lg => ({ mode: lg.mode.replace(/-/g, " "), operator: lg.summary, departs: lg.dep, arrives: lg.arr, source: "TfL Journey Planner" }));
        arrival = { place: pc[2], landing: A.datetime, readyAt: `${pad(ready.getHours())}:${pad(ready.getMinutes())}`, bufferMin: buf };
      }
    }

    for (const c of shown) { c.score = Scoring.score(c, f, cfg); c.breakdown = Scoring.breakdown(c, f, cfg).map(([k, v]) => [k, Math.round(v * 10) / 10]); }
    matches.sort((a, b) => b.score - a.score); near.sort((a, b) => b.score - a.score);
    matches = matches.slice(0, cfg.rules.keepMatches || 8); near = near.slice(0, cfg.rules.keepNearMisses || 4);
    const all = [...matches, ...near];
    const fastest = all.map(c => ((c.arrivalRoute || {}).transit || {}).arriveAt).filter(Boolean).sort()[0];
    matches.forEach((c, i) => { c.topPick = i === 0; });
    for (const c of all) {
      c.why = c.why || draftWhy(c, f, fastest);
      const tr = (c.arrivalRoute || {}).transit;
      if (tr && !c.arrivalRoute.verdict) c.arrivalRoute.verdict = tr.arriveAt === fastest ? "Fastest of the set" : `${tr.changes} change${tr.changes === 1 ? "" : "s"}`;
      c.redFlags = c.redFlags || [];
    }
    const out = { query: f.query || "", generatedAt: new Date().toISOString(), filters: f, listings: all };
    if (arrival) { out.arrival = arrival; out.airportOptions = airportOptions; out.arrivalNotes = "Routes from TfL's journey planner for that night; door times include the walk from the station. Taxi fares are rough estimates."; }
    return out;
  }

  return { config, searchUrl, prepare, shortlist, rank };
})();
