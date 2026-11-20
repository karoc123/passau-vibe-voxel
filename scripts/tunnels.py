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

FLOOR holds the driving or walking level (z of the first free voxel) of every bored cell, -1 elsewhere, and IDS the
ways bored, for traffic.py (cars and walkers go through, not over the hill) and underpass.py (which leaves them).
"""
import math

import numpy as np

FLOOR = None
IDS = set()
LOWERED = {}  # (r, c) -> the hill's surface over a bored column whose ground build() lowered to the bore's floor
CARRIAGE = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
            "living_street")
FOOT = ("footway", "path", "cycleway", "pedestrian", "bridleway")
COVER = 2  # metres of ground over the crown that make a bore, not a cut


def _num(v):
    try:
        return float(str(v).split(";")[0].replace(",", ".").split()[0])
    except (ValueError, IndexError):
        return None


def _profile(t):
    """(road half width, bore half width, wall height, crown height, is a road) of a tunnelled way"""
    hw = (t.get("highway") or "").replace("_link", "")
    if hw in CARRIAGE:
        lanes = _num(t.get("lanes")) or (1 if t.get("oneway") in ("yes", "-1") or hw == "service" else 2)
        w = _num(t.get("width")) or lanes * 3.1  # (voxelize.py draws a carriageway lanes x 3.1 m wide)
        return w / 2, w / 2 + 1.0, 4.0, 6.0, True
    if hw in FOOT:
        w = min(max(_num(t.get("width")) or 2.0, 1.5), 4.0)
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


def _cells(geom, D, W):
    from affine import Affine
    from rasterio.features import rasterize
    c0, r0, c1, r1 = (int(math.floor(v)) for v in geom.bounds)
    c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1 + 2, W), min(r1 + 2, D)
    if c1 <= c0 or r1 <= r0:
        return np.zeros(0, int), np.zeros(0, int)
    m = rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=Affine.translation(c0, r0))
    rr, cc = np.nonzero(m)
    return rr + r0, cc + c0


def _portal_level(g, x, y):
    """the street's level at a tunnel's end: the lower ground within 2.5 m (the end node can sit on the rock face's foot)"""
    D, W = g.shape
    r, c = int(y), int(x)
    win = g[max(r - 2, 0):min(r + 3, D), max(c - 2, 0):min(c + 3, W)]
    return int(round(float(np.percentile(win, 30))))


def plan(osm, g):
    """the tunnels under a hill: [(way id, tags, line, profile, z0, z1, portal s0, portal s1)]; fills IDS"""

    IDS.clear()
    out = []
    for oid, t, line in osm.lines:
        if t.get("tunnel") != "yes" or line.length < 10 or t.get("highway") is None:
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
        IDS.add(oid)
    return out


def surface(g):
    """g with the hill's surface again over the bores (the ground rasters the map's other passes read: far terrain,
    objects, labels), not the bores' floors the tiles take"""
    g = g.copy()
    for (r, c), z in LOWERED.items():
        g[r, c] = max(int(g[r, c]), z)
    return g


def build(vol, g, pal, C, stone, note, tunnels):
    """bore the tunnels of plan() into vol; g drops to the road where the approach is cut open"""
    global FLOOR
    LOWERED.clear()
    D, W = g.shape
    H = vol.shape[0]
    FLOOR = np.full((D, W), -1, np.int16)
    if not tunnels:
        note("tunnels through the hills: none")
        return
    lining = C["concrete"]  # (an existing entry: a new one would renumber every later palette colour)
    stone = np.asarray(stone, vol.dtype)
    from aoi import C0, R0  # (the project grid's rows and columns: the same stones in every region)
    masonry = lambda z, r, c: stone[((r + R0) * 7 + (c + C0) * 13 + z * 5) % len(stone)]  # noqa: E731
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
        rr, cc = _cells(line.buffer(hb + 2), D, W)
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
                FLOOR[r, c] = z if FLOOR[r, c] < 0 else min(int(FLOOR[r, c]), z)
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
            # collision (nav/voxel-collision.ts, physics/rapier/terrain.ts) and the car's surface, and the rock over
            # the bore stays as the voxels above it (base runs); surface() gives back the hill's for the rasters
            if z0 < g[r, c] and (r, c) not in wall:
                LOWERED[(r, c)] = int(g[r, c])
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
