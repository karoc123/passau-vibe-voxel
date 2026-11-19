"""Which building every 1 m column belongs to: the viewer (web/src/city.ts) shows each building once all its tiles are
in, the mesher (web/src/mesher.worker.ts) never merges faces across buildings.

Output (web/public/data/): zones.bin = uint16 building[D, W] (0: none), zones.json = {"buildings": [[cx, cy, columns,
x0, y0, x1, y1], ...]} (centroid and bounding box in metres, building k + 1 in zones.bin).
"""
import gzip
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

from aoi import D, W
from osm import OSM, footprints

OUT = Path("web/public/data")
osm = OSM()

# buildings (whole buildings, not parts)
blds = [(g, t, oid) for oid, typ, t, g in osm.areas
        if t.get("building") not in (None, "no") and "building:part" not in t and t.get("location") != "underground"]
blds.sort(key=lambda b: -b[0].area)  # small ones burnt last stay visible inside big ones
# the footprints as voxelize.py drew them (moved onto LoD2's)
bld, n_extra = footprints({oid: i + 1 for i, (g, t, oid) in enumerate(blds)}, lambda k: len(blds) + 1 + k)
bld = bld.astype(np.uint16)
blds += [(None, {"building": "yes"}, None)] * n_extra  # (buildings from LoD2 alone)
print("buildings", len(blds), "columns", int((bld > 0).sum()))

rr, cc = np.mgrid[0:D, 0:W]


# per building: centroid and bounding box (metres)
def stats(lab, n):
    idx = np.arange(1, n + 1)
    cnt = ndimage.sum_labels(np.ones_like(lab, np.float32), lab, idx)
    cy = ndimage.sum_labels(rr.astype(np.float32), lab, idx) / np.maximum(cnt, 1)
    cx = ndimage.sum_labels(cc.astype(np.float32), lab, idx) / np.maximum(cnt, 1)
    sl = ndimage.find_objects(lab, n)
    out = []
    for i in range(n):
        s = sl[i]
        out.append([round(float(cx[i]), 1), round(float(cy[i]), 1), int(cnt[i]),
                    *( [s[1].start, s[0].start, s[1].stop, s[0].stop] if s else [0, 0, 0, 0])])
    return out

meta = {"buildings": stats(bld.astype(np.int32), len(blds))}
with gzip.GzipFile(OUT / "zones.bin", "wb", compresslevel=9, mtime=0) as fh:
    fh.write(bld.tobytes())
json.dump(meta, open(OUT / "zones.json", "w"))
print("wrote zones.bin", (OUT / "zones.bin").stat().st_size // 1024, "KB")
