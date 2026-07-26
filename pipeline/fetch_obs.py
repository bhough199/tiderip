"""Fetch latest wind observations for trust comparison (model vs measured).

Two sources, each station skipped silently on any failure:
- NOAA NDBC realtime text feeds (https://www.ndbc.noaa.gov/data/realtime2/{ID}.txt)
- ECCC SWOB-ML "latest" feeds on MSC Datamart

NOTE on ECCC station IDs: these are best-guess TC identifiers. If a station never
appears in the app's Data section, its ID is wrong — check
https://dd.weather.gc.ca/observations/swob-ml/latest/ for the correct file name
and fix the entry below.
"""
from __future__ import annotations

import re

import requests

import config as C

NDBC_STATIONS = [
    ("New Dungeness buoy", "46088", 48.334, -123.179),
    ("Smith Island", "SISW1", 48.318, -122.843),
    ("Friday Harbor", "FRDW1", 48.545, -123.013),
]
ECCC_STATIONS = [
    ("Kelp Reefs", "CWZO", 48.548, -123.236),      # verify ID (see module docstring)
    ("Entrance Island", "CWEL", 49.209, -123.810),
    ("Saturna Island", "CWEZ", 48.783, -123.045),
    ("Race Rocks", "CWQK", 48.298, -123.531),
    ("Sand Heads", "CWVF", 49.106, -123.303),
]
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


def _swob(name, sid, lat, lon):
    r = requests.get(
        f"{C.DATAMART}/observations/swob-ml/latest/{sid}-AUTO-swob.xml", timeout=30
    )
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
        except Exception as e:  # noqa: BLE001 - station failures must not break builds
            print(f"obs: {name} ({sid}) skipped: {e}")
    for name, sid, lat, lon in ECCC_STATIONS:
        try:
            st = _swob(name, sid, lat, lon)
            if st:
                out.append(st)
        except Exception as e:  # noqa: BLE001
            print(f"obs: {name} ({sid}) skipped: {e}")
    print(f"obs: {len(out)} stations reporting")
    return out
