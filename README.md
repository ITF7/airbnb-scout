# Airbnb Scout

Describe the stay you want in plain language; Claude searches Airbnb for you with up to 4 parallel scouts and hands back a ranked, dark-mode HTML report.

## Setup for the website (one time)

The website runs searches through Claude Code on your normal Claude plan. There's no separate API bill, but searches count toward your plan's usage limits.

1. **Install Claude Code (command line).** Open PowerShell and run:
   ```
   irm https://claude.ai/install.ps1 | iex
   ```
2. **Sign in.** In a new PowerShell window, go to this folder and start it once:
   ```
   cd "A:\Claude\AirBnB agent"
   claude
   ```
   Sign in with your Claude account, say yes to trusting the folder, then type `/exit`.
3. **Install Claude in Chrome.** Add the "Claude" extension from the Chrome Web Store **in Google Chrome** and sign in with the same account. The scouts browse Airbnb in Chrome, and Chrome must be open while a search runs. Other Chromium browsers don't work: in Opera GX the extension fails with "No group with id", because Opera handles tab groups differently.

## Use

**Website (no chat):** double-click **`start-scout.cmd`**. A small window opens (leave it open) and your browser opens http://localhost:8787. Type what you want and press **Search**. You'll see each scout's progress live, and the report opens by itself when it's done (usually a few minutes). Close the small window to stop.

**From your phone:** open the Scout app at https://claude.ai/artifact/S3KdRDFXm1GbNDdLCQ71m3 (signed in to claude.ai). Type a request and press **Search**. Your PC picks it up within about 2 minutes, as long as `start-scout.cmd` is running there, and the app shows live progress and then the full report. Searches you run on the PC also appear in the app's history. The app shows "Your PC is on / last checked in …" so you know whether a search will run. The link to the app is in `data/relay.json`; delete that file to switch the phone link off. Listing photos don't load in the app (claude.ai blocks outside images), so tap "Open on Airbnb" for those.

If a request is missing the place or dates, the page asks for them. Add them and press Search again.

**Home page without the server:** opening `index.html` directly gives copy mode. **Search** copies a `/scout …` command to paste into Claude Code.

**Or directly in Claude Code** (desktop app, Code tab):

```
/scout 5 nights in Munich from Dec 10 to Dec 15 2026, $1000 total, at least 2 beds, close to a train station
```

More examples:

```
/scout Lisbon, Mar 3-8, 4 adults, under €1500, 2 bedrooms, washer and wifi, walkable to a metro
/scout weekend in Vienna Jan 16-18 for 2, max $120 a night, superhost preferred
/scout a week in Kyoto from Apr 1, 3 people, $2000 total, near a JR station, kitchen required
```

### Extras you can add to any request

- **Arrival:** "landing at Gatwick at 1am", "arriving on the 18:30 Eurostar". Each shortlisted home gets the fastest public-transport route at that hour (in London straight from TfL's journey planner, worked out once per station; elsewhere from operator timetables), a taxi estimate, and a "Getting there" panel with the airport departures. Late arrivals also check that the place has self check-in, and warn you if you arrive before check-in time.
- **Wishlist:** "use my wishlist London, United Kingdom 2026". Needs you to be signed in to Airbnb in Chrome. Saved homes are checked for your dates and badged in the report.
- **Reviews:** "places with multiple reviews are better" ranks reviewed places higher.
- **Geography:** "zone 3 of the tube max", "zones 1–2", "within 5 km of the centre", or named neighbourhoods. In London, Scout sweeps small map areas around every tube station inside your zone limit, centre first, so cheaper flats aren't hidden by Airbnb's result limit.
- **Safety:** "safe to walk at night" compares police-recorded street crime around each shortlisted station (data.police.uk, England & Wales) and what guests say about the area at night.
- **Self check-in, budget, beds** and similar go straight into Airbnb's own filters, so scouts only read listings that already fit.

## What happens

1. **Parse:** your sentence becomes filters (location, dates, guests, total budget, beds, must-haves). Missing location or dates means one quick question. Anything else gets a sensible default, shown as an "assumed" chip in the report.
2. **Plan:** Airbnb's own filters go into the search URL. In London, `scripts/geo.py tiles` plans one wide search per area plus small map boxes around tube stations for crowded areas. Usually 1–2 scouts.
3. **Scout (two stages, on Sonnet):** each `airbnb-scout` opens its own browser tab and pulls compact data with `scripts/extract/search.js` instead of reading whole pages. `scripts/scout_tools.py near` works out the nearest station, walk and zone from each listing's coordinates and drops misses. Only the best 4–5 get opened, and `scripts/extract/listing.js` reads their price, description, policies and ~10 reviews. Listings read in the last 30 days come from the cache (`data/listing_cache.json`). Prices are always fresh.
4. **Rank (script):** `scripts/scout_tools.py rank` merges the scouts' files, applies the hard filters and the fixed scoring (price, walk, review count first, rating, review issues, red flags, centrality, police street-crime level, arrival time). It adds TfL routes and writes the results JSON. Safety, route and listing data are cached.
5. **Report:** `results/<city>_<checkin>_<checkout>_<time>.html`, plus the phone app. Each website or phone search saves its plan usage (API-equivalent cost and minutes) in the results JSON; the phone app shows it under the report.

## Files

| Path | What |
|---|---|
| `.claude/commands/scout.md` | The `/scout` orchestrator |
| `.claude/agents/airbnb-scout.md` | The scout subagent (Sonnet) |
| `.claude/agents/arrival-router.md` | Arrival routes outside London (Sonnet) |
| `scripts/extract/*.js` | Compact page extractors the scouts run in the browser |
| `scripts/scout_tools.py` | Pre-filter (`near`), listing cache (`cache`), merge and rank (`rank`), TfL routes (`route`) |
| `scripts/geo.py` | Tube stations, map-sweep plan, police street-crime data |
| `artifact/scout.html` | The phone app (published as a claude.ai artifact) |
| `data/relay.json` | The phone app's link and how often the PC checks it |
| `start-scout.cmd` | Double-click to start the website |
| `server.py` | Local server: runs `claude -p "/scout [headless] …"` and streams progress (Python stdlib only) |
| `index.html` | Home page: search box + past searches (generated) |
| `results/logs/` | Raw Claude Code output per website search, for troubleshooting |
| `templates/home.html` | Home page template |
| `templates/report.html` | Report UI (opens with sample data on its own) |
| `scripts/build-report.ps1` | Injects a results JSON into the template |
| `results/` | One `.json` + `.html` per run |
| `CLAUDE.md` | Project notes and design preferences |

## Limits

- **Read-only.** Scouts never log in, message hosts, book, or enter personal/payment details.
- Prices and availability are as of the search; open the listing to confirm before booking.
- Station walk times are approximate — Airbnb hides exact addresses until you book.
- Airbnb may show a bot check or login wall. Scouts stop there and report what they found; the report marks that area as **blocked**. Signing in to Airbnb in the browser pane yourself usually helps.
