"""Fetch latest wind observations for trust comparison (model vs measured).

Sources:
- NOAA NDBC realtime text feeds (fixed list of 3 US stations)
- ECCC SWOB-ML on MSC Datamart: stations are AUTO-DISCOVERED at build time from
  Datamart's own station lists (marine + main), filtered to our bbox, so there
  are no hardcoded Canadian station IDs to go stale. Latest obs per station:
  https://dd.weather.gc.ca/today/observations/swob-ml/latest/{ID}-AUTO-swob.xml

Every station is skipped silently on any failure; obs can never break a build.
"""
from __future__ import annotations

import csv
import io
import re

import requests

import config as C

NDBC_STATIONS = [
    ("New Dungeness buoy", "46088", 48.334, -123.179),
    ("Smith Island", "SISW1", 48.318, -122.843),
    ("Friday Harbor", "FRDW1", 48.545, -123.013),
]
SWOB_LATEST = f"{C.DATAMART}/today/observations/swob-ml/latest"
STATION_LISTS = [
    f"{C.DATAMART}/today/observations/doc/swob-xml_marine_station_list.csv",
    f"{C.DATAMART}/today/observations/doc/swob-xml_station_list.csv",
]
MAX_ECCC = 10
MS_TO_KT = 1.9438445


def _ndbc(name, sid, lat, lon):
    r = requests.get(f"https://www.ndbc.noaa.gov/data/realtime2/{sid}.txt", timeout=30)
    r.raise_for_status()
    lines = r.text.splitlines()
    hdr = lines[0].split()
    i_dir, i_spd = hdr.index("WDIR"), hdr.index("WSPD")
    for line in lines[2:]:
        f = line.split()
        if len(f) <= i_spd or f[i_spd] == "MM" or f[i_dir] == "MM":
            continue
        return dict(
            name=name, lat=lat, lon=lon,
            obs_kt=float(f[i_spd]) * MS_TO_KT,
            obs_dir=float(f[i_dir]),
            obs_time=f"{f[0]}-{f[1]}-{f[2]} {f[3]}:{f[4]}Z",
        )
    return None


def _discover_eccc():
    """Stations from Datamart's own lists that fall inside our bbox."""
    found, seen = [], set()
    for url in STATION_LISTS:
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            print(f"obs: station list unavailable ({url.rsplit('/',1)[-1]}): {e}")
            continue
        rows = list(csv.reader(io.StringIO(r.text.lstrip("\ufeff"))))
        # find the header row (first row containing a lat-ish column)
        hi = next((i for i, row in enumerate(rows)
                   if any("lat" in c.lower() for c in row)), None)
        if hi is None:
            continue
        hdr = [c.strip().lower() for c in rows[hi]]
        def col(*keys):
            for k in keys:
                for j, c in enumerate(hdr):
                    if k in c:
                        return j
            return None
        c_id = col("iata", "tc id", "tc_id") or 0
        c_name = col("en name", "name")
        c_lat, c_lon = col("lat"), col("lon")
        if c_lat is None or c_lon is None or c_name is None:
            continue
        for row in rows[hi + 1:]:
            if len(row) <= max(c_id, c_name, c_lat, c_lon):
                continue
            try:
                lat, lon = float(row[c_lat]), float(row[c_lon])
            except ValueError:
                continue
            sid = row[c_id].strip().strip('"')
            if not re.fullmatch(r"[A-Z0-9]{3,7}", sid) or sid in seen:
                continue
            if (C.BBOX["lat0"] <= lat <= C.BBOX["lat1"]
                    and C.BBOX["lon0"] <= lon <= C.BBOX["lon1"]):
                seen.add(sid)
                found.append((row[c_name].strip().strip('"').title(), sid, lat, lon))
    print(f"obs: {len(found)} ECCC stations discovered in bbox")
    return found


def _swob(name, sid, lat, lon):
    r = requests.get(f"{SWOB_LATEST}/{sid}-AUTO-swob.xml", timeout=30)
    r.raise_for_status()
    txt = r.text

    def grab(pattern):
        m = re.search(
            rf'name="{pattern}[^"]*"\s+uom="([^"]+)"\s+value="([-\d.]+)"', txt
        )
        return (m.group(1), float(m.group(2))) if m else (None, None)

    uom, spd = grab("avg_wnd_spd_10m_pst")
    if spd is None:
        uom, spd = grab("wnd_spd")
    _, wdir = grab("avg_wnd_dir_10m_pst")
    if wdir is None:
        _, wdir = grab("wnd_dir")
    if spd is None or wdir is None:
        return None
    if uom == "km/h":
        spd /= 1.852
    elif uom == "m/s":
        spd *= MS_TO_KT
    tm = re.search(r'name="date_tm"[^>]*value="([^"]+)"', txt)
    return dict(
        name=name, lat=lat, lon=lon, obs_kt=spd, obs_dir=wdir,
        obs_time=tm.group(1) if tm else None,
    )


def fetch_obs():
    out = []
    for name, sid, lat, lon in NDBC_STATIONS:
        try:
            st = _ndbc(name, sid, lat, lon)
            if st:
                out.append(st)
        except Exception as e:  # noqa: BLE001 - never fatal
            print(f"obs: {name} ({sid}) skipped: {e}")
    n_eccc = 0
    for name, sid, lat, lon in _discover_eccc():
        if n_eccc >= MAX_ECCC:
            break
        try:
            st = _swob(name, sid, lat, lon)
            if st:
                out.append(st)
                n_eccc += 1
        except Exception:  # noqa: BLE001 - many listed stations have no latest file
            pass
    print(f"obs: {len(out)} stations reporting")
    return out
