"""OSM (Overpass `out geom`) parsing into shapely geometries in grid coordinates.

Grid coordinates: the grid defined in aoi.py.
"""
import json

from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

import overrides
from aoi import CRS, OSM_PATH, to_grid as _aoi_grid

_T = Transformer.from_crs(4326, CRS, always_xy=True)


def to_grid(lon, lat):
    x, y = _T.transform(lon, lat)
    i, j = _aoi_grid(x, y)
    return float(i), float(j)


def _coords(geom):
    return [to_grid(p["lon"], p["lat"]) for p in geom if p]


AREA_KEYS = ("building", "building:part", "landuse", "leisure", "natural", "amenity", "area:highway",
             "man_made", "place", "construction:leisure", "construction:landuse", "parking", "water")


class OSM:
    def __init__(self, path=None):
        path = path or OSM_PATH  # (data/raw/osm.json, or the region's cut of it: regions.py)
        data = json.load(open(path))
        overrides.patch_elements(data["elements"])  # (the street overrides' tags, trees and lamps)
        self.timestamp = data["osm3s"]["timestamp_osm_base"]
        self.nodes = []  # (id, tags, Point)
        self.lines = []  # (id, tags, LineString)
        self.areas = []  # (id, type, tags, Polygon|MultiPolygon)
        for e in data["elements"]:
            tags = e.get("tags", {})
            if not tags:
                continue
            if e["type"] == "node":
                self.nodes.append((e["id"], tags, Point(to_grid(e["lon"], e["lat"]))))
            elif e["type"] == "way":
                c = _coords(e.get("geometry", []))
                if len(c) < 2:
                    continue
                closed = len(c) >= 4 and e["geometry"][0] and e["geometry"][-1] and \
                    e["geometry"][0] == e["geometry"][-1]
                is_area = closed and (tags.get("area") == "yes" or any(k in tags for k in AREA_KEYS)) \
                    and tags.get("area") != "no" and not ("highway" in tags and tags.get("area") != "yes"
                                                           and "area:highway" not in tags)
                if is_area:
                    p = Polygon(c)
                    if not p.is_valid:
                        p = p.buffer(0)
                    if p.area > 0:
                        self.areas.append((e["id"], "way", tags, p))
                else:
                    self.lines.append((e["id"], tags, LineString(c)))
            elif e["type"] == "relation" and tags.get("type") in ("multipolygon", "building"):
                outer, inner = [], []
                for m in e.get("members", []):
                    if m["type"] != "way" or not m.get("geometry"):
                        continue
                    c = _coords(m["geometry"])
                    if len(c) < 2:
                        continue
                    (inner if m.get("role") == "inner" else outer).append(LineString(c))
                if not outer:
                    continue
                o = unary_union(list(polygonize(unary_union(outer))))
                if inner:
                    i = unary_union(list(polygonize(unary_union(inner))))
                    o = o.difference(i)
                if o.is_empty or o.area == 0:
                    continue
                if not isinstance(o, (Polygon, MultiPolygon)):
                    o = o.buffer(0)
                self.areas.append((e["id"], "relation", tags, o))

    def areas_with(self, key, values=None):
        return [a for a in self.areas if key in a[2] and (values is None or a[2][key] in values)]

    def lines_with(self, key, values=None):
        return [a for a in self.lines if key in a[1] and (values is None or a[1][key] in values)]

    def nodes_with(self, key, values=None):
        return [a for a in self.nodes if key in a[1] and (values is None or a[1][key] in values)]


FOOTPRINTS = "data/footprints.npz"


def lod2_only_ids(band=256):
    """the ids of the buildings from LoD2 alone in data/footprints.npz (negative), ascending; read row band by row
    band (window.py), never the whole raster at once"""
    import numpy as np
    from pathlib import Path
    import window
    if not Path(FOOTPRINTS).exists():
        raise SystemExit("data/footprints.npz missing: run scripts/voxelize.py first")
    (D, W), _ = window.npz_shape(FOOTPRINTS, "oid")
    neg = set()
    for r in range(0, D, band):
        a = window.npz_rows(FOOTPRINTS, "oid", r, min(r + band, D))
        neg.update(int(k) for k in np.unique(a[a < 0]))
    return sorted(neg)


def footprints(ids_values, extra=None, region=None, neg=None):
    """The building footprints voxelize.py drew (OSM outlines moved onto the LoD2 footprints, and buildings from LoD2
    alone under negative ids; data/footprints.npz), as a raster of the given values: ids_values maps an outline's OSM
    id to its value, extra(k) gives the k-th LoD2-only building's (0 without). region: (ra, rb, ca, cb), only those
    rows and columns, read as a stream (window.py); neg: lod2_only_ids(), if known. Returns (raster, number of
    LoD2-only buildings). Exits when voxelize.py has not run yet (zones.py and windows.py would otherwise fall back to
    OSM's own outlines and silently disagree with the tiles)."""
    import numpy as np
    import window
    neg = lod2_only_ids() if neg is None else neg
    if region is None:
        (D, W), _ = window.npz_shape(FOOTPRINTS, "oid")
        region = (0, D, 0, W)
    oid = window.npz_region(FOOTPRINTS, "oid", region)
    keys, inv = np.unique(oid, return_inverse=True)
    vals = {k: (extra(j) if extra else 0) for j, k in enumerate(neg)}
    lut = np.array([ids_values.get(int(k), vals.get(int(k), 0)) for k in keys])
    return lut[inv.reshape(oid.shape)], len(neg)
