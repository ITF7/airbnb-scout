// Scout for Airbnb: extension page. Everything runs in the user's own browser, only when they ask: Airbnb is read in a
// visible tab at a person's pace, the AI is Chrome's built-in model (or plain rules), and ranking uses Scout's points
// (lib/*.js). No server, no account, nothing to pay. Read-only: never books, messages, signs in or solves bot checks.
"use strict";

const MAX_PAGES = 4;          // result pages per search
const MAX_CHECK = 8;          // listing pages per search
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const humanPause = (min, max) => sleep(min + Math.random() * (max - min));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = { run: null, filters: null, searchUrl: "", cards: {}, pages: [], shortlist: null, tabId: null, busy: false };

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
    const f = await AI.parse(query);
    const missing = !f.location ? "where you're going" : !(f.checkin && f.checkout) ? "your check-in and check-out dates" : "";
    s1.ok(missing ? `Filled in what I could. Please add ${missing} below.` : "Understood. Check the details below, then press Search Airbnb.");
    S.filters = f;
    fillForm(f);
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
  moreSummary();
}

// one line under "More filters" so nothing set is hidden when it's closed
function moreSummary() {
  const bits = [];
  const beds = Number($("f-beds").value) || 0;
  if (beds > 1) bits.push(`${beds}+ beds`);
  if ($("f-entire").checked) bits.push("entire place");
  if ($("f-self").checked) bits.push("self check-in");
  if ($("f-walkon").checked) bits.push(`≤ ${$("f-walk").value} min walk`);
  if (!$("zoneRow").hidden && $("f-zone").value) bits.push(`zone ≤ ${$("f-zone").value}`);
  if ($("f-arrplace").value && $("f-arrtime").value) bits.push(`arriving ${$("f-arrtime").value.slice(11, 16)}`);
  if (!$("f-reviews").checked) bits.push("reviews not prioritised");
  $("moreSum").textContent = bits.length ? bits.join(" · ") : "beds, entire place, self check-in, transit, arrival";
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
    const p = Rank.prepare(f);
    if (p.needsInfo) { $("tripErr").textContent = p.needsInfo; return; }
    const url = await Rank.searchUrl(p.filters);
    const run = `${(p.filters.location || "trip").split(",")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${Date.now()}`;
    Object.assign(S, { run, filters: p.filters, searchUrl: url });
    p.searchUrl = url;
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
    const pf = await Rank.shortlist(S.filters, Object.values(S.cards), 5);
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
    const ai = await AI.status();
    const judged = [];
    for (const x of listings) {
      const sj = step(`Reading the description and reviews of ${x.title || x.id} (${ai})`);
      const j = await AI.judge(x, f);
      for (const k of ["totalPrice", "rating", "reviews", "image", "maxGuests"]) if (x[k] != null) j[k] = x[k];
      judged.push(j);
      sj.ok(`Read ${x.title || x.id}`);
    }
    const sr = step("Ranking with Scout's points");
    const rep = await Rank.rank(f, S.cards, judged, cachedIds, t => step(t, "ok"));
    rep.aiUsed = ai; rep.found = Object.keys(S.cards).length; rep.checked = listings.length + cachedIds.length;
    await chrome.storage.local.set({ ["report:" + S.run]: rep });
    const picks = rep.listings.filter(l => !l.nearMiss).length, near = rep.listings.length - picks;
    sr.ok("Ranked");
    $("result").hidden = false;
    const reportUrl = chrome.runtime.getURL("report.html?run=" + encodeURIComponent(S.run));
    $("done").innerHTML = `<div><b>${picks}</b> match${picks === 1 ? "" : "es"}${near ? ` and ${near} near miss${near === 1 ? "" : "es"}` : ""}.</div>
      <div><a href="${esc(reportUrl)}" target="_blank" rel="noopener">Open the report</a></div>
      <div class="hint">Read with ${esc(ai)}. Nothing was sent anywhere except Airbnb and the free public map, transport and police data services.</div>`;
    chrome.tabs.create({ url: reportUrl });
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
["f-beds", "f-entire", "f-self", "f-reviews", "f-walkon", "f-walk", "f-zone", "f-arrplace", "f-arrtime", "f-loc"].forEach(id =>
  $(id).addEventListener(id === "f-walk" || id === "f-loc" || id === "f-arrplace" ? "input" : "change", moreSummary));
document.querySelectorAll('[data-step="f-beds:-1"], [data-step="f-beds:1"]').forEach(b => b.addEventListener("click", moreSummary));
try { $("f-in").min = new Date().toISOString().slice(0, 10); } catch (e) {}
$("q").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } });
$("check").addEventListener("click", () => { if (!S.busy) checkBest(); });
try { chrome.storage.local.get("lastQuery", d => { if (d && d.lastQuery && !$("q").value) $("q").value = d.lastQuery; }); } catch (e) {}

// ---------------------------------------------------------------- Chrome's built-in AI: ask before the one-time download
async function showAiLine() {
  const line = $("aiLine"), state = await AI.chromeModelState();
  if (state === "available") { line.hidden = false; line.textContent = "Reading with Chrome's built-in AI, on this computer."; return; }
  if (state === "unavailable") { line.hidden = false; line.textContent = "Reading with simple rules: this Chrome doesn't offer its built-in AI."; return; }
  line.hidden = false;
  line.innerHTML = `Reading with simple rules for now. <button class="linkbtn" id="aiOn" type="button">Turn on Chrome's built-in AI</button> for better judging: Chrome downloads it once (a few GB), free, and it runs on this computer.`;
  $("aiOn").addEventListener("click", async () => {
    line.textContent = "Chrome is downloading its AI model… you can keep using Scout meanwhile.";
    try {
      await AI.enableChromeModel(p => { line.textContent = `Chrome is downloading its AI model… ${Math.round(p * 100)}%`; });
      line.textContent = "Chrome's built-in AI is ready. Scout uses it from the next search.";
    } catch (e) { line.textContent = "Chrome couldn't set up its AI here, so Scout keeps using simple rules."; }
  });
}
showAiLine();

