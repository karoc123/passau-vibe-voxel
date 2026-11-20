"""Which building every 1 m column belongs to: the viewer (web/src/city.ts) shows each building once all its tiles are
in, the mesher (web/src/mesher.worker.ts) never merges faces across buildings.

Output: data/zones.bin = gzip of uint16 building[D, W] (0: none; for tile_fields.py, which puts each node's part into
its file, and web/tools/lamps.mjs), web/public/data/zones.json = {"boxes": [x0, y0, w, h, ...], "labels": [...]}
(per building, building k + 1 in zones.bin, its bounding box in metres as one flat list, four numbers a building: the
viewer loads it at startup and needs no more; per label of meta.json, in its order, the building under it, 0: none),
"keys": [...] (per building its stable key: "w<osm id>" / "r<osm id>" for an OSM way / relation, "lod2:<gml:id>" for
a building from LoD2 alone, lod2_ids.py).

Building ids (k + 1, the tiles' bldg, zones.bin) are build-local: a new extract or LoD2 tile renumbers them. Whatever
outlives a build (edits, players' references: docs/adr/0002-addressing.md) names a building by its key. Ids from
PLAYER_IDS (60000) up to 65535 are reserved for buildings players add (not built here): zones.py stops when the map's
buildings would reach them.

Window by window (window.py, halo 0: a column's building is its own): each window's columns from its rows of
data/footprints.npz, and per building the sums of its columns' count, rows and columns and its box in the window,
added up over the windows (whole numbers: the same centroid whatever the cover). zones.bin is written row band by row
band.

usage: uv run python scripts/zones.py [--windows NXxNY | --window-size METRES]
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np

import window as wmod
from aoi import D, W
import lod2_ids
from osm import OSM, footprints, lod2_only_ids

OUT = Path("web/public/data")
TMP = Path("data")
PLAYER_IDS = 60000  # building ids 60000..65535: players' builds (docs/adr/0002-addressing.md); the map's stay below


class Stats:
    """per building 1..n: columns, the sums of their rows and columns, and the box (min row, col; max row, col + 1)"""

    def __init__(self, n):
        self.n = n
        self.cnt, self.sr, self.sc = (np.zeros(n + 1, np.int64) for _ in range(3))
        self.r0, self.c0 = np.full(n + 1, 1 << 40, np.int64), np.full(n + 1, 1 << 40, np.int64)
        self.r1, self.c1 = np.full(n + 1, -1, np.int64), np.full(n + 1, -1, np.int64)

    def add(self, lab, r0, c0):
        """lab: a window's building ids, its first cell map cell (r0, c0)"""
        rr, cc = np.nonzero(lab)
        v = lab[rr, cc].astype(np.int64)
        rr, cc = rr + r0, cc + c0
        m = self.n + 1
        self.cnt += np.bincount(v, minlength=m)
        self.sr += np.bincount(v, rr, minlength=m).astype(np.int64)
        self.sc += np.bincount(v, cc, minlength=m).astype(np.int64)
        np.minimum.at(self.r0, v, rr)
        np.minimum.at(self.c0, v, cc)
        np.maximum.at(self.r1, v, rr + 1)
        np.maximum.at(self.c1, v, cc + 1)

    def rows(self):
        """per building [cx, cy, columns, x0, y0, x1, y1] (as ndimage's sum_labels and find_objects gave them)"""
        out = []
        for i in range(1, self.n + 1):
            k = max(int(self.cnt[i]), 1)
            box = [int(self.c0[i]), int(self.r0[i]), int(self.c1[i]), int(self.r1[i])] if self.cnt[i] else [0, 0, 0, 0]
            out.append([round(float(np.float64(self.sc[i]) / k), 1), round(float(np.float64(self.sr[i]) / k), 1),
                        int(self.cnt[i]), *box])
        return out


def main():
    osm = OSM()
    # buildings (whole buildings, not parts)
    blds = [(g, t, oid, typ) for oid, typ, t, g in osm.areas
            if t.get("building") not in (None, "no") and "building:part" not in t and t.get("location") != "underground"]
    blds.sort(key=lambda b: -b[0].area)  # small ones burnt last stay visible inside big ones
    ids = {oid: i + 1 for i, (g, t, oid, typ) in enumerate(blds)}
    neg = lod2_only_ids()
    n = len(blds) + len(neg)  # (then the buildings from LoD2 alone)
    if n >= PLAYER_IDS:  # ids 1 .. n are 16-bit everywhere (zones.bin, the tiles' bldg, the mesher), and the top ones
        # are the players' (PLAYER_IDS)
        sys.exit(f"zones.py: {n} buildings, but the map's building ids end below {PLAYER_IDS} (16-bit ids, "
                 f"{PLAYER_IDS}..65535 reserved for players' builds); see the 16-bit id notes in the plan "
                 "(tile bldg / zones.bin as uint32)")
    gml = lod2_ids.ids() if neg else {}
    keys = [f"{typ[0]}{oid}" for _, _, oid, typ in blds] + [f"lod2:{gml[-k]}" for k in neg]
    assert len(set(keys)) == len(keys), "zones.py: building keys not unique"
    labels = json.load(open(OUT / "meta.json"))["labels"]
    at = [(min(D - 1, int(np.floor(l["y"] + 0.5))), min(W - 1, int(np.floor(l["x"] + 0.5)))) for l in labels]
    under = [0] * len(labels)
    stats = Stats(n)
    cols = 0
    with gzip.GzipFile(TMP / "zones.bin", "wb", compresslevel=9, mtime=0) as fh:
        rows = wmod.RowWriter(fh, W, np.uint16)
        for win in wmod.from_args(sys.argv, D, W):
            # the footprints as voxelize.py drew them (moved onto LoD2's)
            bld, _ = footprints(ids, lambda k: len(blds) + 1 + k, (win.r0, win.r1, win.c0, win.c1), neg)
            bld = bld.astype(np.uint16)
            stats.add(bld, win.r0, win.c0)
            cols += int((bld > 0).sum())
            for k, (r, c) in enumerate(at):  # the building under each label (web/src/city.ts: a label waits for it)
                if win.holds(r, c):
                    under[k] = int(bld[r - win.r0, c - win.c0])
            rows.put(win.r0, win.c0, bld)
    print("buildings", n, "columns", cols)
    boxes = [v for _, _, _, x0, y0, x1, y1 in stats.rows() for v in (x0, y0, x1 - x0, y1 - y0)]
    json.dump({"boxes": boxes, "labels": under, "keys": keys}, open(OUT / "zones.json", "w"), separators=(",", ":"))
    print("wrote data/zones.bin, zones.json", (OUT / "zones.json").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
