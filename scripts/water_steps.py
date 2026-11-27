"""Steps in the water's top: neighbouring cells whose ground's top voxel is water at different heights
(data/ground.npz `g` where `water`; a bridge's deck is not the ground, so a step under one counts too), a cliff across
open water. A step within WEIR_REACH of a weir, dam or lock gate (OSM) or of a polygon stretch's edge (scripts/map.json
rivers: the edges a falling river's stretches were given, under a bridge or at a rapid) is deliberate and counted
apart.

usage: uv run python scripts/water_steps.py [GROUND_NPZ] [--max N]
  prints the open-water steps grouped by place (project grid x,z of their middle, cells, the heights met), then the
  deliberate ones; exit 1 when more than N cells (default: no limit) stand at an open-water step
"""
import argparse
import json

import numpy as np
from scipy import ndimage

from aoi import CRS, GRID_X0, GRID_Y0, MAP_C0, MAP_R0, OSM_PATH, RIVER_STRETCHES, to_grid

WEIR_REACH = 12  # m round a weir's, dam's or lock gate's line, or a polygon stretch's edge


def deliberate(shape):
    """cells within WEIR_REACH of OSM's weirs, dams and lock gates (lines, areas and nodes) and of the polygon
    stretches' edges"""
    import rasterio.features
    from pyproj import Transformer
    from shapely.geometry import LineString, Point
    tr = Transformer.from_crs(4326, CRS, always_xy=True)
    geoms = []
    for e in json.load(open(OSM_PATH))["elements"]:
        t = e.get("tags", {})
        if t.get("waterway") not in ("weir", "dam", "lock_gate"):
            continue
        if e["type"] == "node":
            geoms.append(Point(*map(float, to_grid(*tr.transform(e["lon"], e["lat"])))))
        elif e["type"] == "way" and len(e.get("geometry") or []) >= 2:
            pts = [tr.transform(p["lon"], p["lat"]) for p in e["geometry"] if p]
            geoms.append(LineString([tuple(map(float, to_grid(*p))) for p in pts]))
    for shape_, _ in RIVER_STRETCHES:
        if not isinstance(shape_, tuple):
            geoms.append(LineString([(x - GRID_X0 - MAP_C0, GRID_Y0 - y - MAP_R0) for x, y in shape_]))
    if not geoms:
        return np.zeros(shape, bool)
    return rasterio.features.rasterize(((g_.buffer(WEIR_REACH), 1) for g_ in geoms), out_shape=shape,
                                       dtype=np.uint8).astype(bool)


def steps(g, water):
    """the cells at a step: bool [D, W], and the neighbouring pairs (horizontal, vertical) at one"""
    h = water[:, 1:] & water[:, :-1] & (g[:, 1:] != g[:, :-1])
    v = water[1:] & water[:-1] & (g[1:] != g[:-1])
    m = np.zeros(water.shape, bool)
    m[:, 1:] |= h
    m[:, :-1] |= h
    m[1:] |= v
    m[:-1] |= v
    return m


def places(m, g):
    """the cells of m grouped by place (within 16 m of each other): (cells, project x, project z, heights met)"""
    lab, _ = ndimage.label(ndimage.binary_dilation(m, iterations=16))
    out = []
    for i, s in enumerate(ndimage.find_objects(lab), 1):
        k = m[s] & (lab[s] == i)
        rr, cc = np.nonzero(k)
        if len(rr):
            out.append((len(rr), int(cc.mean() + s[1].start + MAP_C0), int(rr.mean() + s[0].start + MAP_R0),
                        np.unique(g[s][k])))
    return sorted(out, reverse=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ground", nargs="?", default="data/ground.npz")
    ap.add_argument("--max", type=int, default=None)
    a = ap.parse_args()
    z = np.load(a.ground)
    g, water = z["g"], z["water"]
    m = steps(g, water)
    ok = deliberate(water.shape)
    for title, sel in (("open-water steps", m & ~ok), ("deliberate (weirs, lock gates, the stretches' cuts)", m & ok)):
        rows = places(sel, g)
        print(f"{title}: {int(sel.sum())} cells in {len(rows)} places")
        for cnt, x, zz, lv in rows:
            more = " ..." if len(lv) > 8 else ""
            print(f"  {x:6d},{zz:6d}  {cnt:5d} cells  heights {' '.join(map(str, lv[:8]))}{more}")
    total = int((m & ~ok).sum())
    if a.max is not None and total > a.max:
        raise SystemExit(f"FAIL: {total} cells at an open-water step, more than {a.max}")


if __name__ == "__main__":
    main()
