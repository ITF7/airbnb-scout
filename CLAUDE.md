# Airbnb Scout

Natural-language Airbnb search. `/scout <request>` parses the request into filters, fans out to at most 4 `airbnb-scout` subagents that browse Airbnb in parallel (each in its own browser tab), merges and ranks their findings, and renders an HTML report.

- Orchestrator: `.claude/commands/scout.md`
- Subagent: `.claude/agents/airbnb-scout.md`
- Arrival routing: `.claude/agents/arrival-router.md`. When the request gives an arrival ("land at LGW 1am"), one router runs after ranking: Google Maps transit with a set departure time, cross-checked against the TfL journey API, plus operator timetables for airport trains, night buses and coaches, and a taxi estimate. It also adds the "Late check-in OK" rule and the arrival-before-check-in warning.
- Search flow: Airbnb-native filters go in the URL first. `price_max` + `price_filter_num_nights` = **total** stay cap (verified Nov 2026); self check-in = `amenities[]=51`. Then a map sweep of small boxes around tube stations (`scripts/geo.py tiles`, zone limit from the request), then manual checks (walk, zone, reviews, description, safety, arrival).
- `scripts/geo.py`: `stations` (TfL tube stations + zones, cached in `data/london_tube_stations.json`), `tiles` (sweep plan per scout), `safety` (data.police.uk street crime near a station).
- Wishlists: `/scout` can read a named Airbnb wishlist from the user's signed-in browser (never logs in) and uses it as candidates and as a taste signal.
- Report UI: `templates/report.html` (data injected by `scripts/build-report.ps1`)
- Home page: `templates/home.html` → `index.html` (search box + past searches; rebuilt by the same script, or `-HomeOnly`)
- Output: `results/` (one `.json` + one `.html` per run)
- Website: `start-scout.cmd` → `server.py` (127.0.0.1:8787, stdlib only). `POST /api/search` runs `claude -p "/scout [headless] <query>" --output-format stream-json --verbose --chrome` with an allowlist of tools; `GET /api/job` returns parsed progress. Headless protocol lines: `FILTERS:`, `NEEDS_INFO:`, `REPORT:` (defined in scout.md). One search at a time.
- Opened as plain files (no server), the search boxes fall back to copying a `/scout …` command.
- No separate API billing: everything runs on the user's Claude plan via Claude Code. The user declined a paid-API web app.
- Goal: the user wants to use only the front end, never the chat.
- **Cost-saving design (Nov 2026):** scouts and the router run on Sonnet (`model:` in the agent frontmatter). Scouts read pages with `scripts/extract/search.js` / `listing.js` via `javascript_tool`, never full-page text unless an extractor fails. Two stages: scan cards → `scripts/scout_tools.py near` (station/walk/zone from coordinates) → open only the best 4–5. Scouts write `results/runs/<run>/scout-<n>.json` and reply with one line. `scout_tools.py rank` does merge, hard filters, scoring, safety and TfL routes (cached in `data/*_cache.json`); the orchestrator only polishes the top `why` lines. Listing facts are cached 30 days (`data/listing_cache.json`), prices never.
- **Phone app:** `artifact/scout.html`, published at https://claude.ai/artifact/S3KdRDFXm1GbNDdLCQ71m3 (db collections `searches`, `pc`; writes need Editor/owner). `server.py` polls it every `intervalSec` (`data/relay.json`) with a tiny `claude -p --model haiku` run that may only use ArtifactData (`--permission-mode auto` is required for artifact writes in headless runs; Bash/Write/etc. are disallowed). The standalone CLI only offers ArtifactData when `CLAUDE_CODE_ENTRYPOINT=claude-desktop` is set, so `claude_mini` sets it (undocumented; re-check after Claude Code updates). On its first check after starting, the server also re-runs searches left "running" by a restart. Queued searches run like website searches; progress and the finished report are written back, and PC-started searches are added to the history. Republish the page with the Artifact tool (same file path / that URL). External images are blocked in artifacts, so the app shows no photos.
- **Git:** public repo https://github.com/ITF7/airbnb-scout (branch `main`). Commit as ITF7 with the GitHub no-reply email (already set in this clone's git config); never commit the user's real email. `.gitignore` keeps out `results/`, `index.html`, caches, `data/relay/` and `data/relay.json` (only the main PC has the phone link). `start-scout.cmd` runs `git pull --ff-only` on start.
- **Working without the main PC (cloud sessions at claude.ai/code, other computers):** the repo is the source of truth. You can edit anything, run `python3 scripts/selftest.py` (offline: tile planner, pre-filter, rank on `tests/fixtures/london_run`), run `scripts/geo.py` / `scout_tools.py` (use `python3`, not `py -3`, on Linux), and republish the phone app with the Artifact tool. You can't run real searches there: they need the main PC's Chrome with the Claude extension, and `server.py`/`build-report.ps1` are Windows-only. Run the self-test before committing script changes, then commit and push to `main`; the main PC pulls on its next start. Keep scout instructions using `py -3` (that's what runs on the main PC).
- **Chrome extension (standalone, Nov 2026):** `extension/` (Manifest V3) needs no server: `lib/ai.js` (Chrome's built-in model via `LanguageModel`, only after the user presses "Turn on" because Chrome downloads it once; otherwise rule-based parsing and review checks), `lib/scoring.js` (line-for-line port of `scripts/scoring.py`, uses Python-style rounding), `lib/geo.js` (bundled tube stations, data.police.uk, TfL, Nominatim; cached in chrome.storage), `lib/rank.js` (search link, shortlist, rank), `report.html`. Copies that must stay byte-identical (self-test checks): `extension/extract/*.js`, `extension/config/scoring.json`, `extension/data/london_tube_stations.json`. After changing scoring, regenerate `tests/parity/cases.json` and open `tests/parity/index.html` via a local http server: it must say 0 mismatches. The old `/api/ext/*` server endpoints are now unused. **Nothing may cost money.** No 'sign in with Claude' exists for third-party apps; never use a user's claude.ai session.
- **Scoring:** all points and near-miss rules live in `config/scoring.json`; `scripts/scoring.py` (`classify`, `score`, `breakdown`, `rescore`) is the only place that applies them (rank, pre-filter, tuning). Tuning page: `http://localhost:8787/tune` (re-ranks saved results live, saves the config; previous version kept as `config/scoring.previous.json`). Run a test server with `SCOUT_PORT=8791 SCOUT_RELAY=0` so it doesn't pick up phone searches.
- Testing the server without real searches: set `SCOUT_CLAUDE` to a stand-in `.py` script that prints stream-json.

Scouting is read-only: never log in, contact hosts, reserve, enter personal or payment data, or solve CAPTCHAs.

## Design preferences (apply to every UI built here)

- **Sleek and practical.** Clean layout, generous spacing, no decoration that doesn't carry information.
- **Dark mode** by default.
- **Red is reserved for important things**: warnings, failed requirements, over-budget, red flags, the single most important callout (e.g. "Top pick"). Don't use it decoratively.
- **Accents: grey, blue and purple.** Grey for secondary text/borders, blue for interactive elements and links, purple for highlights and secondary emphasis.

Color tokens:

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0f1115` | page background |
| `--surface` | `#171a21` | cards, panels |
| `--surface-2` | `#1f232c` | raised elements, inputs |
| `--border` | `#2a2f3a` | dividers, outlines |
| `--text` | `#e6e8ee` | primary text |
| `--muted` | `#8b93a7` | secondary text (grey accent) |
| `--blue` | `#5b8def` | links, buttons, interactive |
| `--purple` | `#9b7bf0` | highlights, chips, secondary emphasis |
| `--red` | `#ef4444` | important only: warnings, failures, top pick |
| `--green` | `#34d399` | passed checks (sparingly) |

Font: system UI stack (`Inter`, `Segoe UI`, sans-serif). Rounded corners ~12px, subtle borders over heavy shadows.
