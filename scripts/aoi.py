"""Area of interest shared by all pipeline steps.

The voxel grid is anchored on Passau's cathedral (Dom St. Stephan) and is north-up (THETA = 0; a rotation would put
one street grid's walls on voxel faces, but the old town between the rivers has no single orientation).

World coords: EPSG:25832 (ETRS89 / UTM 32N), x = easting, y = northing.
Grid coords: (i, j) continuous, i = column (east), j = row (growing south); cell (c, r) spans [c, c+1) x [r, r+1).

The project grid is fixed to EPSG:25832: grid column i is easting GRID_X0 + i, grid row j is northing GRID_Y0 - j (whole
metres, THETA = 0), whatever the map's extent. The map is the window of it from cell (0, 0) to (W, D). Everything the
pipeline keys on coordinates (hashes, the noise of the crowns, curated places) is in these coordinates, so a cell
looks the same whichever piece of the map it is built in.

Region (voxelize.py builds the volume region by region, scripts/region.py): with VOXEL_REGION=ra,rb,ca,cb in the
environment, D and W are the region's rows and columns, R0, C0 its first project row and column, and to_grid /
to_world map between EPSG:25832 and the region's own cells (cell (c, r) of the region is project cell (C0 + c,
R0 + r)). MAP_D, MAP_W stay the map's. Without it the region is the map (R0 = C0 = 0).
"""
import os
import math

import numpy as np

CRS = 25832  # ETRS89 / UTM 32N, the CRS of the Bavarian open data
CX, CY = 829351.0, 5389767.0  # Dom St. Stephan, Passau
THETA = math.radians(0.0)
# 3200 x 1408 m: from the Hauptbahnhof and St. Nikola east over the Altstadt peninsula to the Dreiflüsseeck, with
# Veste Oberhaus and the Ilzstadt in the north and the Innstadt in the south
W, D = 3200, 1408
I0, J0 = 1980, 733  # grid position of the Dom
DX = I0 - 700  # columns added in the west since the first trial cut: curated grid columns were traced on that one
RAW = "data/raw"
GRID_X0, GRID_Y0 = CX - I0, CY + J0  # EPSG:25832 of the project grid's corner (827371, 5390500)
# the volume's floor in metres above sea level, pinned for the project (the map's lowest terrain, 290.57 m, less the
# 3 m slab under it): voxel z = metres above sea level - BASE wherever on the map, not the lowest point of what is built
BASE = 287
# the rivers' water level (m a.s.l.) where OSM's outlines do not reach (voxelize.py takes the rivers from the terrain
# model there): the median of the terrain model under OSM's water on this map, pinned like BASE. A map along a river
# that falls by more than ~0.5 m across it will want a level per stretch here (WP6b-2)
RIVER_LEVEL = 290.921
MAP_D, MAP_W = D, W
R0, C0 = 0, 0
CORE = (0, D, 0, W)  # the region's core (rows, columns of its own cells): what a region build writes
if os.environ.get("VOXEL_REGION"):
    _ra, _rb, _ca, _cb = map(int, os.environ["VOXEL_REGION"].split(","))
    _k = os.environ.get("VOXEL_CORE", os.environ["VOXEL_REGION"])
    _kr0, _kr1, _kc0, _kc1 = map(int, _k.split(","))
    R0, C0, D, W = _ra, _ca, _rb - _ra, _cb - _ca
    CORE = (_kr0 - _ra, _kr1 - _ra, _kc0 - _ca, _kc1 - _ca)

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
