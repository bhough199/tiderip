"""Fetch SalishSeaCast near-surface currents and regrid to the Tiderip output grid.

Strategy
--------
1. Download the NEMO grid geo-location (2-D lon/lat) from the bathymetry dataset.
2. Find the gridY/gridX index box covering our lat/lon bbox.
3. Request VelEast5/VelNorth5 for [now .. end of forecast] over that index box as NetCDF.
4. Nearest-neighbour regrid (cKDTree) onto the regular output grid.
   NaN velocities = land / outside model -> water mask.

Times: SalishSeaCast time stamps are hour *centres* (HH:30 UTC). We floor them to
the hour so they align with HRDPS lead times.
"""
from __future__ import annotations

import datetime as dt
import io
import tempfile

import numpy as np
import requests
import xarray as xr
from scipy.spatial import cKDTree

import config as C


def _target_grid():
    lons = np.arange(C.BBOX["lon0"] + C.DLON / 2, C.BBOX["lon1"], C.DLON)
    lats = np.arange(C.BBOX["lat0"] + C.DLAT / 2, C.BBOX["lat1"], C.DLAT)
    return lons, lats


def _download_nc(url: str) -> xr.Dataset:
    r = requests.get(url, timeout=600)
    r.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(suffix=".nc", delete=False)
    tmp.write(r.content)
    tmp.close()
    return xr.open_dataset(tmp.name)


def fetch_currents():
    # --- 1. NEMO grid geo-location ---
    url = f"{C.ERDDAP}/{C.BATHY_DATASET}.nc?longitude%5B(0):(last)%5D%5B(0):(last)%5D,latitude%5B(0):(last)%5D%5B(0):(last)%5D"
    bathy = _download_nc(url)
    glon = np.asarray(bathy["longitude"])
    glat = np.asarray(bathy["latitude"])

    # --- 2. index box covering our bbox (with padding) ---
    inbox = (
        (glon >= C.BBOX["lon0"]) & (glon <= C.BBOX["lon1"])
        & (glat >= C.BBOX["lat0"]) & (glat <= C.BBOX["lat1"])
    )
    ys, xs = np.where(inbox)
    if ys.size == 0:
        raise RuntimeError("Output bbox does not intersect the SalishSeaCast grid")
    y0, y1 = max(int(ys.min()) - 2, 0), min(int(ys.max()) + 2, glon.shape[0] - 1)
    x0, x1 = max(int(xs.min()) - 2, 0), min(int(xs.max()) + 2, glon.shape[1] - 1)
    print(f"currents: NEMO index box gridY {y0}:{y1} gridX {x0}:{x1}")

    # --- 3. data request from the current hour to the end of the forecast ---
    start = dt.datetime.now(dt.timezone.utc).replace(minute=30, second=0, microsecond=0)
    start_iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    varsel = ",".join(
        f"{v}%5B({start_iso}):(last)%5D%5B{y0}:{y1}%5D%5B{x0}:{x1}%5D"
        for v in C.CURRENTS_VARS
    )
    url = f"{C.ERDDAP}/{C.CURRENTS_DATASET}.nc?{varsel}"
    print(f"currents: requesting {url[:140]}...")
    ds = _download_nc(url)

    times = ds["time"].values.astype("datetime64[h]")  # floor HH:30 -> HH:00
    ve = np.asarray(ds[C.CURRENTS_VARS[0]], dtype=np.float32) * C.MS_TO_KT
    vn = np.asarray(ds[C.CURRENTS_VARS[1]], dtype=np.float32) * C.MS_TO_KT
    sub_lon = glon[y0 : y1 + 1, x0 : x1 + 1].ravel()
    sub_lat = glat[y0 : y1 + 1, x0 : x1 + 1].ravel()

    # --- 4. regrid: nearest NEMO cell for every output cell ---
    lons, lats = _target_grid()
    tlon, tlat = np.meshgrid(lons, lats)
    # scale lon by cos(lat) so "nearest" is metric-ish
    coslat = np.cos(np.deg2rad(48.8))
    tree = cKDTree(np.column_stack([sub_lon * coslat, sub_lat]))
    dist, idx = tree.query(np.column_stack([tlon.ravel() * coslat, tlat.ravel()]), k=1)

    nt = ve.shape[0]
    ny, nx = tlat.shape
    u = ve.reshape(nt, -1)[:, idx].reshape(nt, ny, nx)
    v = vn.reshape(nt, -1)[:, idx].reshape(nt, ny, nx)

    # cells whose nearest NEMO point is farther than ~700 m are outside the model
    too_far = (dist * 111.0 > 0.7).reshape(ny, nx)
    u[:, too_far] = np.nan
    v[:, too_far] = np.nan

    water = np.isfinite(u[0])
    print(
        f"currents: {nt} hours {times[0]}..{times[-1]}, grid {ny}x{nx}, "
        f"{int(water.sum())} water cells ({100*water.mean():.0f}%)"
    )
    return dict(times=times, u=u, v=v, water=water, lons=lons, lats=lats)


if __name__ == "__main__":
    fetch_currents()
