// Scout report inside the extension. The search page stores the results under "report:<run>" and opens
// report.html?run=<run>. Photos load from Airbnb's image server like on Airbnb itself.
"use strict";
(async () => {
  const app = document.getElementById("app");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safe = u => /^https:\/\//i.test(u || "") ? u : "";
  const run = new URLSearchParams(location.search).get("run") || "";
  let R = null;
  try { R = (await chrome.storage.local.get("report:" + run))["report:" + run]; } catch (e) {}
  if (!R) { app.innerHTML = '<div class="empty">This report isn\'t available any more. Run the search again from Scout.</div>'; return; }
  const F = R.filters || {}, cur = F.currency || "USD";
  const money = n => n == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);
  const date = d => { const x = new Date((d || "") + "T00:00:00"); return isNaN(x) ? d : x.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
  const hm = m => m == null ? "?" : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
  const all = R.listings || [], picks = all.filter(l => !l.nearMiss), misses = all.filter(l => l.nearMiss);
  const A = R.arrival, short = A ? ((String(A.place).match(/\(([A-Z]{3})\)/) || [])[1] || A.place) : "";
  let sort = "score";
  document.title = `Scout: ${(F.location || "").split(",")[0]}`;

  function card(l, top) {
    const b = [], st = l.station || {}, budget = F.budgetTotal;
    if (top) b.push('<span class="badge red">Top pick</span>');
    if (l.nearMiss) b.push('<span class="badge red">Near miss</span>');
    if (l.superhost) b.push('<span class="badge purple">Superhost</span>');
    const roomLabel = /room/i.test(l.listedAs || "") && !/entire/i.test(l.listedAs || "");
    if (roomLabel && l.effectivelyEntire === true) b.push('<span class="badge purple">Whole flat · listed as room</span>');
    const pct = budget && l.totalPrice ? Math.min(100, l.totalPrice / budget * 100) : null, over = budget && l.totalPrice > budget;
    const t = (l.arrivalRoute || {}).transit;
    return `<article class="card${top ? " top" : ""}">
      <div class="media">${safe(l.image) ? `<img src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <div class="badges">${b.join("")}</div>${!l.nearMiss && l.score != null ? `<div class="score">${l.score}<span>/100</span></div>` : ""}</div>
      <div class="body">
        <div><div class="area">${l.area ? `<b>${esc(l.area)}</b>` : ""}${l.propertyType ? `<span>${esc(l.propertyType)}</span>` : ""}</div><h3 class="title">${esc(l.title || "Listing")}</h3></div>
        ${l.nearMissReason ? `<div class="nm">${esc(l.nearMissReason)}</div>` : ""}
        <div class="price"><div class="total">${money(l.totalPrice)} <small>total</small></div><div class="pn">${money(l.perNight)} / night</div></div>
        ${pct != null ? `<div class="bar${over ? " over" : ""}"><i style="width:${pct}%"></i></div><div class="barlbl${over ? " over" : ""}">${over ? money(l.totalPrice - budget) + " over budget" : money(budget - l.totalPrice) + " left of " + money(budget)}</div>` : ""}
        <div class="facts">${l.beds != null ? `<span>${l.beds} beds</span>` : ""}${l.bedrooms != null ? `<span>${l.bedrooms} bedroom${l.bedrooms === 1 ? "" : "s"}</span>` : ""}${l.reviews ? `<span>★ ${l.rating ?? "–"} · <b>${l.reviews} reviews</b></span>` : `<span class="norev">No reviews yet</span>`}</div>
        ${st.name ? `<div class="station"><span>${esc(st.name)} <span class="meta">· ${esc(st.type || "zone " + st.zone)}</span></span><span class="walk">~${st.walkMin} min walk</span></div>` : l.centreKm != null ? `<div class="station"><span>Distance from the centre</span><span class="walk">${l.centreKm} km</span></div>` : ""}
        ${l.safety && l.safety.level ? `<div class="safety ${esc(l.safety.level)}"><b>${esc({ calmer: "Calmer area", average: "Average area", busier: "Busier area" }[l.safety.level])}</b>${l.safety.streetCrime != null ? ` · ${l.safety.streetCrime} street crimes/month within 1 mi` : ""}</div>` : ""}
        ${t ? `<div class="route"><div>From ${esc(short)}: leave ${esc(t.leaveAt)} → arrive <b>${esc(t.arriveAt)}</b> · ${hm(t.totalMin)}</div><div class="legs">${esc(t.summary)}${l.arrivalRoute.taxi ? ` · taxi ${hm(l.arrivalRoute.taxi.minutes)}, ${esc(l.arrivalRoute.taxi.fare)}` : ""}</div></div>` : ""}
        ${(l.checks || []).length ? `<div class="checks">${l.checks.map(c => `<span class="check ${c.pass ? "pass" : "fail"}">${esc(c.label)}</span>`).join("")}</div>` : ""}
        ${l.why ? `<div class="why">${esc(l.why)}</div>` : ""}
        ${l.hostNotes ? `<div class="said"><span class="lbl">From the host's description</span>${esc(l.hostNotes)}</div>` : ""}
        ${(l.reviewIssues || []).map(f => `<div class="flag">Reviews: ${esc(f)}</div>`).join("")}${(l.redFlags || []).map(f => `<div class="flag">${esc(f)}</div>`).join("")}
        ${l.checkIn && l.checkIn.method ? `<div class="meta">Check-in: ${esc(l.checkIn.method)}${l.checkIn.from ? " · from " + esc(l.checkIn.from) : ""}${l.checkIn.until ? " until " + esc(l.checkIn.until) : ""}</div>` : ""}
        ${l.breakdown ? `<details class="pts"><summary>Where the points come from</summary>${l.breakdown.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v > 0 ? "+" : ""}${v}</b></div>`).join("")}</details>` : ""}
        ${safe(l.url) ? `<div><a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Open on Airbnb</a></div>` : ""}
      </div></article>`;
  }

  const sorters = { score: (a, b) => b.score - a.score, price: (a, b) => (a.totalPrice || 9e9) - (b.totalPrice || 9e9),
    reviews: (a, b) => (b.reviews || 0) - (a.reviews || 0), walk: (a, b) => ((a.station || {}).walkMin ?? 99) - ((b.station || {}).walkMin ?? 99) };
  function render() {
    const topPick = picks.find(l => l.topPick), rest = picks.filter(l => l !== topPick).sort(sorters[sort]);
    const cheapest = picks.reduce((m, l) => l.totalPrice && (!m || l.totalPrice < m.totalPrice) ? l : m, null);
    const chips = [`${F.guests || 2} guests`, F.budgetTotal ? `≤ ${money(F.budgetTotal)} total` : "", F.minBeds ? `${F.minBeds}+ beds` : "",
      F.maxWalkMin ? `≤ ${F.maxWalkMin} min walk` : "", (F.geography || {}).maxZone ? `zone ≤ ${F.geography.maxZone}` : ""].filter(Boolean);
    app.innerHTML = `
      <div class="sub">Scout report</div>
      <h1>${esc((F.location || "").split(",")[0])} · ${date(F.checkin)} – ${date(F.checkout)}</h1>
      <div class="sub">${F.nights || ""} nights${R.aiUsed ? " · read with " + esc(R.aiUsed) : ""}</div>
      ${R.query ? `<div class="query">“${esc(R.query)}”</div>` : ""}
      <div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join("")}${A ? `<span class="chip arrive">Arriving ${esc(short)} ${esc(String(A.landing).slice(11, 16))}</span>` : ""}${(F.mustHaves || []).map(m => `<span class="chip must">${esc(m)}</span>`).join("")}</div>
      <div class="stats"><div class="stat"><div class="k">Matches</div><div class="v">${picks.length} <small>+ ${misses.length} near</small></div></div>
        <div class="stat"><div class="k">Cheapest</div><div class="v">${cheapest ? money(cheapest.totalPrice) : "—"}</div></div>
        <div class="stat"><div class="k">Listings checked</div><div class="v">${R.checked || all.length} <small>of ${R.found || "?"} found</small></div></div></div>
      ${A && (R.airportOptions || []).length ? `<div class="getting"><b>Getting there from ${esc(A.place)}</b><span class="meta">Out of the airport ~${esc(A.readyAt)}</span>${R.airportOptions.map(o => `<div>${esc(o.departs)} · ${esc(o.operator)}${o.arrives ? " → " + esc(o.arrives) : ""}</div>`).join("")}</div>` : ""}
      ${picks.length ? `<div class="grid">${topPick ? card(topPick, true) : ""}</div>
        ${rest.length ? `<div class="controls"><div class="seg">${[["score", "Best fit"], ["price", "Price"], ["reviews", "Reviews"], ["walk", "Walk"]].map(([k, n]) => `<button data-sort="${k}" class="${sort === k ? "on" : ""}">${n}</button>`).join("")}</div></div>
        <div class="grid">${rest.map(l => card(l)).join("")}</div>` : ""}`
        : `<div class="empty">No listing met every requirement.${misses.length ? " The near misses below are close." : " Try other dates or a higher budget."}</div>`}
      ${misses.length ? `<h2>Near misses</h2><div class="grid">${misses.map(l => card(l)).join("")}</div>` : ""}
      <footer>Prices at the time of the search · walking times are approximate · bookings happen on Airbnb</footer>`;
    app.querySelectorAll("[data-sort]").forEach(b => b.onclick = () => { sort = b.dataset.sort; render(); });
  }
  render();
})();
