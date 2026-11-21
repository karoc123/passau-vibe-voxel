"""How wide voxelize.py draws a way: the defaults per highway class, OSM's width and lanes (shared with overrides.py,
which places a street override's sidewalks, trees and lamps beside the carriageway)."""
import re

HW = {"motorway": 20, "trunk": 14, "primary": 12, "secondary": 10, "tertiary": 8, "unclassified": 6,
      "residential": 6, "living_street": 5, "service": 4, "pedestrian": 5, "footway": 2.5, "path": 2,
      "cycleway": 2, "steps": 2.5, "platform": 3, "bridleway": 2, "track": 3, "corridor": 0}
ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"}


def parse_len(s):
    if s is None:
        return None
    m = re.match(r"\s*(-?[0-9]+(?:[.,][0-9]+)?)", str(s))
    return float(m.group(1).replace(",", ".")) if m else None


def way_width(t):
    """the width (m) a highway way is drawn at; 0: not drawn"""
    hw = t.get("highway")
    if hw == "construction":
        hw = t.get("construction")
    base = (hw or "").replace("_link", "")
    w = parse_len(t.get("width")) or (parse_len(t.get("lanes")) * 3.1 if t.get("lanes") and base in HW and base in ROADS
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
