"""Where the rivers are: the cells of the rivers (the large water bodies) and under their bridge decks.

Input: data/ground.npz (voxelize.py: its `water`, the cells whose top voxel is water).
Output: data/river.bin (tile_fields.py puts each node's part into its file, section rivr) = gzip of one [D, W] uint8
  grid, 1 where the river is (also under the bridge decks: gaps up to 60 m
  north-south closed), else 0. The viewer reads it
  only to keep a floodlit front's reflection off the river (web/src/voxelMaterial.ts, fields.ts riverAt).
and web/public/data/flood.json: {"river": the river's cells every 24 m as x, y pairs} (web/src/sim/river.ts: where the
  boat and the floatplane are put in, the way downstream; the minimap draws them).
The water's level is not here: it is where the voxels have it (scripts/map.json rivers, aoi.river_level; the viewer's
web/src/sim/river.ts waterTop). On a partial map (a check fixture) without a river, both are empty.
"""
import gzip
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

OUT = Path("web/public/data")
RIVER_MIN = 20000  # water bodies of this many cells or more are the rivers (the reaches between weirs are apart)
SAMPLE = 24  # m between the river's points (web/src/minimap.ts RIVER_SAMPLE)
water = np.load("data/ground.npz")["water"]  # voxelize.py: the cells whose top voxel is water
D, W = water.shape
lab, n = ndimage.label(water)
size = np.bincount(lab.ravel())
size[0] = 0
river = (size >= RIVER_MIN)[lab]
del lab
print("river cells", int(river.sum()), "of", int(water.sum()), "water cells, in", int((size >= RIVER_MIN).sum()), "bodies")
if not river.any():
    print("note: no river on this map (no water body of", RIVER_MIN, "cells)")
# under the bridge decks too: gaps of up to 60 m along the grid's columns (north-south) closed
river |= ndimage.binary_closing(river, structure=np.ones((61, 1), bool))
import window  # noqa: E402
from aoi import BOXES  # noqa: E402
if (built := window.built_mask(BOXES, (0, D, 0, W))) is not None:
    river &= built  # (nothing where nothing is built: window.py)

with gzip.GzipFile(Path("data") / "river.bin", "wb", compresslevel=9, mtime=0) as fh:
    fh.write(river.astype(np.uint8).tobytes())
json.dump({"river": [int(v) for y in range(0, D, SAMPLE) for x in range(0, W, SAMPLE) if river[y, x] for v in (x, y)]},
          open(OUT / "flood.json", "w"))
print("data/river.bin", (Path("data") / "river.bin").stat().st_size // 1024, "KB, river cells with the bridges'",
      int(river.sum()))
