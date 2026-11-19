"""The AOI's known trees, from two sources:

- OSM natural=tree nodes: species, genus, leaf_type, height and circumference where tagged. Id "osm:<node id>".
- Einzelbäume 3D of the Bayerische Vermessungsverwaltung (CC BY 4.0; data/raw/baeume_aoi.csv, cut from the district's
  GeoPackage by scripts/clip_baeume.py): one point per crown detected in the 2024 flight's surface model, with its
  height (5.5 m and up), in parks and street rows as in the forests on the slopes. Id "bv:<easting>_<northing>" (dm).
A register point within 3 m of an OSM tree is that tree (the OSM node keeps its place and species and takes the
register's height); register points within 1 m of a building are dropped (a roof's edge or a tower matched as a crown).
"""
import csv
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from aoi import D, RAW, W, to_grid

BV_CSV = Path(RAW) / "baeume_aoi.csv"
MERGE_M, BUILDING_M = 3.0, 1.0


def _num(v):
    try:
        return float(str(v).replace(",", ".").split()[0])
    except (ValueError, IndexError, TypeError):
        return None


def register():
    """the Einzelbäume points on the grid (the region's, aoi.py): [(x, y, height, easting, northing, row in the file)]"""
    if not BV_CSV.exists():
        return []
    out = []
    with open(BV_CSV) as f:
        for k, row in enumerate(csv.DictReader(f)):
            e, n, h = float(row["x"]), float(row["y"]), float(row["height"])
            x, y = to_grid(e, n)
            if 0 <= x < W and 0 <= y < D:
                out.append((float(x), float(y), h, e, n, k))
    return out


def load(osm_trees, buildings=None):
    """osm_trees: [(oid, tags, Point(col, row))] from voxelize's OSM reader; buildings: (D, W) bool, the footprints.
    Returns a list of dicts with grid x, y and k, the tree's place in its source (osm_trees, the register's file).
    A region's trees (aoi.py) are those standing in it."""
    out = []
    for k_osm, (oid, tg, p) in enumerate(osm_trees):
        if not (0 <= p.x < W and 0 <= p.y < D):
            continue
        out.append(dict(id=f"osm:{oid}", src="osm", k=k_osm, x=float(p.x), y=float(p.y), species=tg.get("species") or tg.get("genus"),
                        trunk_cm=_num(tg.get("circumference")) and _num(tg.get("circumference")) * 100,
                        height=_num(tg.get("height")), leaf_type=tg.get("leaf_type"), osm=oid))
    reg = register()
    if not reg:
        return out
    near_b = None
    if buildings is not None:
        near_b = ndimage.distance_transform_edt(~buildings) <= BUILDING_M
    osm_kd = cKDTree([(t["x"], t["y"]) for t in out]) if out else None
    taken = set()
    n_merged = n_bld = 0
    # nearest register point first, so each OSM tree takes the closest one; the others in the file's order (by their
    # distance to the nearest OSM tree, as before, they took the order of trees far off, beyond the region)
    cand = []
    for k, (x, y, h, e, n, _) in enumerate(reg):
        if near_b is not None and near_b[int(y), int(x)]:
            n_bld += 1
            continue
        d, i = osm_kd.query((x, y)) if osm_kd is not None else (np.inf, -1)
        cand.append((d, i, k) if d <= MERGE_M else (np.inf, -1, k))
    cand.sort()
    for d, i, k in cand:
        x, y, h, e, n, row = reg[k]
        if d <= MERGE_M and i not in taken:
            taken.add(i)
            out[i]["bv_height"] = h
            n_merged += 1
            continue
        out.append(dict(id=f"bv:{round(e * 10)}_{round(n * 10)}", src="bv", k=row, x=x, y=y, bv_height=h))
    print(f"Einzelbäume: {len(reg)} in the AOI, {n_bld} at buildings dropped, {n_merged} matched to OSM trees, "
          f"{sum(t['src'] == 'bv' for t in out)} added")
    return out


CONIFER = ("Pinus", "Picea", "Abies", "Taxus", "Thuja", "Larix", "Pseudotsuga", "Juniperus", "Chamaecyparis", "Metasequoia",
           "Tsuga", "Cupressocyparis")  # (phenology.py CONIFERS: these and the larches)


def is_conifer(t):
    sp = t.get("species") or ""
    return sp.startswith(CONIFER) or t.get("leaf_type") == "needleleaved"


def is_broadleaf(t):
    """known to be broadleaved (species or leaf_type): the LiDAR's winter density does not make it a conifer"""
    sp = t.get("species") or ""
    return (bool(sp) and not sp.startswith(CONIFER)) or t.get("leaf_type") == "broadleaved"
