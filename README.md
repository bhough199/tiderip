# Tiderip

Wind-against-current forecast map for the Salish Sea (Nanaimo ⇄ Gulf Islands ⇄
Saanich Inlet/Sidney ⇄ San Juan County, east to Bellingham Bay and south past
Race Rocks). Highlights where and when the wind opposes the tidal current — the
conditions that build short, steep chop — with thresholds tuned for a small
power boat.

**How it works:** a GitHub Actions job runs every 6 hours, pulls the SalishSeaCast
ocean-current forecast (UBC), the ECCC HRDPS 2.5 km wind forecast, and the latest
wind observations from NOAA/ECCC stations in the region, regrids the forecasts
onto a common ~600 m grid, and publishes a compact binary payload plus a static
web app to GitHub Pages. Your phone downloads the whole forecast in one go
(a few MB) and everything after that runs locally, so it keeps working with no
signal.

## Features

- **Heatmap** of wind-against-current severity (bilinear-smoothed rendering),
  plus cobalt-blue shading wherever wind alone exceeds your comfort threshold
  and faint grey-teal where opposition exists but is below your thresholds.
- **Rip bar**: 48 h strip for a selected point (yellow star; Boundary Pass by
  default) showing hourly opposition bars, a teal current-speed curve whose
  valleys (circled) are slack and peaks are max ebb/flood, date ticks, and
  night shading. Drag to scrub time; play to animate.
- **Tap to inspect** any water point: wind (kt and mph), current, opposition
  angle and score.
- **Pass & crossing shortcuts** (magenta diamonds + settings list) that retarget
  the rip bar.
- **Arrow overlays**: wind, current, both (shared origin), or off — length
  scales with magnitude, density adapts to zoom.
- **Route / departure planner**: draw a route by tapping waypoints, set cruise
  speed and a travel window (default 06–19 h); the rip bar then treats each hour
  as a departure time (green = clear run, warm = opposition en route, blue =
  wind over comfort, grey = outside window/forecast) and the route line repaints
  with the conditions you'd meet at each segment. Routes are stored on-device.
- **Model-vs-observed trust check**: magenta rings mark real weather stations
  (NDBC + auto-discovered ECCC SWOB stations in the region) comparing the latest
  measured wind against the model at build time; average error summarized in the
  info panel.
- **Basemaps**: CARTO Positron (default, minimal) or OpenStreetMap, with an
  OpenSeaMap seamark overlay; region bounding box drawn, outside faded.
- **Offline-first PWA**: service worker caches the app shell, forecast, and
  viewed tiles; a banner warns when data is >12 h old.
- **ⓘ info panel** (bottom right) with usage instructions and data credits.

## One-time setup

1. Create a new GitHub repository (public, so GitHub Pages is free) and push
   these files to the `main` branch (including the hidden `.github/` folder).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to the **Actions** tab, select **build-forecast**, click **Run workflow**.
   The first run takes ~5–10 minutes (it downloads ~100 GRIB files).
4. Open `https://<your-username>.github.io/<repo-name>/` on your phone and use
   **Add to Home Screen** to install it like an app.

After that, the workflow runs itself every 6 hours (~5:23 / 11:23 AM & PM
Pacific in summer; GitHub's scheduler can add delays). No servers, no accounts
beyond GitHub, no cost. Note: GitHub disables scheduled workflows after 60 days
without repo activity — one click in the Actions tab re-enables.

## Using it on the water

- Open the app while you still have signal (at the dock, at anchor with a bar
  or two). The service worker caches the forecast and the map tiles you view.
- With no signal, the app serves the last-downloaded forecast and shows its age.
- All thresholds, arrow mode, and saved routes persist on the device.

## Architecture

```
pipeline/            Python — runs in GitHub Actions
  config.py            region bbox, output grid, source constants
  fetch_currents.py    SalishSeaCast via ERDDAP → regridded u,v (knots)
  fetch_wind.py        HRDPS WIND/WDIR GRIB2 via MSC Datamart → regridded
  fetch_obs.py         latest wind obs: NDBC (fixed) + ECCC SWOB
                       (auto-discovered from Datamart station lists)
  build_forecast.py    aligns hours, quantizes, adds obs-vs-model, writes web/data/*
web/                 static app — served by GitHub Pages
  index.html, app.js   Leaflet map, heat overlay, arrows, rip bar, routes, info
  sw.js                offline caching (shell cache-first, data network-first)
                       — bump the SHELL version string whenever shell files change
.github/workflows/
  build-forecast.yml   cron every 6 h + manual trigger + deploy on push
```

Forecast horizon is limited by SalishSeaCast, which extends ~30–36 h ahead
(HRDPS goes to 48 h, but the app only shows hours where **both** models exist).
Client-side score math: wind kt × current kt × cos(opposition angle), gated by
user thresholds (wind thresholds set in mph in the UI, stored as mph, computed
in kt).

## Data sources, credits, licenses

- **Currents:** Forecasted near-surface depth-averaged current fields from the
  SalishSeaCast model (Soontiens et al., 2016; Soontiens & Allen, 2017),
  dataset `ubcSSfDepthAvgdCurrents1h`, downloaded from
  https://salishsea.eos.ubc.ca/erddap/. © SalishSeaCast Project Contributors
  and The University of British Columbia, Apache License 2.0.
- **Wind forecast:** Environment and Climate Change Canada, High Resolution
  Deterministic Prediction System (HRDPS), via MSC Datamart
  (https://dd.weather.gc.ca).
- **Wind observations:** NOAA NDBC (https://www.ndbc.noaa.gov) and ECCC SWOB-ML
  via MSC Datamart.
- **Base maps:** © OpenStreetMap contributors; © CARTO (Positron tiles);
  seamarks © OpenSeaMap contributors.

App code is MIT licensed (see LICENSE).

## Safety

This is a hobby planning aid built on model output. Model currents in narrow
passes are frequently wrong in magnitude even when timing is right, and
model-derived slack times are hourly-resolution estimates (±30 min at best).
Check CHS / NOAA current tables for the passes, carry proper charts, and treat
every prediction as a hypothesis until confirmed by your own eyes.

## Troubleshooting

- **"Could not load the forecast" on a fresh deploy** — run the build-forecast
  workflow once from the Actions tab.
- **Changes don't appear after an update** — the service worker needs one
  load-close-reopen cycle; make sure the `SHELL` version in `web/sw.js` was
  bumped with the change. Worst case: clear site data for the domain.
- **Workflow fails in `fetch_currents`** — the ERDDAP server is occasionally
  down; re-run. If the dataset ID changed, check
  https://salishsea.eos.ubc.ca/erddap/ and update `config.py`.
- **Workflow fails in `fetch_wind`** — Datamart paths change occasionally;
  both current and legacy layouts are tried. Check
  https://eccc-msc.github.io/open-data/ for announcements.
- **A Canadian station is missing from the map** — stations are auto-discovered
  from Datamart's station lists and skipped silently on any failure; the
  Actions log prints skip reasons for priority stations (Kelp Reefs, Race
  Rocks, etc.). Latest obs live under
  https://dd.weather.gc.ca/today/observations/swob-ml/latest/ .
- **Wind direction looks rotated** — we assume ECCC's `WDIR_AGL-10m` is degrees
  true (direction the wind blows *from*). Validate against the station rings on
  a windy day and report if it's off.
