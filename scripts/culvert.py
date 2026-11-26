"""A way over water that OSM does not tag as a bridge keeps its surface (the B 8 at the Baderbachl mouth).

voxelize.py paints the water after the ways, and the water wins: a road OSM maps as plain road over a culvert or an
untagged short bridge (the B 8 over the Baderbachl mouth, way 73317832 at project col -3048, row -88: the stream is
`tunnel=yes`, the road has no `bridge` tag) was cut by the water under it, and the sag lift (ground.sag) does not lift
ground at the rivers' level. One rule: a stretch of a way (a carriageway, path or railway; not on a bridge, not
underground, not a ford) that runs over water, where the surface model's lowest return along it stays at the way's
ground on the banks (from T["below"] under it to T["above"] over it, at T["share"] of its metres: crowns and cars may
stand over it, the water may not show through) and at most T["rise"] over the water, is carried over (a way that ends
in the water, going on as another way, takes the one bank it has): the way's cells there (the water, and the ground the
terrain model dips under the line by the water's edge, T["bank"] m each side) are ground again, at the line between
the banks' ground, in the colours the ways gave them (a culvert; the water stays on either side).

Not the deck code: the deck needs 2 m of air under it and drops a scrap of deck with less (voxelize.py), and these
roads stand 1-1.5 m over the water. Over open water the image-matched surface model stands 1-3 m over the river: a
way OSM draws a few metres into the river off its bank (the Donauradweg at 1022, 671) has its noise there, not its
bank's level, and stays in the water -- counted (wet_metres) for the build's check. A way higher over the water is a
bridge OSM does not tag (the Anton-Niederleuthner-Brücke's end, way 8027919, 6 m over the Ilz): ground lifted there
stood as a dam in the river, so it stays too (a fix in OSM: handoff Q7)."""
import numpy as np
import shapely
from shapely.ops import substring

from ground import RAILS
from ways import ROADS, underground, way_width

T = dict(
    below=0.6, above=1.0, share=0.8,  # the surface model along the stretch from below to above the banks' line (m)
    bank=5,  # the banks' ground: the median of the way's ground over this many metres off the water's edge
    span=150,  # the longest stretch carried over (m)
    rise=2,  # the most the way stands over the water (m): higher, it is a bridge OSM does not tag (a deck, not a dam;
    # the B 8 and the Kachlet's service road stand 1 m over it, the ways onto the Gaißabrücke's deck 3 m)
)


def half_width(t):
    """the half width (m) of a way the rule carries over, else None: a highway drawn on the ground, a railway"""
    if t.get("bridge") not in (None, "no") or t.get("man_made") == "bridge" or underground(t) \
            or t.get("ford") not in (None, "no"):
        return None
    if t.get("railway") in RAILS:
        return 1.4 if t.get("railway") == "tram" else 1.9
    w = way_width(t) if t.get("highway") else 0
    return w / 2 if w else None


def _samples(line, D, W):
    """the way's centreline every metre: (distances, rows, cols, in the grid)"""
    s = np.arange(0.5, line.length, 1.0)
    if not len(s):
        return s, np.zeros(0, int), np.zeros(0, int), np.zeros(0, bool)
    xy = shapely.get_coordinates(shapely.line_interpolate_point(line, s))
    r, c = np.floor(xy[:, 1]).astype(int), np.floor(xy[:, 0]).astype(int)
    ok = (r >= 0) & (r < D) & (c >= 0) & (c < W)
    return s, np.clip(r, 0, D - 1), np.clip(c, 0, W - 1), ok


def carry(osm, wet, g, lo, wlev, cells_of):
    """the cells to carry over (bool), their ground (int, where the mask is set), and (way id, metres) carried.
    wet: the water; g: the ground (m over BASE, whole metres); lo: the surface model's lowest return (m over BASE);
    wlev: the water's level (its body's, m over BASE, whole metres; else the ground)"""
    D, W = wet.shape
    mask = np.zeros((D, W), bool)
    level = np.zeros((D, W), np.int32)
    done = []
    for oid, t, line in osm.lines:
        half = half_width(t)
        if half is None:
            continue
        s, r, c, ok = _samples(line, D, W)
        w = ok & wet[r, c]
        if not w.any():
            continue
        # the runs of wet samples, each with the dry ones round it on either side (a bank) or the way's end
        edges = np.flatnonzero(np.diff(np.r_[0, w.astype(np.int8), 0]))
        for i0, i1 in zip(edges[::2], edges[1::2]):
            if i1 - i0 > T["span"]:
                continue
            banks = []
            for a, b in ((max(i0 - T["bank"], 0), i0), (i1, min(i1 + T["bank"], len(s)))):
                if a == b:
                    continue  # the way ends in the water (it goes on as another way)
                if not ok[a:b].all() or w[a:b].any():
                    banks = None  # out of the region's window, or the next run's water: undecided
                    break
                banks.append((s[a:b].mean(), float(np.median(g[r[a:b], c[a:b]]))))
            if not banks:
                continue
            (sa, ga), (sb, gb) = banks[0], banks[-1]
            f = np.clip((s[i0:i1] - sa) / max(sb - sa, 1e-6), 0, 1)
            line_ = ga + (gb - ga) * f
            d = lo[r[i0:i1], c[i0:i1]] - line_
            if ((d >= -T["below"]) & (d <= T["above"])).mean() < T["share"] \
                    or (line_ - wlev[r[i0:i1], c[i0:i1]]).max() > T["rise"]:
                continue
            # the way's cells from bank to bank: the water, and the ground under the line by the water's edge (the
            # terrain model dips there; the water's edge runs across the way at a slant)
            s0, s1 = max(s[i0] - T["bank"], 0), min(s[i1 - 1] + T["bank"], line.length)
            rr, cc = cells_of(substring(line, s0, s1).buffer(half, cap_style="flat"))
            if not len(rr):
                continue
            q = shapely.line_locate_point(line, shapely.points(cc + 0.5, rr + 0.5))
            lv = np.round(ga + (gb - ga) * np.clip((q - sa) / max(sb - sa, 1e-6), 0, 1)).astype(np.int32)
            k = wet[rr, cc] | (g[rr, cc] < lv)
            rr, cc, lv = rr[k], cc[k], lv[k]
            mask[rr, cc] = True
            level[rr, cc] = np.maximum(level[rr, cc], np.maximum(lv, g[rr, cc]))
            done.append((oid, int(i1 - i0)))
    return mask, level, done


def wet_metres(osm, wet, core):
    """{way id: metres of its centreline on water} of every way the rule looks at, counted in core (the region's
    core: (r0, r1, c0, c1)), and the subset of them that are carriageways or railways -- but a ramp that runs into the
    water on purpose (canoe=portage, leisure=slipway: the portage road 212067382 by the Ingling dam's forebay, sett down
    into the pool) is listed only"""
    D, W = wet.shape
    r0, r1, c0, c1 = core
    out, hard = {}, {}
    for oid, t, line in osm.lines:
        if half_width(t) is None:
            continue
        s, r, c, ok = _samples(line, D, W)
        n = int((ok & wet[r, c] & (r >= r0) & (r < r1) & (c >= c0) & (c < c1)).sum())
        if n:
            out[str(oid)] = n
            if (t.get("railway") in RAILS or t.get("highway") in ROADS) and t.get("canoe") != "portage" \
                    and t.get("leisure") != "slipway":
                hard[str(oid)] = n
    return out, hard
