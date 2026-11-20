"""The rivers' level as a slider (viewer: water level), in metres relative to the level on the survey day. Not
calibrated to a gauge: no gauge readings or historic flood levels are built in.

Where the map spans a weir (the Danube's Kachlet dam), the rivers stand at more than one level: scripts/map.json's
`rivers.stretches` (aoi.river_level). The slider raises every stretch by the same metres over its own surveyed level
(no reach spills into the next), and a cell floods when the water of its own stretch reaches it.

Input: data/ground.npz (voxelize.py: ground height and top colour), data/prep.npz (the DTM over the river, its real
water surface on the LiDAR day).
Output: data/flood.bin (tile_fields.py puts each node's part into its file) = gzip of two [D, W] uint8 grids,
  spill: the slider's value at which the river reaches the cell -- the highest ground over the water of its stretch
         on the cell's best path from the river (an embankment keeps the land behind it dry until the water tops it),
         in decimetres from -SPILL0 m (byte = 10 (m + SPILL0)); 255 never (above SPILL_MAX m)
  depth: the river bed under the LiDAR-day surface, in decimetres, estimated (LiDAR doesn't see through water): shallow
         shelves off the natural shores and sandbanks, a steep drop off the embanked left bank (the boulevards)
and web/public/data/flood.json: the LiDAR-day surface where no stretch is (surface0 at row 0, its fall per row), each
stretch's box (map cells x0, y0, x1, y1: the first that holds a cell is its stretch, as aoi.river_level) and level,
spill0, and the river's points every 24 m (x, y pairs; where the bed is: web/src/flood.ts shows the level's slider
while some are in view).
"""
import gzip
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

import aoi

OUT = Path("web/public/data")
SPILL0, SPILL_MAX = 3.0, 11.0  # m: the slider runs from -3 to +10 m (web/src/main.ts RIVER)
RIVER_MIN = 20000  # water bodies of this many cells or more are the rivers (the reaches between weirs are apart)
z = np.load("data/ground.npz")
g = z["g"].astype(np.int16)
D, W = g.shape
meta = json.load(open(OUT / "meta.json"))
base = meta["base"]
water = z["water"]  # voxelize.py: the cells whose top voxel is water (they carry the rivers' own colours)
lab, n = ndimage.label(water)
size = np.bincount(lab.ravel())
size[0] = 0
river = (size >= RIVER_MIN)[lab]
del lab
print("river cells", int(river.sum()), "of", int(water.sum()), "water cells, in", int((size >= RIVER_MIN).sum()), "bodies")

# each cell's stretch (the first stretch box that holds its centre, -1: none), as aoi.river_level
rr, cc = np.arange(D)[:, None], np.arange(W)[None, :]
stretch = np.full((D, W), -1, np.int8)
boxes = []
for k, ((x0, y0, x1, y1), lv) in enumerate(aoi.RIVER_STRETCHES):
    c0, r1 = (float(v) for v in aoi.to_grid(x0, y0))
    c1, r0 = (float(v) for v in aoi.to_grid(x1, y1))
    boxes.append(dict(box=[round(c0, 1), round(r0, 1), round(c1, 1), round(r1, 1)], level=lv))
    stretch[(stretch < 0) & (rr + 0.5 >= r0) & (rr + 0.5 < r1) & (cc + 0.5 >= c0) & (cc + 0.5 < c1)] = k

# the real surface on the LiDAR day where no stretch is (the voxels flatten it to one level): its fall along the rows
dtm = np.load("data/prep.npz", mmap_mode="r")["dtm"]
low = river & (stretch < 0)
rows = np.nonzero(low)[0]
v = dtm[low]
ok = np.isfinite(v) & (v < np.nanpercentile(v, 90))  # not the bank cells caught in the river outline
fall = np.polyfit(rows[ok], v[ok], 1)  # m per grid row (row 0 = north edge)
print(f"LiDAR-day surface {np.polyval(fall, 0):.2f} (row 0) .. {np.polyval(fall, D):.2f} (row {D}) m a.s.l.")
del dtm, v, rows, ok
# the ground over the water of its own stretch (m)
surf = (np.polyval(fall, np.arange(D, dtype=np.float64)) - base).astype(np.float32)[:, None]
lvs = np.array([b["level"] - base for b in boxes] + [0.0], np.float32)
over = np.where(stretch >= 0, g - lvs[stretch], g - surf)
first = np.clip(np.round((over + SPILL0) * 10), 0, 254).astype(np.uint8)
del over

# spill: grow the rivers decimetre by decimetre over the ground's height over its stretch's water
spill = np.full((D, W), 255, np.uint8)
spill[river] = first[river]
wet = river.copy()
for k in range(int(first[river].min()), int(SPILL_MAX * 10) + 1):
    reach = (first <= k) | wet
    ys, xs = np.nonzero(reach.any(1))[0], np.nonzero(reach.any(0))[0]
    sl = (slice(ys[0], ys[-1] + 1), slice(xs[0], xs[-1] + 1))
    lab, _ = ndimage.label(reach[sl])
    ids = np.unique(lab[wet[sl]])
    now = np.isin(lab, ids[ids > 0]) & ~wet[sl]
    spill[sl][now] = k
    wet[sl] |= now
del lab, reach, first, wet
print("cells reached per metre over the surveyed level",
      {m: int(((spill >= 10 * (m + SPILL0)) & (spill < 10 * (m + 1 + SPILL0))).sum()) for m in range(-1, 10)})

# river bed, schematic (nothing here is surveyed): it shelves gently with the distance from any shore, and drops
# faster off each row's westernmost bank
shore = ~river
d_any = ndimage.distance_transform_edt(~shore)
cols = np.arange(W)[None, :]
west = np.where(river, cols, W).min(axis=1)  # each row's westernmost river cell
d_west = np.where(river, cols - west[:, None], 9999)
rng = np.random.default_rng(7)
bars = ndimage.gaussian_filter(rng.standard_normal((D // 8 + 1, W // 8 + 1)), 3)
bars = np.kron(bars / bars.std(), np.ones((8, 8)))[:D, :W]
depth = np.minimum(0.45 + 0.03 * d_any + 0.45 * bars, 1.2 + 0.1 * d_west)
del bars, d_west
# the thalweg: one continuous deepest line down the river, wandering gently between the banks, so that as the level
# drops below the record the river narrows to a creek along it instead of breaking into pools
cen = np.full(D, np.nan)
half = np.zeros(D)
for r in range(D):
    cs = np.nonzero(river[r])[0]
    if len(cs) > 20:
        cen[r] = cs[np.argmax(d_any[r, cs])]
        half[r] = d_any[r, cs].max()
ok_r = np.isfinite(cen)
cen = np.interp(np.arange(D), np.nonzero(ok_r)[0], cen[ok_r])
half = np.interp(np.arange(D), np.nonzero(ok_r)[0], half[ok_r])
cen = ndimage.gaussian_filter1d(cen, 40) + 0.35 * ndimage.gaussian_filter1d(half, 40) * np.sin(np.arange(D) * 2 * np.pi / 520)
channel = 5.6 - 0.12 * np.abs(cols - cen[:, None])
bed = river | ndimage.binary_closing(river, structure=np.ones((61, 1), bool))  # under the bridge decks too
depth = np.where(bed & ~river, np.maximum(0.45 + 0.03 * ndimage.distance_transform_edt(bed), 1.0), depth)
depth = np.maximum(depth, channel)
depth = np.clip(np.where(bed, depth, 0), 0, 25.5)
dd = np.round(depth * 10).astype(np.uint8)
print("bed depth percentiles (m)", np.percentile(depth[river], [5, 25, 50, 75, 95]).round(2))

with gzip.GzipFile(Path("data") / "flood.bin", "wb", compresslevel=9, mtime=0) as fh:
    fh.write(spill.tobytes())
    fh.write(dd.tobytes())
# no gauge: the viewer's slider is in metres above or below this surveyed surface (a calibration to the Passau gauges
# would add their zero points here)
json.dump({"base": base, "surface0": round(float(np.polyval(fall, 0)), 3), "fall": round(float(fall[0]), 7),
           "voxel_top": int(g[low].max()), "spill0": SPILL0, "stretches": boxes,
           "river": [int(v) for y in range(0, D, 24) for x in range(0, W, 24) if dd[y, x] > 0 for v in (x, y)]},
          open(OUT / "flood.json", "w"))
print("data/flood.bin", (Path("data") / "flood.bin").stat().st_size // 1024, "KB")
