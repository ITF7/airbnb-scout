// Scout for Airbnb — extension page. Browsing happens here, in the user's own browser, only when they ask;
// the local Scout server does the AI and ranking. Read-only: never books, messages, signs in or solves bot checks.
"use strict";

const API = "http://localhost:8787/api/ext/";
const MAX_PAGES = 4;          // result pages per search
const MAX_CHECK = 8;          // listing pages per search
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const humanPause = (min, max) => sleep(min + Math.random() * (max - min));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = { run: null, filters: null, searchUrl: "", parseCost: 0, cards: {}, pages: [], shortlist: null, tabId: null, busy: false };

// ---------------------------------------------------------------- UI helpers
function step(text, state = "run") {
  const el = document.createElement("div");
  el.className = "step " + state;
  el.innerHTML = `<i></i><span>${esc(text)}</span>`;
  $("steps").appendChild(el);
  return {
    ok: (t) => { el.className = "step ok"; if (t) el.querySelector("span").textContent = t; },
    err: (t) => { el.className = "step err"; if (t) el.querySelector("span").textContent = t; },
    set: (t) => { el.querySelector("span").textContent = t; }
  };
}
function setBusy(b) { S.busy = b; $("go").disabled = b; $("check").disabled = b; $("searchBtn").disabled = b; }

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error("Can't reach Scout on this PC. Start it with start-scout.cmd and try again.");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Scout returned an error (${r.status}).`);
  return d;
}

// ---------------------------------------------------------------- browser helpers
function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error("Airbnb took too long to load.")); }, timeout);
    function fn(id, info) {
      if (id === tabId && info.status === "complete") { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}
async function openInTab(url) {
  if (S.tabId != null) {
    try { await chrome.tabs.get(S.tabId); } catch (e) { S.tabId = null; }
  }
  if (S.tabId == null) {
    // a visible tab next to Scout, without stealing focus
    const tab = await chrome.tabs.create({ url, active: false });
    S.tabId = tab.id;
  } else {
    await chrome.tabs.update(S.tabId, { url });
  }
  await waitForLoad(S.tabId);
  await sleep(1500);  // let the page settle like a person would
  const tab = await chrome.tabs.get(S.tabId);
  if (/captcha|challenge|login|signup/i.test(tab.url || "") || /verify|captcha|robot/i.test(tab.title || "")) {
    await chrome.tabs.update(S.tabId, { active: true });
    throw new Error("Airbnb is asking to check you're human. Scout stops here: complete it yourself in that tab, then search again.");
  }
}
async function runFile(file) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: [file] });
  return res && res.result;
}
async function pageCursor(n) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: S.tabId },
    func: (n) => {
      let f = null;
      try { (function w(o) { if (f || !o || typeof o !== "object") return; if (Array.isArray(o.searchResults)) { f = o; return; } for (const k in o) w(o[k]); })(JSON.parse(document.getElementById("data-deferred-state-0").textContent)); } catch (e) {}
      const c = (f && f.paginationInfo && f.paginationInfo.pageCursors) || [];
      return c[n - 1] || null;
    },
    args: [n]
  });
  return res && res.result;
}
async function closeTab() {
  if (S.tabId != null) { try { await chrome.tabs.remove(S.tabId); } catch (e) {} S.tabId = null; }
}

// ---------------------------------------------------------------- stage 1a: understand the request → editable form
async function understand(query) {
  setBusy(true);
  $("progress").hidden = false; $("steps").innerHTML = ""; $("filters").innerHTML = "";
  $("shortlist").hidden = true; $("result").hidden = true;
  try {
    const s1 = step("Understanding your request");
    const p = await api("parse", { query });
    S.parseCost = p.costUSD || 0;
    if (p.needsInfo) { s1.err("Scout needs one more detail: " + p.needsInfo); $("q").focus(); return; }
    s1.ok("Understood. Check the details below, then press Search Airbnb.");
    S.filters = p.filters;
    fillForm(p.filters);
    $("trip").hidden = false;
    $("trip").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    step(e.message, "err");
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- form
let mode = "cap";
function setMode(m) { mode = m; document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === m)); }
function zoneVisibility() { $("zoneRow").hidden = !/london/i.test($("f-loc").value); }
function walkLabel() { $("f-walkv").textContent = $("f-walk").value + " min"; $("f-walk").disabled = !$("f-walkon").checked; }

function fillForm(f) {
  $("f-loc").value = f.location || "";
  $("f-in").value = f.checkin || ""; $("f-out").value = f.checkout || "";
  $("f-guests").value = f.guests || 2; $("f-beds").value = f.minBeds || 1;
  $("f-budget").value = f.budgetTotal ? Math.round(f.budgetTotal) : "";
  const cur = (f.currency || "USD").toUpperCase();
  if (![...$("f-cur").options].some(o => o.value === cur)) $("f-cur").add(new Option(cur, cur));
  $("f-cur").value = cur;
  setMode(f.priceMode === "strict" ? "cap" : (f.priceMode || "cap"));
  $("f-entire").checked = f.entirePlace !== false;
  $("f-self").checked = !!f.selfCheckIn;
  $("f-reviews").checked = f.preferReviews !== false;
  $("f-walkon").checked = !!f.maxWalkMin; $("f-walk").value = f.maxWalkMin || 10; walkLabel();
  $("f-zone").value = (f.geography && f.geography.maxZone) ? String(f.geography.maxZone) : "";
  zoneVisibility();
  $("f-arrplace").value = (f.arrival && f.arrival.place) || "";
  $("f-arrtime").value = (f.arrival && f.arrival.datetime) ? f.arrival.datetime.slice(0, 16) : "";
  $("arrBox").open = !!(f.arrival && f.arrival.datetime);
}

function readForm() {
  const f = JSON.parse(JSON.stringify(S.filters || {}));
  const num = id => { const v = Number($(id).value); return $(id).value === "" || Number.isNaN(v) ? null : v; };
  f.location = $("f-loc").value.trim();
  f.checkin = $("f-in").value; f.checkout = $("f-out").value;
  f.guests = num("f-guests") || 2; f.minBeds = num("f-beds") || null;
  f.budgetTotal = num("f-budget"); f.currency = $("f-cur").value;
  if (f.priceMode === "strict" && mode === "cap") { /* keep a strict cap from the request */ } else f.priceMode = mode;
  if (mode === "range" && f.budgetTotal && !f.budgetMin) f.budgetMin = Math.round(f.budgetTotal * 0.85 / 1.05);
  if (mode !== "range") f.budgetMin = null;
  f.entirePlace = $("f-entire").checked; f.selfCheckIn = $("f-self").checked; f.preferReviews = $("f-reviews").checked;
  f.maxWalkMin = $("f-walkon").checked ? Number($("f-walk").value) : null;
  f.geography = Object.assign({ preferCentral: true }, f.geography || {}, { maxZone: $("f-zone").value ? Number($("f-zone").value) : null });
  const place = $("f-arrplace").value.trim(), when = $("f-arrtime").value;
  f.arrival = place && when ? Object.assign({ type: "flight" }, f.arrival || {}, { place, datetime: when }) : null;
  if (!f.query) f.query = $("q").value.trim() || `${f.location}, ${f.checkin} to ${f.checkout}`;
  return f;
}

// ---------------------------------------------------------------- stage 1b: search results
async function startSearch() {
  const f = readForm();
  $("tripErr").textContent = "";
  if (!f.location || !f.checkin || !f.checkout) { $("tripErr").textContent = "Add where you're going and both dates."; return; }
  setBusy(true);
  Object.assign(S, { cards: {}, pages: [], shortlist: null });
  $("progress").hidden = false; $("shortlist").hidden = true; $("result").hidden = true;
  if (!S.filters) $("steps").innerHTML = "";
  try {
    const p = await api("url", { filters: f });
    if (p.needsInfo) { $("tripErr").textContent = p.needsInfo; return; }
    Object.assign(S, { run: p.run, filters: p.filters, searchUrl: p.searchUrl });
    renderFilters(p.filters);

    const s2 = step("Opening the Airbnb search with your filters");
    await openInTab(p.searchUrl);
    let first = await runFile("extract/search.js");
    if (!first || first.error) throw new Error("Couldn't read Airbnb's results page" + (first && first.error ? ": " + first.error : "."));
    addCards(first.results); S.pages.push({ page: 1, count: first.count });
    s2.ok(`Search page 1: ${first.count} listings (${first.heading || "Airbnb"})`);

    const pages = Math.min(MAX_PAGES, first.pages || 1);
    for (let n = 2; n <= pages; n++) {
      const sn = step(`Reading results page ${n} of ${pages}`);
      await humanPause(2000, 4000);
      const cur = await pageCursor(n);
      if (!cur) { sn.err(`Page ${n} isn't available`); break; }
      const u = new URL(p.searchUrl); u.searchParams.set("cursor", cur);
      await openInTab(u.toString());
      const r = await runFile("extract/search.js");
      if (!r || r.error) { sn.err(`Couldn't read page ${n}`); break; }
      addCards(r.results); S.pages.push({ page: n, count: r.count });
      sn.ok(`Search page ${n}: ${r.count} listings`);
    }

    const s3 = step("Shortlisting by price, reviews and distance to transit");
    const pf = await api("prefilter", { filters: S.filters, cards: Object.values(S.cards), top: 5 });
    S.shortlist = pf;
    for (const r of pf.open) if (r.station && S.cards[r.id]) S.cards[r.id].station = r.station;
    s3.ok(`${pf.cards} listings found, ${pf.kept} fit your filters`);
    renderShortlist(pf);
  } catch (e) {
    step(e.message, "err");
    await closeTab();
  } finally {
    setBusy(false);
  }
}
function addCards(list) { for (const c of list || []) if (c && c.id && !S.cards[c.id]) S.cards[c.id] = c; }

// ---------------------------------------------------------------- stage 2: check the best few (user presses the button)
async function checkBest() {
  if (!S.shortlist) return;
  setBusy(true);
  const ids = S.shortlist.check.slice(0, MAX_CHECK);
  const cachedIds = S.shortlist.open.filter(r => r.cachedFacts).map(r => r.id).slice(0, 5);
  const listings = [];
  try {
    const f = S.filters;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], card = S.cards[id] || {};
      const si = step(`Reading listing ${i + 1} of ${ids.length}: ${card.name || id}`);
      if (i) await humanPause(3000, 6000);
      const u = new URL(`https://www.airbnb.com/rooms/${id}`);
      u.searchParams.set("check_in", f.checkin); u.searchParams.set("check_out", f.checkout);
      u.searchParams.set("adults", f.guests || 2); u.searchParams.set("currency", f.currency || "USD"); u.searchParams.set("locale", "en");
      await openInTab(u.toString());
      const x = await runFile("extract/listing.js");
      if (!x || !x.id) { si.err(`Couldn't read ${card.name || id}`); continue; }
      if (x.unavailable) { si.err(`${card.name || id} isn't available for your dates`); continue; }
      listings.push(x);
      si.ok(`Read ${x.title || card.name || id}`);
    }
    await closeTab();
    const sr = step("Reading descriptions and reviews, ranking, safety and arrival routes (about a minute)");
    const res = await api("finish", { run: S.run, filters: S.filters, searchUrl: S.searchUrl, parseCost: S.parseCost,
                                      cards: S.cards, listings, pages: S.pages, cachedIds });
    sr.ok("Ranked");
    $("result").hidden = false;
    $("done").innerHTML = `<div><b>${res.matches}</b> match${res.matches === 1 ? "" : "es"}${res.nearMisses ? ` and ${res.nearMisses} near miss${res.nearMisses === 1 ? "" : "es"}` : ""}.</div>
      ${res.report ? `<div><a href="${esc(res.report)}" target="_blank" rel="noopener">Open the report</a></div>` : ""}
      <div class="hint">AI cost of this search: about $${Number(res.costUSD || 0).toFixed(3)} of plan usage.</div>`;
    if (res.report) chrome.tabs.create({ url: res.report });
  } catch (e) {
    step(e.message, "err");
    await closeTab();
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- render
function renderFilters(f) {
  const chips = [];
  chips.push(`${(f.location || "").split(",")[0]} · ${f.checkin} → ${f.checkout}`);
  if (f.guests) chips.push(`${f.guests} guests`);
  if (f.budgetTotal) chips.push(`≤ ${f.budgetTotal} ${f.currency || ""} total`);
  if (f.minBeds) chips.push(`${f.minBeds}+ beds`);
  if (f.maxWalkMin) chips.push(`≤ ${f.maxWalkMin} min to ${f.transit || "transit"}`);
  if (f.geography && f.geography.maxZone) chips.push(`zone ≤ ${f.geography.maxZone}`);
  if (f.arrival) chips.push(`arriving ${f.arrival.datetime.replace("T", " ")}`);
  $("filters").innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join("")
    + (f.mustHaves || []).filter(m => /self|entire/i.test(m)).map(m => `<span class="chip must">${esc(m)}</span>`).join("");
}
function renderShortlist(pf) {
  $("shortlist").hidden = false;
  if (!pf.open.length) {
    $("list").innerHTML = `<div class="item"><div class="ask">Nothing in the results fits every filter. Try a higher budget, other dates or a wider area.</div></div>`;
    $("check").hidden = true; $("checkHint").textContent = ""; return;
  }
  const cur = S.filters.currency || "";
  $("list").innerHTML = pf.open.map(r => `<div class="item">
      <div class="row"><span class="t">${esc(r.name || r.type || r.id)}</span>${r.cachedFacts ? '<span class="tag">checked recently</span>' : ""}</div>
      <div class="m">${r.total ? `<span><b>${Number(r.total).toLocaleString()} ${esc(cur)}</b> total</span>` : ""}
        ${r.station ? `<span>~${r.station.walkMin} min to ${esc(r.station.name)} · zone ${esc(r.station.zone)}</span>` : (r.area ? `<span>${esc(r.area)}</span>` : "")}
        <span>${r.reviews ? `★ ${r.rating ?? "–"} · <b>${r.reviews}</b> reviews` : "no reviews yet"}</span>
        ${r.beds ? `<span>${r.beds} beds</span>` : ""}</div></div>`).join("");
  const n = pf.check.length;
  $("check").hidden = n === 0 && !pf.open.some(r => r.cachedFacts);
  $("check").textContent = n ? `Check the best ${n}` : "Rank these";
  $("checkHint").textContent = n
    ? `Scout opens these ${n} listings one by one in a tab, at a person's pace, to read the description, house rules and reviews.`
    : "These were all checked recently, so Scout can rank them without opening them again.";
}

// ---------------------------------------------------------------- wire up
$("form").addEventListener("submit", e => {
  e.preventDefault();
  if (S.busy) return;
  const q = $("q").value.trim().replace(/\s+/g, " ");
  if (!q) { $("q").focus(); return; }
  try { chrome.storage.local.set({ lastQuery: q }); } catch (err) {}
  understand(q);
});
$("manual").addEventListener("click", () => {
  if (!S.filters) { S.filters = {}; fillForm({ guests: 2, minBeds: 1, currency: "USD", entirePlace: true, preferReviews: true }); }
  $("trip").hidden = false; $("f-loc").focus();
});
$("trip").addEventListener("submit", e => { e.preventDefault(); if (!S.busy) startSearch(); });
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
  const [id, d] = b.dataset.step.split(":"); const el = $(id);
  el.value = Math.min(Number(el.max), Math.max(Number(el.min), (Number(el.value) || 0) + Number(d)));
}));
$("f-walk").addEventListener("input", walkLabel);
$("f-walkon").addEventListener("change", walkLabel);
$("f-loc").addEventListener("input", zoneVisibility);
$("f-in").addEventListener("change", () => { if ($("f-out").value && $("f-out").value <= $("f-in").value) $("f-out").value = ""; $("f-out").min = $("f-in").value; });
setMode("cap"); walkLabel();
try { $("f-in").min = new Date().toISOString().slice(0, 10); } catch (e) {}
$("q").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } });
$("check").addEventListener("click", () => { if (!S.busy) checkBest(); });
try { chrome.storage.local.get("lastQuery", d => { if (d && d.lastQuery && !$("q").value) $("q").value = d.lastQuery; }); } catch (e) {}
