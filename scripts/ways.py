"""What the pipeline reads off an OSM way, in one place: how wide voxelize.py draws it (the defaults per highway class,
OSM's width and lanes; shared with overrides.py, which places a street override's sidewalks, trees and lamps beside the
carriageway), its numbers (num, layer_of, level_of), whether it is underground, and its cells on the grid (cells)."""
import math
import re

HW = {"motorway": 20, "trunk": 14, "primary": 12, "secondary": 10, "tertiary": 8, "unclassified": 6,
      "residential": 6, "living_street": 5, "service": 4, "pedestrian": 5, "footway": 2.5, "path": 2,
      "cycleway": 2, "steps": 2.5, "platform": 3, "bridleway": 2, "track": 3, "corridor": 0}
ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"}
# the classes of a through road (a highway's class with _link taken off): what the ground passes of voxelize.py take
# for a road tunnel, and what makes a layer -1 way an open cut
MAIN_ROADS = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential")
_NUM = re.compile(r"\s*(-?[0-9]+(?:[.,][0-9]+)?)")


def num(s, default=None):
    """the number an OSM value starts with ('12', '2.5 m', '2,5', '-1;0' and '-1-4': -1), else default (a missing tag,
    'yes', 'default'). The one parser of the pipeline's tags: with a default it never returns None, so a malformed
    value cannot reach a comparison"""
    m = _NUM.match(str(s)) if s is not None else None
    return float(m.group(1).replace(",", ".")) if m else default


parse_len = num


def layer_of(t):
    """the way's OSM layer: 0 when missing or not a number (layer=yes)"""
    return num(t.get("layer"), 0)


def level_of(t):
    """the way's (first) OSM level: 0 when missing or not a number"""
    return num(str(t.get("level", "0")).split(";")[0], 0)


def underground(t):
    """whether the way is mapped under the ground or under a roof: a tunnel, a building passage, a culvert, a layer or
    a level below 0, covered, indoor, location=underground. The one answer for the volume (voxelize.py leaves such ways
    out of the ground), the traffic (traffic.py drives them only where the volume has a passage: an open cut, a
    passage under a street, a bore) and the clearance scan's classes (clearance.py). An open cut is a layer -1 way
    voxelize.py found open to the sky: it sets its layer to 0"""
    return t.get("tunnel") in ("yes", "building_passage", "culvert") or layer_of(t) < 0 \
        or t.get("covered") == "yes" or t.get("indoor") == "yes" or t.get("location") == "underground" \
        or level_of(t) < 0


def cells(geom, D, W, all_touched=False, fallback=False):
    """(rows, cols) of the grid cells of geom (a cell whose centre lies in it; all_touched: any it touches) within a
    D x W grid; fallback: a geometry that holds no cell's centre takes the cells it touches"""
    from affine import Affine
    from rasterio.features import rasterize
    minx, miny, maxx, maxy = geom.bounds
    c0, r0 = max(int(math.floor(minx)), 0), max(int(math.floor(miny)), 0)
    c1, r1 = min(int(math.ceil(maxx)), W), min(int(math.ceil(maxy)), D)
    if c0 >= c1 or r0 >= r1:
        import numpy as np
        return np.zeros(0, int), np.zeros(0, int)
    m = rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=Affine.translation(c0, r0),
                  all_touched=all_touched, dtype="uint8")
    rr, cc = m.nonzero()
    if len(rr) == 0 and not all_touched and fallback:
        return cells(geom, D, W, True)
    return rr + r0, cc + c0


def way_width(t):
    """the width (m) a highway way is drawn at; 0: not drawn"""
    hw = t.get("highway")
    if hw == "construction":
        hw = t.get("construction")
    base = (hw or "").replace("_link", "")
    w = num(t.get("width")) or (num(t.get("lanes"), 0) * 3.1 if t.get("lanes") and base in HW and base in ROADS
                                else None) or HW.get(base, 0)
    if t.get("footway") == "sidewalk":
        w = max(w, 3)
    if base == "service" and t.get("service") in ("parking_aisle", "driveway", "alley"):
        w = 3.5
    return w


def unlit(t):
    """no street lamps along the way: OSM's lit=no, or a motorway or a road out of town (zone:traffic=DE:rural) not
    tagged lit=yes. The one test for the lamps placed along the streets (traffic.py's dark flag, web/src/streetlamps.ts)
    and those on the bridge decks (voxelize.py): the A 3's Donaubrücke Schalding (lit=no) had a deck lamp every 32 m"""
    hw = t.get("highway") or ""
    if hw == "construction":
        hw = t.get("construction") or ""
    return t.get("lit") == "no" or (t.get("lit") != "yes" and (hw.startswith("motorway") or t.get("zone:traffic") == "DE:rural"))
