"""The LoD2 buildings' own ids (CityGML gml:id, e.g. DEBY_LOD2_4906541) by data/lod2.npz `bid`, for zones.py's stable
building keys ("lod2:<gml:id>"; a LoD2-only building is -bid in data/footprints.npz).

lod2.py numbers the buildings tile by tile (data/raw/lod2/*.gml sorted): within a tile 1, 2, ... in the file's order of
bldg:Building elements, a tile's numbers offset by the previous tiles' (base += the tile's highest number that has a roof
polygon, + 1). This replays that count without reading the geometry: a change to lod2.py's numbering must be made here
too (lod2.py is not imported, so this file's hash stays out of the lod2 step's). Kept in data/cache/lod2_ids.json while the tiles' sizes and mtimes stay as they are.
"""
import glob
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from aoi import RAW

GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/1.0}"
CACHE = Path("data/cache/lod2_ids.json")


def _tile(path):
    """[(building number, gml:id, has a roof polygon)] of one tile, as lod2.roof_polys counts them"""
    out, bi = [], 0
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag != f"{BLDG}Building":
            continue
        bi += 1
        roof = any(p.find(f"{GML}exterior") is not None
                   for rs in el.iter(f"{BLDG}RoofSurface") for p in rs.iter(f"{GML}Polygon"))
        out.append((bi, el.get(f"{GML}id"), roof))
        el.clear()
    return out


def ids():
    """{bid: gml:id} over all tiles (bid as in data/lod2.npz)"""
    paths = sorted(glob.glob(f"{RAW}/lod2/*.gml"))
    stamp = [[p, Path(p).stat().st_size, Path(p).stat().st_mtime_ns] for p in paths]
    if CACHE.exists():
        d = json.load(open(CACHE))
        if d["stamp"] == stamp:
            return {int(k): v for k, v in d["ids"].items()}
    res, base = {}, 0
    for p in paths:
        nb = 0
        for bi, gid, roof in _tile(p):
            res[base + bi] = gid
            if roof:
                nb = max(nb, bi)
        base += nb + 1
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    json.dump(dict(stamp=stamp, ids=res), open(CACHE, "w"))
    return res
