# Tiderip

Wind-against-current forecast map for the Salish Sea (Nanaimo ⇄ Gulf Islands ⇄
Saanich Inlet ⇄ San Juan County). Highlights where and when the wind opposes the
tidal current — the conditions that build short, steep chop — with thresholds
tuned for a small power boat.

**How it works:** a GitHub Actions job runs every 6 hours, pulls the SalishSeaCast
ocean-current forecast (UBC) and the ECCC HRDPS 2.5 km wind forecast, regrids both
onto a common ~600 m grid, and publishes a compact binary payload plus a static
web app to GitHub Pages. Your phone downloads the whole forecast in one go
(~1–2 MB) and everything after that — the heatmap, tap-to-inspect, threshold
sliders, the rip bar — runs locally, so it keeps working with no signal.

## One-time setup

1. Create a new GitHub repository (public, so GitHub Pages is free) and push
   these files to the `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to the **Actions** tab, select **build-forecast**, click **Run workflow**.
   The first run takes ~5–10 minutes (it downloads ~100 GRIB files).
4. Open `https://<your-username>.github.io/<repo-name>/` on your phone and use
   **Add to Home Screen** to install it like an app.

After that, the workflow runs itself every 6 hours. No servers, no accounts
beyond GitHub, no cost.

## Using it on the water

- Open the app while you still have signal (at the dock, at anchor with a bar
  or two). The service worker caches the forecast and the map tiles you view.
- With no signal, the app serves the last-downloaded forecast and shows a
  banner with its age. Data more than ~12 h old gets a stale warning.
- Thresholds (min wind / min current / opposition cone) persist between visits.

## Architecture

```
pipeline/            Python — runs in GitHub Actions
  config.py            region bbox, grid, source constants
  fetch_currents.py    SalishSeaCast via ERDDAP → regridded u,v (knots)
  fetch_wind.py        HRDPS WIND/WDIR GRIB2 via MSC Datamart → regridded
  build_forecast.py    aligns hours, quantizes, writes web/data/*
web/                 static app — served by GitHub Pages
  index.html, app.js   Leaflet map, heat overlay, wind arrows, rip bar
  sw.js                offline caching (shell cache-first, data network-first)
.github/workflows/
  build-forecast.yml   cron every 6 h + manual trigger + deploy on push
```

Forecast horizon is limited by SalishSeaCast, which extends ~30–36 h ahead
(HRDPS goes to 48 h, but the app only shows hours where **both** models exist).

## Data sources, credits, licenses

- **Currents:** Forecasted near-surface depth-averaged current fields from the
  SalishSeaCast model (Soontiens et al., 2016; Soontiens & Allen, 2017),
  dataset `ubcSSfDepthAvgdCurrents1h`, downloaded from
  https://salishsea.eos.ubc.ca/erddap/. © SalishSeaCast Project Contributors
  and The University of British Columbia, Apache License 2.0.
- **Wind:** Environment and Climate Change Canada, High Resolution Deterministic
  Prediction System (HRDPS), via MSC Datamart (https://dd.weather.gc.ca).
- **Base map:** © OpenStreetMap contributors.

## Safety

This is a hobby planning aid built on model output. Model currents in narrow
passes are frequently wrong in magnitude even when timing is right. Check CHS /
NOAA current tables for the passes, carry proper charts, and treat every
prediction as a hypothesis until confirmed by your own eyes.

## Troubleshooting

- **"Could not load the forecast" on a fresh deploy** — run the build-forecast
  workflow once from the Actions tab.
- **Workflow fails in `fetch_currents`** — the ERDDAP server is occasionally
  down; re-run. If the dataset ID changed, check
  https://salishsea.eos.ubc.ca/erddap/ and update `config.py`.
- **Workflow fails in `fetch_wind`** — Datamart paths change occasionally;
  both current and legacy layouts are tried. Check
  https://eccc-msc.github.io/open-data/ for announcements.
- **Wind direction looks rotated** — we assume ECCC's `WDIR_AGL-10m` is degrees
  true (direction the wind blows *from*). Validate against a known station
  (e.g. compare the app to Environment Canada's Kelp Reefs or Sand Heads
  observations on a windy day) and report back if it's off.
