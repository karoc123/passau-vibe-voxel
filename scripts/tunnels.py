"""Tunnels through the hills: a road or a path OSM maps as tunnel=yes under a hill (the B 12's two tubes through the
Georgsberg between Veste Oberhaus and Veste Niederhaus) was left out with every other tunnel, and the terrain model
(DGM1, the bare earth over it) stood solid across the road: the street ran into the rock face from both sides.

Such a tunnel is bored through the ground voxels along its centreline: the floor graded straight from one portal's
road level to the other's (the street's level at each end of the way), the bore as wide as the carriageway and a
kerb either side under an arched ceiling (4 m at the walls, 6 m at the crown; a footway 2.6-3.2 m), lined in pale
masonry with a lamp every 8 m along the crown, the road paved with a dashed lane line. The rock over it stays. Where
the hill does not yet stand 2 m over the crown (the slope in front of a portal) the bore is an open cut down to the
road, with stone walls; at the face a stone portal wall frames the arch, 2 m higher than the crown.

Only ways under a hill: a tunnel whose ground never stands 2 m over the crown (under a street, a railway, a
building) is left as it was (voxelize.py's other rules, underpass.py's passages).

A carriageway or a railway tagged tunnel=yes that is not under a hill -- under a street, a junction on an embankment,
a railway (the B 85 link 11773610 under the junction at -882, 667) -- is a covered passage: the ground passes lift
the street over it to its level (ground.py tunnel, sag), and the passage is cut under that street after them. Its
floor graded between its portals' ground as a bore's (rounded down a metre where the street leaves less than LOW m),
its bed's width (ground.bed), the vehicle's clearance (CLEAR: 4 m a road, 5 m a train) or what the street over it
leaves of it under a 1 m slab, LOW m at least; walls and ceiling lined. The stretch from a portal up to the first
point the street stands LOW + 1 m over the floor or a way on the ground crosses over is an open cut (the approach).
One the street over it leaves less than LOW m somewhere (a railway embankment the terrain model dips under) is left
solid and noted. Only ways something covers: one that nothing covers (a street under a bridge's deck, at grade) is
left as it is.

An underground car park's ways are neither (car_park): its aisles (service=parking_aisle) and the tunnel=yes ways that
end on one (its ramps) lie in a building's basement or podium, not in the ground, and the car park is not built. The
Universität's under the Zentralbibliothek (aisle 482662855, ramp 94450270, project col 1087-1150, row 1421-1500): the
terrain model runs over the library's podium 3-6 m over the car park's floor, so the aisle was left solid along its
107 m, and the ramp's inner portal took the podium's level for its floor (a hole in the footway over it).

plan() gives the ways bored (and the covered passages carved) besides its plan, for underpass.py (which leaves them)
and traffic.py; build() gives a Bored: `floor`, the driving or walking level (z of the first free voxel) of every
bored cell, -1 elsewhere, for traffic.py (cars and walkers go through, not over the hill), and `lowered`, (r, c) ->
the hill's surface over a bored column whose ground it lowered to the bore's floor (surface()).
"""
from collections import namedtuple

import numpy as np

from ways import cells, num

CARRIAGE = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
            "living_street")
FOOT = ("footway", "path", "cycleway", "pedestrian", "bridleway")
COVER = 2  # metres of ground over the crown that make a bore, not a cut
# a covered passage: the vehicle's clearance (m), the least it is carved with (m), its profile in plan()'s entries
# (kind "road" | "rail", the bed's half width, the clearance, the least room the street over it leaves along it)
CLEAR = dict(road=4, rail=5)
LOW = 3
Covered = namedtuple("Covered", "kind half clear room")
Bored = namedtuple("Bored", "floor lowered")


def _profile(t):
    """(road half width, bore half width, wall height, crown height, is a road) of a tunnelled way"""
    hw = (t.get("highway") or "").replace("_link", "")
    if hw in CARRIAGE:
        lanes = num(t.get("lanes")) or (1 if t.get("oneway") in ("yes", "-1") or hw == "service" else 2)
        w = num(t.get("width")) or lanes * 3.1  # (voxelize.py draws a carriageway lanes x 3.1 m wide)
        return w / 2, w / 2 + 1.0, 4.0, 6.0, True
    if hw in FOOT:
        w = min(max(num(t.get("width")) or 2.0, 1.5), 4.0)
        return w / 2, w / 2 + 0.3, 2.6, 3.2, False
    return None


def _project(P, line):
    """arc length along line and distance from it of the points P (n, 2)"""
    C = np.asarray(line.coords)
    best_d = np.full(len(P), np.inf)
    best_s = np.zeros(len(P))
    s0 = 0.0
    for a, b in zip(C[:-1], C[1:]):
        ab = b - a
        L = float(np.hypot(*ab))
        if L < 1e-9:
            continue
        t = np.clip(((P - a) @ ab) / (L * L), 0, 1)
        q = a + t[:, None] * ab
        d = np.hypot(*(P - q).T)
        # (past the line's ends: the arc length runs on, so the cut in front of a portal has s < 0 or s > length)
        ext = ((P - a) @ ab) / L
        s = s0 + np.where((t <= 0) & (s0 == 0), ext, np.where((t >= 1) & (abs(s0 + L - line.length) < 1e-6), ext, t * L))
        k = d < best_d
        best_d[k], best_s[k] = d[k], s[k]
        s0 += L
    return best_s, best_d


def _portal_level(g, x, y):
    """the street's level at a tunnel's end: the lower ground within 2.5 m (the end node can sit on the rock face's foot)"""
    D, W = g.shape
    r, c = int(y), int(x)
    win = g[max(r - 2, 0):min(r + 3, D), max(c - 2, 0):min(c + 3, W)]
    return int(round(float(np.percentile(win, 30))))


def _floor(z0, z1, s, L, top):
    """a covered passage's floor at arc lengths s under the ground top: the grade between the portals' levels, rounded
    down where rounded it left less than LOW m under a 1 m slab and rounded down it leaves that"""
    zf = z0 + (z1 - z0) * np.clip(s / L, 0, 1)
    z, zd = np.round(zf).astype(int), np.floor(zf).astype(int)
    return np.where((top - 1 - z < LOW) & (top - 1 - zd >= LOW), zd, z)


def _plan_covered(osm, g, out, ids, skip=frozenset()):
    """the covered passages (module doc): appended to out as (way id, tags, line, Covered, z0, z1, a, b) -- covered
    from a to b along it, cut open before and after; the ones carved into ids; none of skip (car_park)"""
    import shapely
    from shapely.strtree import STRtree

    from ground import bed
    from ways import underground
    D, W = g.shape
    surf = [(t_, l_) for _, t_, l_ in osm.lines if bed(t_) and not underground(t_) and t_.get("bridge") in (None, "no")]
    tree = STRtree([l_ for _, l_ in surf])
    for oid, t, line in osm.lines:
        if t.get("tunnel") != "yes" or oid in ids or oid in skip or line.length < 3 or not bed(t):
            continue
        kind, half = bed(t)
        x0, y0 = line.coords[0]
        x1, y1 = line.coords[-1]
        if not all(2 <= x < W - 2 and 2 <= y < D - 2 for x, y in ((x0, y0), (x1, y1))):
            continue
        z0, z1 = _portal_level(g, x0, y0), _portal_level(g, x1, y1)
        L = line.length
        ss = np.arange(0.0, L + 0.01, 0.5)
        pts = shapely.line_interpolate_point(line, ss)
        xs, ys = shapely.get_x(pts), shapely.get_y(pts)
        top = g[np.clip(ys.astype(int), 0, D - 1), np.clip(xs.astype(int), 0, W - 1)].astype(int)
        room = top - 1 - _floor(z0, z1, ss, L, top)
        # a way on the ground crossing over it (not one going on from its portal: that one ends there)
        over = np.zeros(len(ss), bool)
        for k in tree.query(line):
            t2, l2 = surf[k]
            if l2.crosses(line):
                over |= shapely.contains_xy(l2.buffer(bed(t2)[1], cap_style="flat"), xs, ys)
        hold = ((room >= LOW) | over) & (room >= 0)  # (room < 0: the ground at the floor, open)
        if not hold.any():
            continue  # nothing over it: open to the sky
        k = np.nonzero(hold)[0]
        least = int(np.where(room < 0, 10 ** 6, room)[k[0]:k[-1] + 1].min())
        out.append((oid, t, line, Covered(kind, half, CLEAR[kind], least), z0, z1, float(ss[k[0]]), float(ss[k[-1]])))
        if least >= LOW:
            ids.add(oid)


def car_park(lines):
    """the ids of an underground car park's tunnel=yes ways among lines (osm.lines): its aisles and the ways ending on
    one (its ramps: an end node shared)"""
    tun = [(oid, t, line) for oid, t, line in lines if t.get("tunnel") == "yes"]
    aisles = {oid for oid, t, _ in tun if t.get("service") == "parking_aisle"}
    ends = {line.coords[k] for oid, _, line in tun if oid in aisles for k in (0, -1)}
    return aisles | {oid for oid, _, line in tun if line.coords[0] in ends or line.coords[-1] in ends}


def plan(osm, g):
    """(the tunnels under a hill: [(way id, tags, line, profile, z0, z1, portal s0, portal s1)], then the covered
    passages (_plan_covered: their profile a Covered); the ids of the ways bored or carved)"""
    ids = set()
    out = []
    skip = car_park(osm.lines)
    for oid, t, line in osm.lines:
        if t.get("tunnel") != "yes" or line.length < 10 or t.get("highway") is None or oid in skip:
            continue
        prof = _profile(t)
        if prof is None:
            continue
        hr, hb, hw_, hc, road = prof
        x0, y0 = line.coords[0]
        x1, y1 = line.coords[-1]
        if not all(2 <= x < g.shape[1] - 2 and 2 <= y < g.shape[0] - 2 for x, y in ((x0, y0), (x1, y1))):
            continue  # (a portal off the map)
        z0, z1 = _portal_level(g, x0, y0), _portal_level(g, x1, y1)
        L = line.length
        ss = np.arange(0.0, L + 0.01, 0.5)
        pts = [line.interpolate(s) for s in ss]
        gs = np.array([g[min(max(int(p.y), 0), g.shape[0] - 1), min(max(int(p.x), 0), g.shape[1] - 1)] for p in pts])
        zf = z0 + (z1 - z0) * ss / L
        covered = gs >= np.round(zf) + hc + COVER
        if not covered.any():
            continue
        k = np.nonzero(covered)[0]
        out.append((oid, t, line, prof, z0, z1, float(ss[k[0]]), float(ss[k[-1]])))
        ids.add(oid)
    _plan_covered(osm, g, out, ids, skip)
    return out, ids


def surface(g, lowered):
    """g with the hill's surface again over the bores (lowered: Bored.lowered; the ground rasters the map's other
    passes read: far terrain, objects, labels), not the bores' floors the tiles take"""
    g = g.copy()
    for (r, c), z in lowered.items():
        g[r, c] = max(int(g[r, c]), z)
    return g


def build(vol, g, pal, C, stone, note, tunnels):
    """bore the tunnels of plan() into vol and carve its covered passages; g drops to the road where the approach is
    cut open, and to the floor under a bore or a covered passage; a Bored (its lowered keeps the surface over it)"""
    D, W = g.shape
    bored = Bored(np.full((D, W), -1, np.int16), {})
    lining = C["concrete"]  # (an existing entry: a new one would renumber every later palette colour)
    stone = np.asarray(stone, vol.dtype)
    from aoi import C0, R0  # (the project grid's rows and columns: the same stones in every region)
    masonry = lambda z, r, c: stone[((r + R0) * 7 + (c + C0) * 13 + z * 5) % len(stone)]  # noqa: E731
    covered = [x for x in tunnels if isinstance(x[3], Covered)]
    tunnels = [x for x in tunnels if not isinstance(x[3], Covered)]
    _bore(vol, g, C, note, tunnels, lining, masonry, bored)
    _cover(vol, g, C, note, covered, lining, masonry, bored)
    return bored


def _bore(vol, g, C, note, tunnels, lining, masonry, res):
    D, W = g.shape
    H = vol.shape[0]
    if not tunnels:
        note("tunnels through the hills: none")
        return
    g0 = g.copy()
    clear = {}  # (r, c) -> [z0, z1): emptied
    floor = {}  # (r, c) -> (z, palette id): the road's (or the path's) surface voxel
    wall = {}  # (r, c) -> [z0, z1, hole0, hole1): portal wall from z0 to z1 round the arch's hole
    bore = {}  # (r, c) -> in the bored stretch (a pale lining) or not (the cut and the portal: masonry)
    lamps = []

    def add(r, c, z0, z1):
        o = clear.get((r, c))
        clear[(r, c)] = (min(z0, o[0]), max(z1, o[1])) if o else (z0, z1)

    # footways first: where a sidewalk's tube runs into the carriageway's, the road's floor wins
    for oid, t, line, (hr, hb, hw_, hc, road), z0, z1, sp0, sp1 in sorted(tunnels, key=lambda x: x[3][4]):
        L = line.length
        rr, cc = cells(line.buffer(hb + 2), D, W)
        s, d = _project(np.stack([cc + 0.5, rr + 0.5], 1), line)
        keep = (s >= -1.5) & (s <= L + 1.5)
        rr, cc, s, d = rr[keep], cc[keep], s[keep], d[keep]
        zf = np.round(z0 + (z1 - z0) * np.clip(s / L, 0, 1)).astype(int)
        h = np.round(hw_ + (hc - hw_) * np.sqrt(np.clip(1 - (d / hb) ** 2, 0, 1))).astype(int)
        n_c = 0
        for r, c, s_, d_, z, h_ in zip(rr.tolist(), cc.tolist(), s.tolist(), d.tolist(), zf.tolist(), h.tolist()):
            bored = sp0 <= s_ <= sp1
            front = sp0 - 1.5 <= s_ < sp0 or sp1 < s_ <= sp1 + 1.5  # the portal wall's footprint
            bore[(r, c)] = bore.get((r, c), False) or bored
            if front and d_ <= hb + 1.5:
                hole = (z, z + h_) if d_ <= hb else (z, z)
                wall[(r, c)] = (min(z, int(g0[r, c])) - 1, z + int(round(hc)) + 2) + hole
            if d_ > hb:
                continue
            if bored or front:
                add(r, c, z, z + h_)
            elif 0 <= s_ <= L:  # the approach under the slope: cut open to the sky
                add(r, c, z, max(z + h_, int(g0[r, c])))
            else:  # past the way's end: only the foot of the slope, never what stands on the street
                add(r, c, z, max(z, int(g0[r, c])))
            on_road = d_ <= hr
            if road or (r, c) not in floor:
                floor[(r, c)] = (z - 1, (C["mark"] if d_ < 0.5 and s_ % 6.0 < 3.0 and hr >= 2.5 else C["asphalt"])
                                 if road and on_road else C["kerb"] if road else C["paving2"])
            if on_road:
                res.floor[r, c] = z if res.floor[r, c] < 0 else min(int(res.floor[r, c]), z)
            if road and bored and d_ < 0.5 and abs((s_ - sp0) % 8.0 - 4.0) < 0.5:
                lamps.append((z + h_, r, c))
            n_c += 1
        note(f"tunnel {t.get('name') or oid} ({oid}, {t.get('highway')}): {L:.0f} m, road level {z0} -> {z1}, "
             f"bored {sp0:.1f}-{sp1:.1f} m along it, {n_c} columns")
    # the portal walls: masonry from the ground to 2 m over the crown, the arch open
    n_w = 0
    for (r, c), (zb, zt, h0, h1) in wall.items():
        for z in range(max(zb, 0), min(zt, H)):
            if not h0 <= z < h1:
                vol[z, r, c] = masonry(z, r, c)
                n_w += 1
        if (r, c) in clear:  # (over the arch the wall stands, not the open cut)
            clear[(r, c)] = (clear[(r, c)][0], h1) if h1 > h0 else (0, 0)
    for (r, c), (z0, z1) in clear.items():
        vol[z0:min(z1, H), r, c] = 0
        if not bore[(r, c)] and (r, c) not in wall and z1 >= g0[r, c]:
            g[r, c] = z0  # cut open: the ground is the road now
        elif z1 > z0 and ((r, c) in wall or bore[(r, c)]):
            # the bore's floor is the column's ground: the tiles' ground is solid from 0 up to it for the viewer's
            # collision (nav/voxel-collision.ts, physics/rapier/terrain.ts), and the rock over
            # the bore stays as the voxels above it (base runs); surface() gives back the hill's for the rasters
            if z0 < g[r, c] and (r, c) not in wall:
                res.lowered[(r, c)] = int(g[r, c])
            g[r, c] = min(int(g[r, c]), z0)
    # line what the bore and the cut bare -- the ground's voxels, not what stands on it: masonry in the cut, a pale
    # lining in the tunnel, instead of the soil inside the hill
    n_l = 0
    for (r, c), (z0, z1) in clear.items():
        for r2, c2 in ((r, c + 1), (r, c - 1), (r + 1, c), (r - 1, c)):
            if not (0 <= r2 < D and 0 <= c2 < W) or (r2, c2) in wall:
                continue
            a, b = clear.get((r2, c2), (0, 0))
            for z in range(z0, min(z1, int(g0[r2, c2]), H)):
                if not a <= z < b and vol[z, r2, c2] != 0:
                    vol[z, r2, c2] = lining if bore.get((r2, c2), False) else masonry(z, r2, c2)
                    n_l += 1
        if bore[(r, c)] and z1 < min(int(g0[r, c]), H) and vol[z1, r, c] != 0:  # the ceiling
            vol[z1, r, c] = lining
            n_l += 1
    for (r, c), (z, v) in floor.items():
        if z >= 0 and (r, c) in clear and clear[(r, c)][1] > clear[(r, c)][0]:
            lo = min(int(g0[r, c]) - 1, z)
            vol[lo:z, r, c] = np.where(vol[lo:z, r, c] == 0, C["soil"], vol[lo:z, r, c])  # (a floor over a dip)
            vol[z, r, c] = v
    for z, r, c in lamps:
        if z < H and vol[z, r, c] != 0:
            vol[z, r, c] = C["lamp"]
    note(f"tunnels through the hills: {len(tunnels)} ways, {len(clear)} columns bored or cut, {n_w} voxels of portal "
         f"wall, {n_l} of lining, {len(lamps)} lamps")


def _cover(vol, g, C, note, covered, lining, masonry, res):
    """carve the covered passages of plan() (module doc) under the street the ground passes left over them"""
    if not covered:
        return
    D, W = g.shape
    H = vol.shape[0]
    n_c = n_cut = n_low = 0
    for oid, t, line, (kind, half, clear, least), z0, z1, a, b in covered:
        name = f"{t.get('name') or oid} ({oid}, {t.get('highway') or t.get('railway')})"
        if least < LOW:
            note(f"covered passage {name}: left solid, the street over it leaves {least} m (under {LOW})")
            continue
        L = line.length
        rr, cc = cells(line.buffer(half + 1, cap_style="flat"), D, W)
        s, d = _project(np.stack([cc + 0.5, rr + 0.5], 1), line)
        keep = (s >= 0) & (s <= L) & np.array([(r, c) not in res.lowered for r, c in zip(rr.tolist(), cc.tolist())], bool)
        rr, cc, s, d = rr[keep], cc[keep], s[keep], d[keep]
        top = g[rr, cc].astype(int)
        zf = _floor(z0, z1, s, L, top)
        bed = d <= half
        clr = {}  # (r, c) -> [z, z1) emptied, covered or cut open
        lo_h = 10 ** 6
        for r, c, s_, d_, z, t_ in zip(rr[bed].tolist(), cc[bed].tolist(), s[bed].tolist(), d[bed].tolist(),
                                       zf[bed].tolist(), top[bed].tolist()):
            if a <= s_ <= b:  # under the street: a 1 m slab over the passage
                h = min(clear, t_ - 1 - z)
                if h > 0:
                    vol[z:z + h, r, c] = 0
                    if z + h < t_ - 1:  # (the ceiling; where the slab is the street's own voxel, that stays)
                        vol[z + h, r, c] = lining
                    clr[(r, c)] = (z, z + h, True)
                    lo_h = min(lo_h, h)
                if t_ > z:
                    res.lowered[(r, c)] = t_
            elif t_ > z:  # the approach: cut open
                vol[z:min(t_, H), r, c] = 0
                clr[(r, c)] = (z, t_, False)
                n_cut += 1
            lo = max(min(t_, z) - 1, 0)  # (a floor over a dip: soil under it)
            vol[lo:z, r, c] = np.where(vol[lo:z, r, c] == 0, C["soil"], vol[lo:z, r, c])
            if kind == "rail":
                v = C["rail"] if abs(d_ - 0.72) < 0.5 else C["ballast"]
            else:
                v = C["mark"] if d_ < 0.5 and s_ % 6.0 < 3.0 and half >= 2.5 else C["asphalt"]
            vol[z - 1, r, c] = v
            g[r, c] = z
            res.floor[r, c] = z if res.floor[r, c] < 0 else min(int(res.floor[r, c]), z)
            n_c += 1
        # the walls: what the passage bares of the ground beside it, lined (masonry along the cut)
        for (r, c), (z, z1_, cov) in clr.items():
            for r2, c2 in ((r, c + 1), (r, c - 1), (r + 1, c), (r - 1, c)):
                if not (0 <= r2 < D and 0 <= c2 < W) or (r2, c2) in clr:
                    continue
                for z_ in range(z, min(z1_, int(res.lowered.get((r2, c2), g[r2, c2])) - (1 if cov else 0), H)):
                    if vol[z_, r2, c2] != 0:
                        vol[z_, r2, c2] = lining if cov else masonry(z_, r2, c2)
        if lo_h < clear:
            n_low += 1
        note(f"covered passage {name}: {L:.0f} m, floor {z0} -> {z1}, under the street {a:.1f}-{b:.1f} m along it, "
             f"clearance {lo_h if lo_h < 10 ** 6 else '-'} m at least (the vehicle's {clear})")
    note(f"covered passages: {len(covered)} ways, {n_c} columns carved ({n_cut} cut open), {n_low} lower than the "
         f"vehicle's clearance")
