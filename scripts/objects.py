"""Where each building and street is, for the viewer's ?focus=bld:<id> / ?focus=street:<id> (web/src/focus.ts): the
camera frames the object without loading anything of the map's size. The objects are split by id into SHARDS small
files, so the viewer fetches the one file its id falls in (a larger map makes them longer, never one big file).

Output: web/public/data/objects/<id % SHARDS>.json = {"w<id>" | "r<id>" (building way or relation, outlines and
building:parts), "s<id>" (highway way): [x0, z0, x1, z1, y0, y1]}: the OSM geometry's box in map cells (x east, z
south, as the viewer's coordinates) and the voxel heights it spans (the lowest ground under the box; for a building
the highest voxel of the buildings in the box, for a street its highest ground plus 3 m).

Input: data/raw/osm.json, data/ground.npz (voxelize.py: g the ground voxel, b the building's height over it), read row
band by row band.

usage: uv run python scripts/objects.py
"""
import json
import shutil
from pathlib import Path

import numpy as np
from pyproj import Transformer

import aoi
import window

OUT = Path("web/public/data/objects")
SHARDS = 64
BAND = 256


def boxes(els):
    """{key: (x0, z0, x1, z1, is_building)} in map cells, within the map"""
    tr = Transformer.from_crs(4326, aoi.CRS, always_xy=True)
    out = {}
    for e in els:
        t = e.get("tags", {})
        bld = "building" in t or "building:part" in t
        street = e["type"] == "way" and "highway" in t
        if e["type"] not in ("way", "relation") or not (bld or street):
            continue
        pts = [p for p in e.get("geometry") or [] if p] if e["type"] == "way" else \
            [p for m in e.get("members", []) if m.get("role") != "inner" for p in m.get("geometry") or [] if p]
        if not pts:
            continue
        x, y = tr.transform(np.array([p["lon"] for p in pts]), np.array([p["lat"] for p in pts]))
        c, r = aoi.to_grid(x, y)
        x0, x1, z0, z1 = float(c.min()), float(c.max()), float(r.min()), float(r.max())
        if x1 < 0 or z1 < 0 or x0 > aoi.MAP_W or z0 > aoi.MAP_D:
            continue
        x0, z0 = max(x0, 0.0), max(z0, 0.0)
        x1, z1 = min(x1, float(aoi.MAP_W)), min(z1, float(aoi.MAP_D))
        key = ("s" if street and not bld else ("r" if e["type"] == "relation" else "w")) + str(e["id"])
        out[key] = (x0, z0, x1, z1, bld)
    return out


def main():
    els = json.load(open(f"{aoi.RAW}/osm.json"))["elements"]
    bx = boxes(els)
    keys = sorted(bx)
    arr = np.array([bx[k][:4] for k in keys]).reshape(-1, 4)
    r0i, r1i = np.floor(arr[:, 1]).astype(int), np.minimum(np.ceil(arr[:, 3]).astype(int) + 1, aoi.MAP_D)
    c0i, c1i = np.floor(arr[:, 0]).astype(int), np.minimum(np.ceil(arr[:, 2]).astype(int) + 1, aoi.MAP_W)
    lo = np.full(len(keys), 1 << 30)
    hi = np.full(len(keys), -(1 << 30))
    bld = np.array([bx[k][4] for k in keys], bool)
    for b0 in range(0, aoi.MAP_D, BAND):
        b1 = min(b0 + BAND, aoi.MAP_D)
        g = window.npz_rows("data/ground.npz", "g", b0, b1).astype(np.int32)
        top = g + window.npz_rows("data/ground.npz", "b", b0, b1)
        for i in np.flatnonzero((r0i < b1) & (r1i > b0)):
            ra, rb = max(r0i[i], b0) - b0, min(r1i[i], b1) - b0
            gs = g[ra:rb, c0i[i]:c1i[i]]
            if gs.size == 0:
                continue
            lo[i] = min(lo[i], int(gs.min()))
            hi[i] = max(hi[i], int((top if bld[i] else g)[ra:rb, c0i[i]:c1i[i]].max()))
    shards = [{} for _ in range(SHARDS)]
    for i, k in enumerate(keys):
        if lo[i] > hi[i]:
            continue
        x0, z0, x1, z1, _ = bx[k]
        shards[int(k[1:]) % SHARDS][k] = [round(x0, 1), round(z0, 1), round(x1, 1), round(z1, 1), int(lo[i]),
                                          int(hi[i]) + (0 if bld[i] else 3)]
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for s, d in enumerate(shards):
        (OUT / f"{s}.json").write_text(json.dumps(d, separators=(",", ":"), sort_keys=True))
    print(f"objects: {sum(len(d) for d in shards)} in {SHARDS} files, "
          f"{sum((OUT / f'{s}.json').stat().st_size for s in range(SHARDS)) / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
