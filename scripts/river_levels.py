"""The rivers' water level per stretch, measured, for scripts/map.json's `rivers.stretches` (a map that spans the rivers'
fall: the Danube falls ~0.2-0.4 m per km round Passau, the Inn and the Ilz more; voxelize.py takes the rivers from the
terrain model within 0.8 m of the level, so a 30 km map needs a level per stretch).

Along each named river's OSM centre line (waterway=river) every STEP metres: the median of the terrain model (DGM1,
data/prep.npz) over the flat water cells within 20 m of the line (the laser sees the water surface on the survey
day), then the median per stretch of SPAN metres along the line. Prints each stretch's box (EPSG:25832, the box of
its part of the line grown by 150 m) and level, as JSON for map.json, and how far the stretches' levels lie from
rivers.level. Reads only; changes nothing.

With --cuts: the places along each river where its level may step without a cliff across open water (OSM's bridges,
weirs, dams, rapids and waterfalls over its centre line), in order down the line, each with its position (EPSG:25832
and project grid) and the measured level of the water between it and the next: where to put the stretches' edges
(a `poly` stretch's edge along the bridge's deck or the weir).

With --split NAME A,B,C..: the stretches of that river between the cuts at A, B, C.. metres down its line (as --cuts
lists them; a distance with no crossing within 15 m is a cut square to the river: a rapid of our choosing), each a
`poly` (the river's band, --reach metres either side of its line, 60 by default, between the cut lines) with its
measured level, as JSON for map.json, and the voxel level each comes to: the steps the river will show (--voxels
K1,K2,..: each stretch's voxel level, its level the nearest to the measured one that comes to it).

usage: uv run python scripts/river_levels.py [--span METRES | --cuts | --split NAME A,B,.. [--reach M]
       [--voxels K1,K2,..]] [NAME ...]
"""
import json
import sys

import numpy as np
from scipy import ndimage

import aoi
from osm import OSM

STEP, NEAR, GROW = 10.0, 20, 150


FALLS = ("weir", "dam", "rapids", "waterfall")


def level_at(dtm, x, y):
    """the median of the terrain model over the flat cells within NEAR of map cell (x, y), or None"""
    c, r = int(x), int(y)
    if not (NEAR <= r < aoi.MAP_D - NEAR and NEAR <= c < aoi.MAP_W - NEAR):
        return None
    box = dtm[r - NEAR:r + NEAR, c - NEAR:c + NEAR]
    flat = (ndimage.maximum_filter(box, 5) - ndimage.minimum_filter(box, 5)) < 0.3
    return float(np.median(box[flat])) if flat.sum() >= 50 else None


def pieces(lns):
    """a river's OSM lines merged into pieces (OSM draws them downstream)"""
    from shapely.ops import linemerge
    m = linemerge(lns) if len(lns) > 1 else lns[0]
    return list(m.geoms) if hasattr(m, "geoms") else [m]


def crossings(osm, part):
    """(distance down the piece, what, geometry) of OSM's bridges, weirs, dams, rapids and waterfalls over it"""
    over = [(f"bridge {t.get('name') or t.get('highway') or t.get('railway') or ''} (way {oid})", g_)
            for oid, t, g_ in osm.lines if t.get("bridge") not in (None, "no")]
    over += [(f"bridge {t.get('name') or ''} ({typ} {oid})", g_) for oid, typ, t, g_ in osm.areas
             if t.get("man_made") == "bridge"]
    over += [(f"{t['waterway']} (way {oid})", g_) for oid, t, g_ in osm.lines if t.get("waterway") in FALLS]
    over += [(f"{t['waterway']} ({typ} {oid})", g_) for oid, typ, t, g_ in osm.areas if t.get("waterway") in FALLS]
    over += [(f"{t['waterway']} (node {oid})", p_.buffer(15)) for oid, t, p_ in osm.nodes if t.get("waterway") in FALLS]
    return sorted(((part.project(g_.intersection(part).centroid), what, g_) for what, g_ in over
                   if g_.intersects(part)), key=lambda c: c[0])


def levels(dtm, part, a, b):
    return [v for d in np.arange(a, b, STEP) if (v := level_at(dtm, *part.interpolate(d).coords[0])) is not None]


def cuts(osm, lines, dtm):
    """per river, down each merged piece of its line: the crossings where a step may lie and the level between them"""
    for name, lns in sorted(lines.items()):
        for part in pieces(lns):
            at = crossings(osm, part)
            ends = [0.0] + [a for a, _, _ in at] + [part.length]
            print(f"{name}: {part.length:.0f} m of line (OSM's direction, downstream)")
            for k in range(len(ends) - 1):
                if k:
                    a, what, _ = at[k - 1]
                    p = part.interpolate(a)
                    x, y = aoi.to_world(p.x, p.y)
                    print(f"  {a:6.0f} m  {what}: E {x:.0f} N {y:.0f}, project {p.x + aoi.MAP_C0:.0f},"
                          f"{p.y + aoi.MAP_R0:.0f}")
                if lv := levels(dtm, part, ends[k], ends[k + 1]):
                    print(f"           water {np.median(lv):.2f} m (min {min(lv):.2f}, max {max(lv):.2f}, "
                          f"{len(lv)} samples)")


def cut_line(part, a, at, reach):
    """the line across the river at distance a down the piece: an OSM crossing's own line there (a bridge's deck, a
    weir) when one lies within 15 m, else square to the river; lengthened to reach either side"""
    from shapely.geometry import LineString
    near = [g_ for d, _, g_ in at if abs(d - a) < 15 and g_.geom_type == "LineString"]
    p = np.array(part.interpolate(a).coords[0])
    if near:
        q = np.array(near[0].coords)
        i = int(np.argmin(np.linalg.norm(q - p, axis=1)))
        u = q[min(i + 1, len(q) - 1)] - q[max(i - 1, 0)]
    else:
        t = np.subtract(part.interpolate(min(a + 5, part.length)).coords[0],
                        part.interpolate(max(a - 5, 0)).coords[0])
        u = np.array([-t[1], t[0]])
    u = u / np.linalg.norm(u)
    return LineString([p - u * reach, p + u * reach])


def split(osm, lines, dtm, name, at_, reach, voxels=None):
    """the stretches of one river between the given distances down its line (its longest piece), as `poly` stretches
    for map.json: each the river's band (reach m either side of its line) between the cut lines at its ends; the level
    each stretch's measured median, or the nearest to it that comes to the given voxel level (so that a fall spreads
    over the cuts a step each), and the voxel level it comes to (map.json base)"""
    from shapely.ops import split as cut, substring
    part = max(pieces(lines[name]), key=lambda l: l.length)
    at = crossings(osm, part)
    out, prev = [], None
    for n, (a, b) in enumerate(zip(at_, at_[1:])):
        band = substring(part, max(a - reach, 0), min(b + reach, part.length)).buffer(reach)
        mid = part.interpolate((a + b) / 2)
        for e in (a, b):
            band = min(cut(band, cut_line(part, e, at, 2 * reach)).geoms, key=lambda g_: g_.distance(mid))
        lv = levels(dtm, part, a, b)
        L = round(float(np.median(lv)), 2)
        if voxels:  # (the voxel level k holds the levels from k + base - 0.5 up to k + base + 0.5)
            L = round(min(max(L, voxels[n] + aoi.BASE - 0.5), voxels[n] + aoi.BASE + 0.49), 2)
        k = int(np.floor(L - aoi.BASE + 0.5))
        xs, ys = aoi.to_world(*np.array(band.simplify(1.0).exterior.coords).T)
        out.append(dict(name=f"{name} {a:.0f}-{b:.0f} m down its line", level=L,
                        poly=[[round(float(x), 1), round(float(y), 1)] for x, y in zip(xs, ys)]))
        print(f"{name} {a:6.0f}-{b:6.0f} m: level {L:.2f} (water {min(lv):.2f}-{max(lv):.2f}: "
              f"{min(lv) - L:+.2f} to {max(lv) - L:+.2f}), voxel {k}"
              f"{'' if prev is None else f', step {prev - k} at {a:.0f} m'}", file=sys.stderr)
        prev = k
    print(json.dumps(out))


def main(argv):
    span = float(argv[argv.index("--span") + 1]) if "--span" in argv else 1000.0
    names = [a for i, a in enumerate(argv) if not a.startswith("-") and (i == 0 or argv[i - 1] not in ("--span",))]
    if "--split" in argv:
        names = [argv[argv.index("--split") + 1]]
    osm = OSM(f"{aoi.RAW}/osm.json")
    lines = {}
    for _, t, ln in osm.lines_with("waterway", ("river",)):
        if t.get("name") and (not names or t["name"] in names):
            lines.setdefault(t["name"], []).append(ln)
    dtm = np.load("data/prep.npz")["dtm"]  # (the map's: 4 bytes a cell; a 30 km map would read it in row bands)
    if "--cuts" in argv:
        return cuts(osm, lines, dtm)
    if "--split" in argv:
        i = argv.index("--split")
        reach = float(argv[argv.index("--reach") + 1]) if "--reach" in argv else 60.0
        vox = [int(v) for v in argv[argv.index("--voxels") + 1].split(",")] if "--voxels" in argv else None
        return split(osm, lines, dtm, argv[i + 1], [float(v) for v in argv[i + 2].split(",")], reach, vox)
    out = []
    for name, lns in sorted(lines.items()):
        samples = []  # (distance along the river's pieces, x, y, level)
        at = 0.0
        for ln in sorted(lns, key=lambda l: l.coords[0]):
            for d in np.arange(0, ln.length, STEP):
                p = ln.interpolate(d)
                if (lv := level_at(dtm, p.x, p.y)) is not None:
                    samples.append((at + d, p.x, p.y, lv))
            at += ln.length
        if not samples:
            continue
        s = np.array(samples)
        for k in range(int(s[:, 0].max() // span) + 1):
            m = (s[:, 0] >= k * span) & (s[:, 0] < (k + 1) * span)
            if m.sum() < 5:
                continue
            x0, y0 = aoi.to_world(s[m, 1].min() - GROW, s[m, 2].max() + GROW)
            x1, y1 = aoi.to_world(s[m, 1].max() + GROW, s[m, 2].min() - GROW)
            lv = round(float(np.median(s[m, 3])), 3)
            out.append(dict(river=name, box=[round(float(x0)), round(float(y0)), round(float(x1)), round(float(y1))], level=lv))
            print(f"{name} km {k * span / 1000:.1f}-{(k + 1) * span / 1000:.1f}: level {lv:.3f} m "
                  f"({lv - aoi.RIVER_LEVEL:+.2f} m from rivers.level {aoi.RIVER_LEVEL}), {int(m.sum())} samples", file=sys.stderr)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
