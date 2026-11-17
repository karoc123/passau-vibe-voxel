"""Area of interest shared by all pipeline steps.

The voxel grid is anchored on Passau's cathedral (Dom St. Stephan) and is north-up (THETA = 0; a rotation would put
one street grid's walls on voxel faces, but the old town between the rivers has no single orientation).

World coords: EPSG:25832 (ETRS89 / UTM 32N), x = easting, y = northing.
Grid coords: (i, j) continuous, i = column (east), j = row (growing south); cell (c, r) spans [c, c+1) x [r, r+1).
"""
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

EU = np.array([math.cos(THETA), math.sin(THETA)])   # grid +i in world
EV = np.array([math.sin(THETA), -math.cos(THETA)])  # grid +j in world


def to_grid(x, y):
    dx, dy = np.asarray(x) - CX, np.asarray(y) - CY
    return I0 + dx * EU[0] + dy * EU[1], J0 + dx * EV[0] + dy * EV[1]


def to_world(i, j):
    u, v = np.asarray(i) - I0, np.asarray(j) - J0
    return CX + u * EU[0] + v * EV[0], CY + u * EU[1] + v * EV[1]


def world_bounds(margin=0):
    xs, ys = to_world(np.array([0, W, W, 0]), np.array([0, 0, D, D]))
    return xs.min() - margin, ys.min() - margin, xs.max() + margin, ys.max() + margin
