"""Fetch ECCC HRDPS 10 m wind (speed + direction) and regrid to the Tiderip grid.

We use the WIND (speed) and WDIR (direction, degrees true, blowing FROM) products
rather than UGRD/VGRD, because HRDPS is on a rotated lat-lon grid where U/V are
grid-relative and would need rotation. WIND/WDIR are earth-relative as published.

Datamart layout (two generations, we try both):
  new:    {DATAMART}/{YYYYMMDD}/WXO-DD/model_hrdps/continental/2.5km/{HH}/{FFF}/{fname}
  legacy: {DATAMART}/model_hrdps/continental/2.5km/{HH}/{FFF}/{fname}
  fname = {YYYYMMDD}T{HH}Z_MSC_HRDPS_{VAR}_RLatLon0.0225_PT{FFF}H.grib2
"""
from __future__ import annotations

import datetime as dt
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
import xarray as xr
from scipy.spatial import cKDTree

import config as C


def _fname(run: dt.datetime, var: str, lead: int) -> str:
    return (
        f"{run:%Y%m%d}T{run:%H}Z_MSC_HRDPS_{var}_RLatLon0.0225_PT{lead:03d}H.grib2"
    )


def _urls(run: dt.datetime, var: str, lead: int):
    f = _fname(run, var, lead)
    yield f"{C.DATAMART}/{run:%Y%m%d}/WXO-DD/model_hrdps/continental/2.5km/{run:%H}/{lead:03d}/{f}"
    yield f"{C.DATAMART}/model_hrdps/continental/2.5km/{run:%H}/{lead:03d}/{f}"


def _exists(url: str) -> bool:
    try:
        return requests.head(url, timeout=30, allow_redirects=True).status_code == 200
    except requests.RequestException:
        return False


def pick_run(max_lead_needed: int) -> dt.datetime:
    """Newest run that is published, including its furthest lead we need."""
    now = dt.datetime.now(dt.timezone.utc)
    cand = now - dt.timedelta(hours=C.HRDPS_AVAIL_LAG_H)
    cand = cand.replace(minute=0, second=0, microsecond=0)
    cand = cand.replace(hour=(cand.hour // 6) * 6)
    for back in range(0, 4):
        run = cand - dt.timedelta(hours=6 * back)
        probe_lead = min(max_lead_needed, 47)
        if any(_exists(u) for u in _urls(run, C.WIND_SPEED_VAR, probe_lead)):
            print(f"wind: using HRDPS run {run:%Y-%m-%d %HZ}")
            return run
    raise RuntimeError("No published HRDPS run found (checked last 4 cycles)")


def _download(run: dt.datetime, var: str, lead: int) -> str | None:
    for url in _urls(run, var, lead):
        try:
            r = requests.get(url, timeout=180)
            if r.status_code == 200:
                tmp = tempfile.NamedTemporaryFile(suffix=".grib2", delete=False)
                tmp.write(r.content)
                tmp.close()
                return tmp.name
        except requests.RequestException:
            continue
    return None


def _read_grib(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
    var = list(ds.data_vars)[0]
    return (
        np.asarray(ds[var], dtype=np.float32),
        np.asarray(ds["latitude"], dtype=np.float64),
        np.asarray(ds["longitude"], dtype=np.float64),
    )


def fetch_wind(hours_utc: list) -> dict:
    """hours_utc: list of timezone-naive UTC datetime64[h] we need wind for."""
    hours = [h.astype("datetime64[h]").astype(dt.datetime) for h in np.asarray(hours_utc)]
    run = pick_run(max_lead_needed=48)
    run_naive = run.replace(tzinfo=None)
    leads = []
    for h in hours:
        lead = int((h - run_naive).total_seconds() // 3600)
        if 0 <= lead <= 48:
            leads.append((h, lead))
    if not leads:
        raise RuntimeError("No overlap between requested hours and HRDPS run horizon")

    # download all speed+dir files concurrently
    jobs = [(C.WIND_SPEED_VAR, ld) for _, ld in leads] + [
        (C.WIND_DIR_VAR, ld) for _, ld in leads
    ]
    paths: dict[tuple[str, int], str | None] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_download, run, v, ld): (v, ld) for v, ld in jobs}
        for fut in futs:
            paths[futs[fut]] = fut.result()

    # geo + crop indices from the first successful file
    first = next(p for p in paths.values() if p)
    _, glat, glon = _read_grib(first)
    glon = np.where(glon > 180, glon - 360, glon)
    pad = 0.05
    inbox = (
        (glon >= C.BBOX["lon0"] - pad) & (glon <= C.BBOX["lon1"] + pad)
        & (glat >= C.BBOX["lat0"] - pad) & (glat <= C.BBOX["lat1"] + pad)
    )
    ys, xs = np.where(inbox)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
    sub_lon = glon[y0 : y1 + 1, x0 : x1 + 1].ravel()
    sub_lat = glat[y0 : y1 + 1, x0 : x1 + 1].ravel()
    print(f"wind: HRDPS crop {y1-y0+1}x{x1-x0+1} cells")

    # nearest-neighbour map to target grid
    lons = np.arange(C.BBOX["lon0"] + C.DLON / 2, C.BBOX["lon1"], C.DLON)
    lats = np.arange(C.BBOX["lat0"] + C.DLAT / 2, C.BBOX["lat1"], C.DLAT)
    tlon, tlat = np.meshgrid(lons, lats)
    coslat = np.cos(np.deg2rad(48.8))
    tree = cKDTree(np.column_stack([sub_lon * coslat, sub_lat]))
    _, idx = tree.query(np.column_stack([tlon.ravel() * coslat, tlat.ravel()]), k=1)
    ny, nx = tlat.shape

    out_hours, spd_list, dir_list = [], [], []
    for h, ld in leads:
        p_s, p_d = paths.get((C.WIND_SPEED_VAR, ld)), paths.get((C.WIND_DIR_VAR, ld))
        if not p_s or not p_d:
            print(f"wind: missing lead {ld:03d}h, skipping")
            continue
        s, _, _ = _read_grib(p_s)
        d, _, _ = _read_grib(p_d)
        s = s[y0 : y1 + 1, x0 : x1 + 1].ravel()[idx].reshape(ny, nx) * C.MS_TO_KT
        d = d[y0 : y1 + 1, x0 : x1 + 1].ravel()[idx].reshape(ny, nx)
        out_hours.append(np.datetime64(h, "h"))
        spd_list.append(s.astype(np.float32))
        dir_list.append(d.astype(np.float32))
        os.unlink(p_s)
        os.unlink(p_d)

    print(f"wind: got {len(out_hours)} hours from run {run:%Y-%m-%d %HZ}")
    return dict(
        times=np.array(out_hours),
        speed=np.stack(spd_list),
        direction=np.stack(dir_list),
        run=f"{run:%Y-%m-%dT%H}Z",
    )


if __name__ == "__main__":
    now = np.datetime64(dt.datetime.now(dt.timezone.utc).replace(tzinfo=None), "h")
    fetch_wind([now + np.timedelta64(i, "h") for i in range(6)])
