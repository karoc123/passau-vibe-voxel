"""Area of interest shared by all pipeline steps.

The voxel grid is anchored on Passau's cathedral (Dom St. Stephan) and is north-up (THETA = 0; a rotation would put
one street grid's walls on voxel faces, but the old town between the rivers has no single orientation).

World coords: EPSG:25832 (ETRS89 / UTM 32N), x = easting, y = northing.
Grid coords: (i, j) continuous, i = column (east), j = row (growing south); cell (c, r) spans [c, c+1) x [r, r+1).

The project grid is fixed to EPSG:25832: grid column i is easting GRID_X0 + i, grid row j is northing GRID_Y0 - j (whole
metres, THETA = 0), whatever the map's extent. The map is a window of it (MAP_R0, MAP_C0, MAP_D, MAP_W). Everything the
pipeline keys on coordinates (hashes, the noise of the crowns, curated places) is in these coordinates, so a cell
looks the same whichever piece of the map it is built in.

The map's extent, the volume's floor and the rivers' levels are configured in scripts/map.json (MAP_CONFIG=path for
another): the map is the window of the project grid from project cell (MAP_C0, MAP_R0), MAP_W x MAP_D cells; map
cells (every output's coordinates) are project cells less MAP_C0, MAP_R0.

Region (voxelize.py builds the volume region by region, scripts/region.py): with VOXEL_REGION=ra,rb,ca,cb (map cells)
in the environment, D and W are the region's rows and columns, R0, C0 its first project row and column (MR0, MC0 its
first map row and column), and to_grid / to_world map between EPSG:25832 and the region's own cells (cell (c, r) of
the region is project cell (C0 + c, R0 + r)). MAP_D, MAP_W stay the map's. Without it the region is the map (R0, C0 =
MAP_R0, MAP_C0: to_grid gives map cells).
"""
import json
import os
import math
from pathlib import Path

import numpy as np

CONFIG_PATH = Path(os.environ.get("MAP_CONFIG", Path(__file__).with_name("map.json")))
CONFIG = json.load(open(CONFIG_PATH))
CRS = CONFIG["crs"]  # ETRS89 / UTM 32N, the CRS of the Bavarian open data
GRID_X0, GRID_Y0 = CONFIG["grid"]["x0"], CONFIG["grid"]["y0"]  # EPSG:25832 of the project grid's corner (827371, 5390500)
CX, CY = float(CONFIG["anchor"]["x"]), float(CONFIG["anchor"]["y"])  # Dom St. Stephan, Passau
THETA = math.radians(0.0)
I0, J0 = round(CX - GRID_X0), round(GRID_Y0 - CY)  # project grid position of the anchor (the Dom: 1980, 733)
DX = I0 - 700  # columns added in the west since the first trial cut: curated grid columns were traced on that one
RAW = "data/raw"
# the map: the window of the project grid that is built, its corner MAP_R0, MAP_C0 (project rows and columns, on
# multiples of 1024 so that the map's and the project grid's blocks coincide), its size MAP_D x MAP_W. Passau: 3200 x
# 1408 m from the Hauptbahnhof and St. Nikola east over the Altstadt peninsula to the Dreiflüsseeck, with Veste
# Oberhaus and the Ilzstadt in the north and the Innstadt in the south. Map cells (what every output is in: the tiles,
# the viewer's coordinates, data/*.npz) are the project grid's less MAP_R0, MAP_C0
MAP_R0, MAP_C0 = CONFIG["map"]["row0"], CONFIG["map"]["col0"]
MAP_D, MAP_W = CONFIG["map"]["rows"], CONFIG["map"]["cols"]
assert MAP_R0 % 1024 == 0 and MAP_C0 % 1024 == 0, "the map's corner is not on the project grid's 1024 m blocks"
# the volume's floor in metres above sea level, pinned for the project (the map's lowest terrain, 290.57 m, less the
# 3 m slab under it): voxel z = metres above sea level - BASE wherever on the map, not the lowest point of what is built
BASE = CONFIG["base"]
# the rivers' water level (m a.s.l.) where OSM's outlines do not reach (voxelize.py takes the rivers from the terrain
# model there): the median of the terrain model under OSM's water on this map, pinned like BASE; per stretch where the
# config gives stretches (river_level)
RIVER_LEVEL = CONFIG["rivers"]["level"]
RIVER_STRETCHES = [(tuple(s["box"]), s["level"]) for s in CONFIG["rivers"].get("stretches", [])]
# the region being built (voxelize.py builds the volume region by region, scripts/region.py): R0, C0 its first row
# and column in the project grid, D x W its size; without VOXEL_REGION the region is the map
R0, C0 = MAP_R0, MAP_C0
D, W = MAP_D, MAP_W
CORE = (0, D, 0, W)  # the region's core (rows, columns of its own cells): what a region build writes
if os.environ.get("VOXEL_REGION"):  # (in map cells)
    _ra, _rb, _ca, _cb = map(int, os.environ["VOXEL_REGION"].split(","))
    _k = os.environ.get("VOXEL_CORE", os.environ["VOXEL_REGION"])
    _kr0, _kr1, _kc0, _kc1 = map(int, _k.split(","))
    R0, C0, D, W = MAP_R0 + _ra, MAP_C0 + _ca, _rb - _ra, _cb - _ca
    CORE = (_kr0 - _ra, _kr1 - _ra, _kc0 - _ca, _kc1 - _ca)
MR0, MC0 = R0 - MAP_R0, C0 - MAP_C0  # the region's first row and column in map cells
OSM_PATH = os.environ.get("VOXEL_OSM", f"{RAW}/osm.json")  # (a region's own cut of it: regions.py)


def river_level(rows, cols):
    """the rivers' level (m a.s.l.) at the region's cells (rows, cols: broadcastable integer arrays): the first config
    stretch whose box holds the cell's centre, else RIVER_LEVEL. A function of the project grid's coordinates alone,
    so the same in every region. float64 array, or a float where there are no stretches"""
    if not RIVER_STRETCHES:
        return RIVER_LEVEL
    r, c = np.broadcast_arrays(np.asarray(rows) + R0, np.asarray(cols) + C0)
    x, y = GRID_X0 + c + 0.5, GRID_Y0 - r - 0.5
    out = np.full(r.shape, np.nan)
    for (x0, y0, x1, y1), lv in RIVER_STRETCHES:
        m = np.isnan(out) & (x >= x0) & (x < x1) & (y >= y0) & (y < y1)
        out[m] = lv
    return np.where(np.isnan(out), RIVER_LEVEL, out)


EU = np.array([math.cos(THETA), math.sin(THETA)])   # grid +i in world
EV = np.array([math.sin(THETA), -math.cos(THETA)])  # grid +j in world


def to_grid(x, y):
    """EPSG:25832 -> the region's cells (the project grid's less R0, C0: exact, see voxelize.py)"""
    dx, dy = np.asarray(x) - CX, np.asarray(y) - CY
    return I0 + dx * EU[0] + dy * EU[1] - C0, J0 + dx * EV[0] + dy * EV[1] - R0


def to_world(i, j):
    u, v = np.asarray(i) + C0 - I0, np.asarray(j) + R0 - J0
    return CX + u * EU[0] + v * EV[0], CY + u * EU[1] + v * EV[1]


def world_bounds(margin=0):
    xs, ys = to_world(np.array([0, W, W, 0]), np.array([0, 0, D, D]))
    return xs.min() - margin, ys.min() - margin, xs.max() + margin, ys.max() + margin
