// Scout scoring for the extension: a line-for-line port of scripts/scoring.py, driven by config/scoring.json
// (copied into extension/config/). The self-test checks both give the same scores.
"use strict";

const Scoring = (() => {
  const zoneMin = z => {
    const nums = String(z || "").replace(/\+/g, "/").split("/").map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(Number);
    return nums.length ? Math.min(...nums) : 99;
  };
  const money = (cur, v) => {
    const sym = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" }[(cur || "").toUpperCase()] || "";
    const n = Math.round(v).toLocaleString("en-US");
    return sym ? sym + n : `${n} ${cur}`;
  };
  // Python's round(): halves go to the even neighbour (keeps scores identical to the Python version)
  const pyRound = x => { const f = Math.floor(x), d = x - f; if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1; return Math.round(x); };

  const isLate = (F, cfg) => {
    const a = (F.arrival || {}).datetime;
    if (!a) return false;
    const h = Number(String(a).slice(11, 13));
    if (Number.isNaN(h)) return false;
    const r = cfg.rules || {};
    return h < (r.lateArrivalBeforeHour ?? 6) || h >= (r.lateArrivalFromHour ?? 22);
  };
  const needsSelfCheckin = F => !!F.selfCheckIn || (F.mustHaves || []).some(m => String(m).toLowerCase().includes("self check"));
  const priceMode = F => { const m = String(F.priceMode || "cap").toLowerCase(); return ["cap", "cheaper", "range", "strict"].includes(m) ? m : "cap"; };
  const overBudgetAllowance = (F, cfg) => {
    const o = (cfg.rules || {}).overBudgetNearMissUpTo ?? 0.05;
    if (typeof o === "object") return o[priceMode(F)] ?? o.cap ?? 0.05;
    return priceMode(F) === "strict" ? 0 : o;
  };
  const walkCutoff = (limit, cfg) => { const r = cfg.rules || {}; return "walkNearMissUpToShare" in r ? limit * r.walkNearMissUpToShare : limit + (r.walkNearMissExtraMin ?? 6); };

  function classify(c, F, cfg, ctx = {}) {
    const r = cfg.rules || {};
    const budget = F.budgetTotal, cur = F.currency || "";
    const maxWalk = F.maxWalkMin, minBeds = F.minBeds;
    const maxZone = (F.geography || {}).maxZone;
    const late = isLate(F, cfg), needSelf = needsSelfCheckin(F);
    const reasons = [];
    const tp = c.totalPrice;
    if (c.unavailable) return ["drop", ["Not available for your dates"], []];
    if (budget && tp) {
      if (tp > budget * (1 + overBudgetAllowance(F, cfg))) return ["drop", ["Over budget"], []];
      if (tp > budget) reasons.push(`${money(cur, tp - budget)} over budget`);
    }
    if (minBeds && c.beds != null && c.beds < minBeds) return ["drop", ["Too few beds"], []];
    const low = r.nearMissBelowRating;
    if (low && c.rating && (c.reviews || 0) >= (((cfg.points || {}).rating || {}).minReviews ?? 3) && c.rating < low)
      reasons.push(`Rated ${c.rating}★, below ${low}★`);
    const ee = c.effectivelyEntire === undefined ? true : c.effectivelyEntire;
    if (ee === false) return ["drop", ["Shared, not the whole place"], []];
    if (ee === "unclear") reasons.push("Not clear you get the whole place");
    const st = c.station || {};
    if (maxWalk && st.walkMin != null && st.walkMin > maxWalk) {
      if (st.walkMin > walkCutoff(maxWalk, cfg)) return ["drop", ["Too far from transit"], []];
      reasons.push(`${st.walkMin} min walk to the tube`);
    }
    if (ctx.london && st.name && ctx.isTubeStation && !ctx.isTubeStation(st.name)) reasons.push(`${st.name} isn't a tube station`);
    const z = c.station ? zoneMin(st.zone) : 99;
    if (maxZone && z !== 99 && z > maxZone) reasons.push(`Zone ${st.zone}`);
    const ci = c.checkIn || {};
    const selfCi = ci.selfCheckIn;
    if (needSelf && selfCi === false) return ["drop", ["No self check-in"], []];
    const desk24 = String(ci.method || "").includes("24");
    if (late && selfCi === false && !desk24) reasons.push("Key pickup won't work for a late arrival");
    const until = String(ci.until || "").trim();
    let lateWindowOk = true;
    if (late && /^\d{1,2}:\d{2}$/.test(until)) {
      const uh = Number(until.split(":")[0]);
      if (!(uh > 0 && uh < 12)) { lateWindowOk = false; reasons.push(`Check-in ends ${until}, before your arrival`); }
    }
    let checks = [];
    if (budget && tp) checks.push({ label: `≤ ${money(cur, budget)}`, pass: tp <= budget });
    if (minBeds) checks.push({ label: `≥ ${minBeds} beds`, pass: (c.beds || 0) >= minBeds });
    checks.push({ label: "Entire place", pass: ee === true });
    if (maxWalk && st.walkMin != null) checks.push({ label: `Tube ≤${maxWalk} min`, pass: st.walkMin <= maxWalk });
    if (maxZone && z !== 99) checks.push({ label: `Zone ≤ ${maxZone}`, pass: z <= maxZone });
    if (needSelf) checks.push({ label: "Self check-in", pass: !!selfCi });
    if (late) checks.push({ label: "Late check-in OK", pass: (!!selfCi || desk24) && lateWindowOk });
    const own = new Set(checks.map(x => x.label));
    checks = checks.concat((c.checks || []).filter(x => !own.has(x.label) && !["beds", "₪", "budget", "Tube", "Zone", "Self", "Entire", "Late check-in"].some(w => String(x.label || "").includes(w))));
    return [reasons.length ? "near" : "match", reasons, checks];
  }

  const reviewPoints = (n, bands) => { let pts = 0; for (const [atLeast, p] of [...bands].sort((a, b) => a[0] - b[0])) if ((n || 0) >= atLeast) pts = p; return pts; };
  const bandPoints = (share, bands) => { for (const [lim, p] of [...bands].sort((a, b) => a[0] - b[0])) if (share <= lim + 1e-9) return p; return 0; };
  const smoothBandPoints = (share, bands) => {
    const b = [...bands].sort((x, y) => x[0] - y[0]);
    if (share <= b[0][0]) return b[0][1];
    for (let i = 0; i < b.length - 1; i++) {
      const [s0, p0] = b[i], [s1, p1] = b[i + 1];
      if (share <= s1) return p0 + (p1 - p0) * (share - s0) / (s1 - s0);
    }
    return 0;
  };
  function pricePoints(tp, F, cfg) {
    const p = cfg.points.price, budget = F.budgetTotal;
    if (tp > budget) return 0;
    const mode = priceMode(F);
    if (mode === "range") {
      const rg = p.range, low = F.budgetMin || budget * (rg.aroundMeansFromShare ?? 0.85);
      return tp >= low ? rg.insideRange : smoothBandPoints(tp / low, rg.belowRange);
    }
    return smoothBandPoints(tp / budget, p[mode === "cheaper" ? "cheaper" : "cap"]);
  }
  function walkPoints(walkMin, limit, cfg) {
    const w = cfg.points.walk;
    limit = limit || w.defaultLimitMin || 10;
    const bands = [...w.bands].sort((a, b) => a[0] - b[0]);
    if (walkMin <= Math.max(w.fullWithinAtLeastMin || 0, bands[0][0] * limit)) return bands[0][1];
    for (const [share, pts] of bands) if (walkMin <= share * limit + 1e-9) return pts;
    return 0;
  }
  const safetyAsked = F => {
    const words = [...(F.mustHaves || []), ...(F.niceToHaves || [])].join(" ").toLowerCase();
    return !!F.safeAtNight || words.includes("safe") || words.includes("neighbo");
  };
  const safetyPoints = (level, F, cfg) => {
    const sp = cfg.points.safety || {};
    if (!level) return 0;
    if ("whenAsked" in sp) return (sp[safetyAsked(F) ? "whenAsked" : "otherwise"] || {})[level] || 0;
    return sp[level] || 0;
  };
  function assignSafetyLevels(pool, cfg) {
    const counts = pool.map(c => (c.safety || {}).streetCrime).filter(n => n != null).sort((a, b) => a - b);
    if (!counts.length) return;
    const loCut = counts[Math.floor(counts.length / 3)], hiCut = counts[Math.floor(2 * counts.length / 3)];
    const k = (cfg.points.safety || {}).busierIfTimesCalmest ?? 1, lo = counts[0], hi = counts[counts.length - 1];
    for (const c of pool) {
      const sf = c.safety || {}, n = sf.streetCrime;
      if (n == null) continue;
      sf.level = n > hiCut && n >= k * lo ? "busier" : n <= loCut && hi >= k * n ? "calmer" : "average";
    }
  }
  function centralPreference(F) {
    const v = String(F.centralPreference || "").toLowerCase();
    if (["strong", "default", "none"].includes(v)) return v;
    if ((F.geography || {}).preferCentral === false) return "none";
    const words = [...(F.niceToHaves || []), ...(F.mustHaves || [])].join(" ").toLowerCase();
    return words.includes("central") ? "strong" : "default";
  }
  function centralPoints(c, F, cfg) {
    const cp = cfg.points.centrality || {}, st = c.station || {};
    let base = 0;
    const z = c.station ? zoneMin(st.zone) : 99;
    if (z === 1 || z === 2) base = cp[z === 1 ? "zone1" : "zone2"] || 0;
    else if (c.centreKm != null && cp.kmBands) {
      for (const [km, pts] of [...cp.kmBands].sort((a, b) => a[0] - b[0])) if (c.centreKm <= km) { base = pts; break; }
    }
    return base * ((cp.multiplier || {})[centralPreference(F)] ?? 0.5);
  }
  const capped = (n, each, maxTotal) => Math.max(maxTotal, each * n);

  function breakdown(c, F, cfg) {
    const P = cfg.points || {};
    const out = [["Base", P.base || 0]];
    const budget = F.budgetTotal, tp = c.totalPrice, st = c.station || {};
    if (budget && tp) out.push(["Price", pricePoints(tp, F, cfg)]);
    if (st.walkMin != null) out.push(["Walk to station", walkPoints(st.walkMin, F.maxWalkMin, cfg)]);
    const n = c.reviews || 0, rc = P.reviewCount;
    out.push(["Number of reviews", reviewPoints(n, rc.bands) * (F.preferReviews === false ? 1 : rc.multiplierIfUserPrefersReviews)]);
    const rp = P.rating;
    if (n >= rp.minReviews && c.rating) { const d = c.rating - rp.neutralAt; out.push(["Star rating", d * (d >= 0 ? rp.perStarAbove : rp.perStarBelow)]); }
    const issues = (c.reviewIssues || []).length;
    if (issues) out.push(["Problems in reviews", capped(issues, P.reviewIssue.each, P.reviewIssue.maxTotal)]);
    if (c.bonus) out.push(["Your extra priorities", c.bonus]);
    const cpts = centralPoints(c, F, cfg);
    if (cpts) out.push(["Central location", cpts]);
    const lvl = (c.safety || {}).level, sp = safetyPoints(lvl, F, cfg);
    if (sp) out.push([`Area safety (${lvl})`, sp]);
    const serious = c.seriousFlags || [];
    if (serious.length) out.push(["Serious red flags", capped(serious.length, P.seriousFlag.each, P.seriousFlag.maxTotal)]);
    const minor = (c.redFlags || []).filter(f => !serious.includes(f));
    if (minor.length) out.push(["Other red flags", capped(minor.length, P.redFlag.each, P.redFlag.maxTotal)]);
    if (c.onWishlist || c.wishlisted) out.push(["On your wishlist", P.wishlist || 0]);
    const t = ((c.arrivalRoute || {}).transit || {}).totalMin;
    if (t) { const a = P.arrival; out.push(["Quick arrival", Math.max(0, a.max - Math.max(0, t - a.fullWithinMin) / a.losePointEveryMin)]); }
    return out;
  }
  const score = (c, F, cfg) => Math.trunc(Math.max(0, Math.min(100, pyRound(breakdown(c, F, cfg).reduce((s, [, p]) => s + p, 0)))));

  return { classify, breakdown, score, assignSafetyLevels, walkPoints, walkCutoff, pricePoints, overBudgetAllowance, reviewPoints, zoneMin, money, isLate };
})();
if (typeof module !== "undefined") module.exports = Scoring;
