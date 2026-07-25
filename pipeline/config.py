"""Tiderip configuration: region, output grid, data sources."""

# Region: Nanaimo to San Juan County incl. Saanich Inlet, Sidney, Gulf Islands,
# extended east to Bellingham Bay and south past Race Rocks.
BBOX = dict(lon0=-124.05, lon1=-122.40, lat0=48.25, lat1=49.27)

# Output grid (regular lat/lon). ~600 m cells.
DLON = 0.008
DLAT = 0.0055

# --- Currents: SalishSeaCast (UBC EOAS) ---
# Near-surface depth-averaged currents, hourly, ~500 m NEMO grid.
# License: Apache 2.0. Please keep the citation in README intact.
ERDDAP = "https://salishsea.eos.ubc.ca/erddap/griddap"
CURRENTS_DATASET = "ubcSSfDepthAvgdCurrents1h"
CURRENTS_VARS = ("VelEast5", "VelNorth5")  # upper ~5 m: closest to what a small boat feels
BATHY_DATASET = "ubcSSnBathymetryV21-08"   # provides 2-D longitude/latitude of the NEMO grid

# --- Wind: ECCC HRDPS 2.5 km via MSC Datamart ---
DATAMART = "https://dd.weather.gc.ca"
HRDPS_RUNS = (0, 6, 12, 18)          # UTC run hours
HRDPS_AVAIL_LAG_H = 4                # a run is usually fully published ~3-4 h after run time
WIND_SPEED_VAR = "WIND_AGL-10m"      # 10 m wind speed (m/s)
WIND_DIR_VAR = "WDIR_AGL-10m"        # 10 m wind direction (degrees true, direction wind is FROM)

MAX_HOURS = 48
MS_TO_KT = 1.9438445

# Quantization for the binary payload
WSPD_SCALE = 4.0      # uint8: kt * 4  (0 .. 63.75 kt)
WDIR_SCALE = 1.5      # uint8: deg / 1.5 (0 .. 358.5)
CUR_SCALE = 16.0      # int8:  kt * 16 (-7.94 .. +7.94 kt)

OUT_DIR = "web/data"
