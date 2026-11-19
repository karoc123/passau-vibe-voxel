"""The rivers' level as a slider (viewer: water level), in metres relative to the level on the survey day. Not
calibrated to a gauge: no gauge readings or historic flood levels are built in.

Input: data/ground.npz (voxelize.py: ground height and top colour), data/prep.npz (the DTM over the river, its real
water surface on the LiDAR day).
Output: data/flood.bin (tile_fields.py puts each node's part into its file) = gzip of two [D, W] uint8 grids,
  spill: the lowest water level (m above the model base) at which the river reaches the cell -- the highest ground on
         the cell's best path from the river (an embankment keeps the land behind it dry until the water tops it); 255 never
  depth: the river bed under the LiDAR-day surface, in decimetres, estimated (LiDAR doesn't see through water): shallow
         shelves off the natural shores and sandbanks, a steep drop off the embanked left bank (the boulevards)
and web/public/data/flood.json: the LiDAR-day surface and its fall along the map, and the river's points every 24 m
(x, y pairs; where the bed is: web/src/flood.ts shows the level's slider while some are in view).
"""
import gzip
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

OUT = Path("web/public/data")
z = np.load("data/ground.npz")
g = z["g"].astype(np.int16)
D, W = g.shape
meta = json.load(open(OUT / "meta.json"))
base = meta["base"]
water = z["water"]  # voxelize.py: the cells whose top voxel is water (they carry the rivers' own colours)
lab, n = ndimage.label(water)
river = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1
print("river cells", river.sum(), "of", water.sum(), "water cells")

# the real surface on the LiDAR day (the voxels flatten it to one level): it falls ~0.45 m from south to north
dtm = np.load("data/prep.npz", mmap_mode="r")["dtm"]
rows = np.nonzero(river)[0]
v = dtm[river]
ok = np.isfinite(v) & (v < np.nanpercentile(v, 90))  # not the bank cells caught in the river outline
fall = np.polyfit(rows[ok], v[ok], 1)  # m per grid row (row 0 = north edge)
print(f"LiDAR-day surface {np.polyval(fall, 0):.2f} (row 0) .. {np.polyval(fall, D):.2f} (row {D}) m a.s.l.")

# spill height: grow the river level by level (the ground is in whole metres)
spill = np.full((D, W), 255, np.uint8)
wet = river.copy()
spill[river] = g[river].max()
for k in range(int(g[river].max()), int(g.max()) + 1):
    lab, _ = ndimage.label(g <= k)
    ids = np.unique(lab[river])
    now = np.isin(lab, ids[ids > 0]) & ~wet
    spill[now] = k
    wet |= now
print("spill levels", {k: int((spill == k).sum()) for k in range(4, 14)})

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
           "voxel_top": int(g[river].max()),
           "river": [int(v) for y in range(0, D, 24) for x in range(0, W, 24) if dd[y, x] > 0 for v in (x, y)]},
          open(OUT / "flood.json", "w"))
print("data/flood.bin", (Path("data") / "flood.bin").stat().st_size // 1024, "KB")
