"""Pedestrian underpasses: the passages OSM maps one level under the street, carved into the ground as corridors 3 m high under a 1 m slab, and the stairs down to them
cut as open stairwells with a parapet round them. The LiDAR saw only part way down a stairwell: its ragged pit is filled
back to the street first. Deeper levels (level -2 and under) are left solid; their stairs from the street are cut
down to the first level. WALK holds the walking level of every carved cell for traffic.py, IDS the ways walked.
"""
import json

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.strtree import STRtree

from aoi import CRS, OSM_PATH, to_grid
from ways import cells, num

WALK = None
IDS = set()
SKIP = set()  # ways tunnels.py bores through a hill
FOOT = ("footway", "path", "pedestrian", "cycleway", "corridor")
_T = Transformer.from_crs(4326, CRS, always_xy=True)


def _levels(t):
    out = []
    for k in ("level", "layer"):
        for v in str(t.get(k, "")).replace(",", ";").split(";"):
            if num(v) is not None:
                out.append(num(v))
    return out


def ways(osm):
    """(tunnels, stairs): the passages one level down outside buildings, and the steps from the street to them, each
    (way id, [node ids], LineString in grid metres)"""
    data = json.load(open(OSM_PATH))
    blds = [g for _, _, t, g in osm.areas if "building" in t]
    tree = STRtree(blds)
    inside = lambda ln: any(blds[i].contains(ln.centroid) for i in tree.query(ln.centroid))
    tun, other = [], []
    for e in data["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or t.get("highway") not in FOOT + ("steps",) or not e.get("geometry") or None in e["geometry"]:
            continue
        if e["id"] in SKIP or t.get("tunnel") == "building_passage" or t.get("indoor") == "yes" or t.get("location") == "indoor":
            continue
        lv = _levels(t)
        down = t.get("tunnel") == "yes" or t.get("location") == "underground" or any(v < 0 for v in lv)
        if any(v < -1 for v in lv) or t.get("bridge") not in (None, "no"):
            continue
        ln = LineString([to_grid(*_T.transform(p["lon"], p["lat"])) for p in e["geometry"]])
        if ln.length < 1 or inside(ln):
            continue
        w = (e["id"], e["nodes"], ln)
        (tun if down and t["highway"] != "steps" and 0 not in lv else other).append(w)
    tnodes = {n for _, ns, _ in tun for n in ns}
    hw = {e["id"]: e["tags"]["highway"] for e in data["elements"] if e["type"] == "way" and "highway" in e.get("tags", {})}
    # the landing at a stairwell's foot: a short plain footway from a passage's end, open to the sky
    land = [w for w in other if hw[w[0]] != "steps" and w[2].length < 15 and tnodes & set(w[1])]
    lnodes = tnodes | {n for _, ns, _ in land for n in ns}
    steps = [w for w in other if hw[w[0]] == "steps" and (w[1][0] in lnodes or w[1][-1] in lnodes)]
    return tun, land, steps


def build(vol, g, pal, C, osm, note):
    global WALK
    D, W = g.shape
    WALK = np.full((D, W), -1, np.int16)
    IDS.clear()
    tun, land, steps = ways(osm)
    floor, wall, rail = C["paving2"], pal("#a9a59c"), pal("#c9c6be")
    roads = [C[k] for k in ("asphalt", "asphalt_l", "mark", "parking", "trambed", "sett", "cycle", "hatch", "road_paving")]
    # the street over each passage: the highest ground along it; the corridor's walking level 4 m under it. A landing
    # whose ground already lies 3 m or more under the street over its passage is no stairwell's foot the LiDAR filled:
    # it is the open path the passage continues at its own level (a cycleway under a street on a short bridge, the
    # Donauradweg under the B 8): a plain path, left as it is; sunk 4 m under its own ground it had set the passage's
    # floor 4 m under the path at its portals, a buried corridor and a pit at each end
    level, over, at_grade = {}, {}, set()
    for k, (wid, ns, ln) in enumerate(tun + land):
        rr, cc = cells(ln.buffer(0.5), D, W)
        if not len(rr):
            continue
        street = int(np.percentile(g[rr, cc], 90))
        if k >= len(tun) and max(over.get(n, -1) for n in ns) - np.median(g[rr, cc]) >= 3:
            at_grade.add(wid)
            continue
        for n in ns:
            level[n] = min(level.get(n, 10 ** 6), street - 4)
            if k < len(tun):
                over[n] = max(over.get(n, -1), street)
    land = [w for w in land if w[0] not in at_grade]
    n_t = n_s = 0
    for wid, ns, ln in steps:  # stairwells first: fill the LiDAR's pit to the street, then cut the stair
        top, bot = (ns[-1], ns[0]) if ns[0] in level else (ns[0], ns[-1])
        if bot not in level:
            continue
        a, b = np.array(ln.coords[0]), np.array(ln.coords[-1])
        if top == ns[0]:
            hi, lo = a, b
        else:
            hi, lo = b, a
        rr, cc = cells(ln.buffer(3.0), D, W)
        if not len(rr):  # (a stairwell beyond the region's volume: its passage's end is in it)
            continue
        ring = g[rr, cc]
        street = int(np.percentile(ring, 80))
        zf = level[bot]
        # (never a carriageway: a road ramping down into a tunnel beside the stairs is no pit)
        road = np.isin(vol[np.maximum(ring - 1, 0), rr, cc], roads)
        low = (ring < street) & (ring >= street - 5) & ~road
        for r, c in zip(rr[low], cc[low]):
            vol[g[r, c] - 1:street, r, c] = C["paving"]
            g[r, c] = street
        L = max(np.linalg.norm(lo - hi), 1e-6)
        sr, sc = cells(ln.buffer(1.3, cap_style=2), D, W)
        for r, c in zip(sr, sc):
            t = np.clip(np.dot(np.array([c + 0.5, r + 0.5]) - hi, (lo - hi) / L) / L, 0, 1)
            z = int(round(street + (zf - street) * t))
            vol[z:street + 1, r, c] = 0
            vol[z - 1, r, c] = floor
            WALK[r, c] = z
        pr, pc = cells(ln.buffer(2.3, cap_style=2).difference(ln.buffer(1.3, cap_style=2)), D, W)
        for r, c in zip(pr, pc):  # the parapet round the opening, where the ground stands at the street
            if WALK[r, c] < 0 and g[r, c] >= street:
                vol[street, r, c] = rail
        IDS.add(wid)
        n_s += 1
    for k, (wid, ns, ln) in enumerate(land + tun):
        opened = k < len(land)
        zf = min(level.get(n, 10 ** 6) for n in ns)
        if zf > 10 ** 5:
            continue
        rr, cc = cells(ln.buffer(1.5, cap_style=2), D, W)
        for r, c in zip(rr, cc):
            if WALK[r, c] >= 0:
                continue
            if g[r, c] >= zf + 4 and not opened:  # under the slab
                vol[zf:zf + 3, r, c] = 0
            elif g[r, c] == zf + 3 and not opened:
                # a metre short of the slab: the street over the passage rounded a metre under the level it was
                # measured at (zf: its 90th percentile less 4). Cut open to the sky it was a slot across the road;
                # the ceiling comes down a metre there instead (the street's own surface is the slab)
                vol[zf:zf + 2, r, c] = 0
            else:  # where it opens to a stairwell or a sunken court
                vol[zf:g[r, c] + 1, r, c] = 0
            vol[zf - 1, r, c] = floor
            WALK[r, c] = zf
        wr, wc = cells(ln.buffer(2.0, cap_style=2).difference(ln.buffer(1.5, cap_style=2)), D, W)
        for r, c in zip(wr, wc):  # the corridor's walls, where the ground's soil would show
            if WALK[r, c] < 0:
                top = zf + 2 if g[r, c] == zf + 3 else min(zf + 3, g[r, c])  # (the street's own surface stays)
                vol[zf:top, r, c] = np.where(vol[zf:top, r, c] != 0, wall, 0)
        IDS.add(wid)
        n_t += 1
    note(f"underpasses: {n_t} passages, {n_s} stairwells carved, "
         f"{len(at_grade)} landings at the passage's level left as paths")
