// Scout scoring page: edit config/scoring.json with live re-ranking of a saved search (served by server.py at /tune).
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let saved = null, cfg = null, timer = null;

// What to show for each setting: [path, label, min, max, step]
const FIELDS = {
  "Starting points": [["points.base", "Every listing starts with", 0, 30, 1]],
  "Price": [["points.price.range.insideRange", "'Around X': points anywhere inside the range", 0, 50, 1],
            ["points.price.range.aroundMeansFromShare", "'Around X' starts at this share of X", 0.5, 1, 0.05],
            ["rules.overBudgetNearMissUpTo.cap", "Near miss over budget, 'up to X'", 0, 0.3, 0.01],
            ["rules.overBudgetNearMissUpTo.cheaper", "Near miss over budget, 'the less the better'", 0, 0.3, 0.01],
            ["rules.overBudgetNearMissUpTo.range", "Near miss over budget, 'around X'", 0, 0.3, 0.01],
            ["rules.muchCheaperFlagBelowMedianShare", "Flag places cheaper than this share of the typical price", 0, 1, 0.05]],
  "Walk to station": [["points.walk.fullWithinAtLeastMin", "Full points always within (min)", 0, 10, 1], ["points.walk.defaultLimitMin", "Limit when the request gives none (min)", 3, 30, 1]],
  "Number of reviews": [["points.reviewCount.multiplierIfUserPrefersReviews", "Multiplier when reviews matter", 1, 3, 0.1]],
  "Star rating": [["points.rating.neutralAt", "Neutral rating (no points)", 3.5, 5, 0.05], ["points.rating.perStarAbove", "Points per star above it", 0, 60, 1],
                  ["points.rating.perStarBelow", "Points lost per star below it", 0, 100, 1], ["points.rating.minReviews", "Only counts from (reviews)", 0, 50, 1]],
  "Problems in reviews": [["points.reviewIssue.each", "Each problem", -20, 0, 1], ["points.reviewIssue.maxTotal", "At most", -40, 0, 1]],
  "Serious red flags": [["points.seriousFlag.each", "Each flag", -40, 0, 1], ["points.seriousFlag.maxTotal", "At most", -60, 0, 1]],
  "Other red flags": [["points.redFlag.each", "Each flag", -20, 0, 1], ["points.redFlag.maxTotal", "At most", -40, 0, 1]],
  "Central location": [["points.centrality.zone1", "Zone 1", 0, 20, 1], ["points.centrality.zone2", "Zone 2", 0, 20, 1]],
  "Area safety": [["points.safety.calmer", "Calmer area", 0, 15, 1], ["points.safety.average", "Average area", -10, 10, 1], ["points.safety.busier", "Busier area", -15, 0, 1]],
  "Wishlist": [["points.wishlist", "On your wishlist", 0, 20, 1]],
  "Arrival time": [["points.arrival.max", "Most points", 0, 20, 1], ["points.arrival.fullWithinMin", "Full points within (min)", 0, 180, 5], ["points.arrival.losePointEveryMin", "Lose 1 point every (min)", 1, 60, 1]],
  "Rules": [["rules.walkNearMissUpToShare", "Near miss up to this share of the walking limit", 1, 3, 0.1],
            ["rules.nearMissBelowRating", "Can't be a pick if rated below (★)", 0, 5, 0.1],
            ["rules.keepMatches", "Picks to show", 1, 20, 1], ["rules.keepNearMisses", "Near misses to show", 0, 10, 1]]
};
const HELP = { "Price": "points.price._help", "Walk to station": "points.walk._help", "Number of reviews": "points.reviewCount._help",
  "Star rating": "points.rating._help", "Problems in reviews": "points.reviewIssue._help", "Serious red flags": "points.seriousFlag._help",
  "Central location": "points.centrality._help", "Area safety": "points.safety._help", "Arrival time": "points.arrival._help", "Rules": "rules._help" };

const get = (o, p) => p.split(".").reduce((x, k) => x == null ? x : x[k], o);
const set = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; };

function renderControls() {
  let h = "<h2>Points and rules</h2>";
  for (const [group, fields] of Object.entries(FIELDS)) {
    h += `<div class="group"><b>${esc(group)}</b>`;
    if (HELP[group] && get(cfg, HELP[group])) h += `<div class="help">${esc(get(cfg, HELP[group]))}</div>`;
    if (group === "Price") {
      for (const [mode, label] of [["cap", "'Up to X'"], ["cheaper", "'The less the better'"]]) {
        h += `<div class="help" style="margin:8px 0 4px">${label}: points by share of the budget</div><div class="bands">${get(cfg, "points.price." + mode).map((b, i) => `<div><span>≤ ${Math.round(b[0] * 100)}%</span><input type="number" data-pband="${mode}:${i}" value="${b[1]}" step="1" aria-label="${label} points up to ${Math.round(b[0] * 100)}% of budget"></div>`).join("")}</div>`;
      }
    }
    if (group === "Walk to station") {
      h += `<div class="bands">${get(cfg, "points.walk.bands").map((b, i) => `<div><span>≤ ${Math.round(b[0] * 100)}% of limit</span><input type="number" data-wband="${i}" value="${b[1]}" step="1" aria-label="Points within ${Math.round(b[0] * 100)}% of the walking limit"></div>`).join("")}</div>`;
    }
    if (group === "Number of reviews") {
      h += `<div class="bands">${get(cfg, "points.reviewCount.bands").map((b, i) => `<div><span>${b[0]}+ reviews</span><input type="number" data-band="${i}" value="${b[1]}" step="1" aria-label="Points for ${b[0]} or more reviews"></div>`).join("")}</div>`;
    }
    for (const [path, label, min, max, step] of fields) {
      const v = get(cfg, path);
      if (v === undefined) continue;
      h += `<div class="field"><label for="f-${path}">${esc(label)}</label>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-path="${path}" aria-label="${esc(label)}">
        <input type="number" id="f-${path}" min="${min}" max="${max}" step="${step}" value="${v}" data-path="${path}"></div>`;
    }
    h += "</div>";
  }
  $("controls").innerHTML = h;
  $("controls").querySelectorAll("[data-path]").forEach(el => el.addEventListener("input", () => {
    const v = Number(el.value); if (Number.isNaN(v)) return;
    set(cfg, el.dataset.path, v);
    $("controls").querySelectorAll(`[data-path="${el.dataset.path}"]`).forEach(o => { if (o !== el) o.value = v; });
    changed();
  }));
  $("controls").querySelectorAll("[data-pband]").forEach(el => el.addEventListener("input", () => {
    const v = Number(el.value); if (Number.isNaN(v)) return;
    const [mode, i] = el.dataset.pband.split(":"); get(cfg, "points.price." + mode)[+i][1] = v; changed();
  }));
  $("controls").querySelectorAll("[data-wband]").forEach(el => el.addEventListener("input", () => {
    const v = Number(el.value); if (Number.isNaN(v)) return;
    get(cfg, "points.walk.bands")[+el.dataset.wband][1] = v; changed();
  }));
  $("controls").querySelectorAll("[data-band]").forEach(el => el.addEventListener("input", () => {
    const v = Number(el.value); if (Number.isNaN(v)) return;
    get(cfg, "points.reviewCount.bands")[+el.dataset.band][1] = v; changed();
  }));
}

function changed() {
  $("save").disabled = JSON.stringify(cfg) === JSON.stringify(saved);
  status("");
  clearTimeout(timer); timer = setTimeout(rescore, 200);
}
function status(t, cls = "") { $("status").textContent = t; $("status").className = "status " + cls; }

async function api(path, body) {
  const r = await fetch("/api/tune/" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}

function rowHtml(l, i, cur) {
  const was = l.was || {};
  const d = was.score == null ? null : l.score - was.score;
  const moved = was.nearMiss !== undefined && was.nearMiss !== l.nearMiss;
  const st = l.station || {};
  const max = Math.max(1, ...l.breakdown.map(b => Math.abs(b[1])));
  return `<div class="row${l.topPick ? " top" : ""}">
    <div class="line"><span class="rank">${i + 1}</span>
      <div style="min-width:0"><div class="name">${esc(l.title || l.id)}${l.topPick ? '<span class="tag red">Top pick</span>' : ""}${moved ? `<span class="tag moved">${l.nearMiss ? "was a pick" : "was a near miss"}</span>` : ""}</div>
        <div class="meta">${l.totalPrice ? Number(l.totalPrice).toLocaleString() + " " + esc(cur) : ""}${st.name ? ` · ${st.walkMin} min to ${esc(st.name)}` : ""} · ${l.reviews || 0} reviews${l.rating ? " ★" + l.rating : ""}${l.safety && l.safety.level ? " · " + esc(l.safety.level) + " area" : ""}</div>
        ${l.nearMissReason ? `<div class="why">${esc(l.nearMissReason)}</div>` : ""}${l.dropReason ? `<div class="why">${esc(l.dropReason)}</div>` : ""}</div>
      <span class="delta ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d == null || d === 0 ? "" : (d > 0 ? "+" : "") + d}</span>
      <span class="score">${l.score}</span></div>
    <details><summary>Where the points come from</summary><div class="bd">${l.breakdown.map(([k, v]) =>
      `<div><span>${esc(k)}</span><span class="bar"><i class="${v < 0 ? "neg" : ""}" style="left:0;width:${Math.abs(v) / max * 100}%"></i></span><b>${v > 0 ? "+" : ""}${v}</b></div>`).join("")}</div></details>
  </div>`;
}

async function rescore() {
  const run = $("run").value; if (!run) return;
  try {
    const r = await api("rescore", { run, config: cfg });
    $("query").textContent = r.query ? "“" + r.query + "”" : "";
    const cur = r.currency || "";
    $("matches").innerHTML = r.matches.length ? r.matches.map((l, i) => rowHtml(l, i, cur)).join("") : `<div class="empty">No picks with this scoring.</div>`;
    $("near").innerHTML = r.nearMisses.length ? r.nearMisses.map((l, i) => rowHtml(l, i, cur)).join("") : `<div class="empty">No near misses.</div>`;
    $("droppedH").hidden = !r.dropped.length;
    $("dropped").innerHTML = r.dropped.map((l, i) => rowHtml(l, i, cur)).join("");
  } catch (e) { status(e.message, "err"); }
}

async function init() {
  try {
    const [c, runs] = await Promise.all([api("config"), api("runs")]);
    saved = c.config; cfg = JSON.parse(JSON.stringify(saved));
    $("run").innerHTML = runs.runs.map(r => `<option value="${esc(r.file)}">${esc(r.label)}</option>`).join("");
    renderControls();
    rescore();
  } catch (e) { status("Couldn't load: " + e.message + ". Is Scout running on this PC?", "err"); }
}
$("run").addEventListener("change", rescore);
$("reset").addEventListener("click", () => { cfg = JSON.parse(JSON.stringify(saved)); renderControls(); changed(); });
$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try { await api("save", { config: cfg }); saved = JSON.parse(JSON.stringify(cfg)); status("Saved. New searches use this scoring.", "ok"); }
  catch (e) { status(e.message, "err"); $("save").disabled = false; }
});
init();
