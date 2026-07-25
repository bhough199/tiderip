"""Build the Tiderip forecast payload.

Output (web/data/):
  meta.json        grid definition, hour list (UTC ISO), scales, provenance
  forecast.bin     binary payload (see layout below)
  forecast.bin.gz  gzipped copy (preferred by the app; falls back to .bin)

Binary layout (little-endian), given ny*nx = N cells and H hours:
  uint8  mask[N]                     1 = water (current model cell), 0 = land/none
  then per hour h in order:
    uint8 windSpd[N]   kt * 4
    uint8 windDir[N]   deg / 1.5   (direction wind is FROM, true)
    int8  curU[N]      kt * 16    (eastward)
    int8  curV[N]      kt * 16    (northward)
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os

import numpy as np

import config as C
from fetch_currents import fetch_currents
from fetch_wind import fetch_wind


def main():
    cur = fetch_currents()
    wind = fetch_wind(list(cur["times"]))

    # align hours present in both (as python datetimes, tz-naive UTC)
    common = sorted(set(cur["times"].tolist()) & set(wind["times"].tolist()))
    now_h = dt.datetime.now(dt.timezone.utc).replace(
        minute=0, second=0, microsecond=0, tzinfo=None
    )
    common = [t for t in common if t >= now_h][: C.MAX_HOURS]
    if len(common) < 6:
        raise RuntimeError(f"Only {len(common)} overlapping forecast hours; aborting")
    ci = {t: i for i, t in enumerate(cur["times"].tolist())}
    wi = {t: i for i, t in enumerate(wind["times"].tolist())}

    ny, nx = cur["water"].shape
    n = ny * nx
    mask = cur["water"].astype(np.uint8).ravel()

    blob = bytearray()
    blob += mask.tobytes()
    for t in common:
        ws = wind["speed"][wi[t]].ravel()
        wd = wind["direction"][wi[t]].ravel()
        u = np.nan_to_num(cur["u"][ci[t]].ravel())
        v = np.nan_to_num(cur["v"][ci[t]].ravel())
        blob += np.clip(np.round(ws * C.WSPD_SCALE), 0, 255).astype(np.uint8).tobytes()
        blob += (np.round(wd / C.WDIR_SCALE).astype(np.int32) % 240).astype(np.uint8).tobytes()
        blob += np.clip(np.round(u * C.CUR_SCALE), -127, 127).astype(np.int8).tobytes()
        blob += np.clip(np.round(v * C.CUR_SCALE), -127, 127).astype(np.int8).tobytes()

    meta = dict(
        generated=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        grid=dict(
            lon0=C.BBOX["lon0"] + C.DLON / 2, dlon=C.DLON, nx=nx,
            lat0=C.BBOX["lat0"] + C.DLAT / 2, dlat=C.DLAT, ny=ny,
        ),
        hours=[t.strftime("%Y-%m-%dT%H:00Z") for t in common],
        scales=dict(wspd=C.WSPD_SCALE, wdir=C.WDIR_SCALE, cur=C.CUR_SCALE),
        sources=dict(
            currents=f"SalishSeaCast {C.CURRENTS_DATASET} (UBC EOAS, Apache-2.0)",
            wind=f"ECCC HRDPS 2.5km run {wind['run']}",
        ),
    )

    os.makedirs(C.OUT_DIR, exist_ok=True)
    with open(f"{C.OUT_DIR}/forecast.bin", "wb") as f:
        f.write(blob)
    with gzip.open(f"{C.OUT_DIR}/forecast.bin.gz", "wb", compresslevel=9) as f:
        f.write(blob)
    with open(f"{C.OUT_DIR}/meta.json", "w") as f:
        json.dump(meta, f, indent=1)

    print(
        f"wrote {len(common)} hours, {n} cells, "
        f"{len(blob)/1e6:.1f} MB raw, "
        f"{os.path.getsize(f'{C.OUT_DIR}/forecast.bin.gz')/1e6:.1f} MB gzipped"
    )


if __name__ == "__main__":
    main()
