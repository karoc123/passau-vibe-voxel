"""Small parametric building blocks a building override (scripts/overrides/building/*.json) places by name:

    {"part": "helm", "at": "highest", "shape": "onion", "radius": 3, "height": 9}

Each part is a function drawing into the region's volume from a few parameters, at a point of the building:
  at      "centre" (default) | "highest" (the footprint's tallest column) | [x, y] in EPSG:25832 |
          {"u": 0..1, "v": 0..1}: along the footprint's long axis (u: 0 at its west end, or north for a north-south
          building) and across it (v: 0 on the left of that direction, i.e. the north side of an east-west building)
  repeat  {"count": n, "step": [dx, dy]}: n copies, each dx m east and dy m north of the last
  facing  (dormer, bay_window, arcade) "auto": away from the footprint at the nearest facade; n | e | s | w | a bearing
Every other key is the part's own (PARTS[name]["params"]: type, default, range). To add a part: a function
(ctx, y, x, p) -> number of voxels set, and its entry in PARTS with the parameters it takes; validation, the docs
(`uv run python scripts/parts.py`) and the skill pick it up from there.

Everything is a function of the building's own cells and the voxels already in its columns, in the project grid's
coordinates, so a part comes out the same in every region that holds the building (`scripts/check.py covers`).
"""
import math

import numpy as np
from scipy import ndimage

COPPER, GOLD, BRICK, GLASS = "#6f9285", "#d4af37", "#8a4b3c", "#3a4644"


def _p(kind, default=None, lo=None, hi=None, doc=""):
    return dict(kind=kind, default=default, lo=lo, hi=hi, doc=doc)


FACING = _p("facing", "auto", doc="auto | n | e | s | w | bearing in degrees")


# ---------------------------------------------------------------- the building a part is placed on

class Ctx:
    """the volume (H, D, W), ground voxel per cell, palette, and the building's cells (region rows/columns) with its
    wall and roof palette ids; R0, C0: the region's first project row and column"""

    def __init__(self, vol, g, pal, rr, cc, wall, roof, R0, C0, mats):
        self.vol, self.g, self.pal, self.wall, self.roof, self.R0, self.C0, self.mats = vol, g, pal, wall, roof, R0, C0, mats
        self.rr, self.cc = rr, cc
        P = 12
        self.r0, self.c0 = int(rr.min()) - P, int(cc.min()) - P
        self.fp = np.zeros((int(rr.max()) - self.r0 + P + 1, int(cc.max()) - self.c0 + P + 1), bool)
        self.fp[rr - self.r0, cc - self.c0] = True
        self._out = None

    def inside(self, r, c):
        return 0 <= r < self.vol.shape[1] and 0 <= c < self.vol.shape[2]

    def in_fp(self, r, c):
        i, j = r - self.r0, c - self.c0
        return 0 <= i < self.fp.shape[0] and 0 <= j < self.fp.shape[1] and bool(self.fp[i, j])

    def top(self, r, c):
        """the first empty voxel over the column's highest one"""
        nz = np.flatnonzero(self.vol[:, r, c])
        return int(nz[-1]) + 1 if len(nz) else int(self.g[r, c])

    def colour(self, p, key, default_id, mat_key=None, default_mat="wall"):
        if p.get(key) is None:
            return default_id
        return self.pal(p[key], self.mats[p.get(mat_key or "material") or default_mat])

    def outward(self, y, x):
        """the unit vector (east, south) from (y, x) to the nearest cell outside the footprint"""
        if self._out is None:
            self._out = ndimage.distance_transform_edt(self.fp, return_indices=True)[1]
        i, j = min(max(int(y) - self.r0, 0), self.fp.shape[0] - 1), min(max(int(x) - self.c0, 0), self.fp.shape[1] - 1)
        oy, ox = self._out[0][i, j] + self.r0 + 0.5, self._out[1][i, j] + self.c0 + 0.5
        dx, dy = ox - x, oy - y
        n = math.hypot(dx, dy)
        return (dx / n, dy / n) if n > 1e-6 else (0.0, 1.0)

    def facing(self, y, x, f):
        if f in (None, "auto"):
            return self.outward(y, x)
        b = {"n": 0, "e": 90, "s": 180, "w": 270}.get(f, f)
        b = math.radians(float(b))
        return math.sin(b), -math.cos(b)

    def set(self, z, r, c, v, only_empty=False):
        if self.inside(r, c) and 0 <= z < self.vol.shape[0] and (not only_empty or self.vol[z, r, c] == 0):
            self.vol[z, r, c] = v
            return 1
        return 0


def frame(rr, cc, R0, C0, ridge_dir="long"):
    """the footprint's axes from its cells (project grid, so every region agrees): (u, v) per cell centred on the
    footprint's box in that frame, the half-lengths (hu, hv), the unit axes (east, south) ax and perp; ax points east
    (south when north-south), perp to its right (south of an east-west axis)"""
    pts = np.stack([cc + C0 + 0.5, rr + R0 + 0.5], 1).astype(float)
    mu = pts.mean(0)
    _, _, vt = np.linalg.svd(pts - mu, full_matrices=False)
    if ridge_dir == "short":
        ax = vt[1]
    elif isinstance(ridge_dir, (int, float)) and not isinstance(ridge_dir, bool):
        b = math.radians(ridge_dir)
        ax = np.array([math.sin(b), -math.cos(b)])
    else:
        ax = vt[0]
    ax = ax if (ax[0] > 1e-9 or (abs(ax[0]) <= 1e-9 and ax[1] > 0)) else -ax
    perp = np.array([-ax[1], ax[0]])
    u, v = (pts - mu) @ ax, (pts - mu) @ perp
    cu, cv = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
    return u - cu, v - cv, (np.ptp(u) + 1) / 2, (np.ptp(v) + 1) / 2, ax, perp, mu + cu * ax + cv * perp


# ---------------------------------------------------------------- the parts

def _profile(shape, t):
    if shape in ("pyramid", "cone"):
        return 1 - t
    if shape == "needle":
        return (1 - t) ** 1.4
    if shape == "dome":
        return math.sqrt(max(0.0, 1 - t * t))
    # onion: out to 1.25 R a quarter up, in to a slim neck, a short spike
    if t < 0.28:
        return 1 + 0.25 * math.sin(math.pi / 2 * t / 0.28)
    if t < 0.78:
        return 1.25 * math.cos(math.pi / 2 * (t - 0.28) / 0.5) ** 0.9 + 0.12 * (t - 0.28) / 0.5
    return 0.14 * (1 - (t - 0.78) / 0.22)


def _in_plan(plan, dx, dy, rad):
    if plan == "square":
        return max(abs(dx), abs(dy)) <= rad
    if plan == "round":
        return math.hypot(dx, dy) <= rad
    a, b = max(abs(dx), abs(dy)), min(abs(dx), abs(dy))
    return a <= rad and a + b <= 1.42 * rad


def helm(ctx, y, x, p):
    """A tower's roof: pyramid, cone, needle (spire), dome or onion over the tower's top (or from `base` m over the
    ground, clearing what stands above that within the radius), with a cross or a ball on the tip; with `shaft`, the
    tower from there up to the helm a prism of the helm's plan in the facade's colour"""
    R, H = p["radius"], int(round(p["height"]))
    plan = p["plan"] or ("square" if p["shape"] == "pyramid" else "octagon")
    reach = int(math.ceil(R * 1.3)) + 1
    r0, c0 = int(math.floor(y)), int(math.floor(x))
    cells = [(r, c) for r in range(r0 - reach, r0 + reach + 1) for c in range(c0 - reach, c0 + reach + 1) if ctx.inside(r, c)]
    g0 = int(ctx.g[r0, c0]) if ctx.inside(r0, c0) else 0
    if p["base"] is not None:
        zb = g0 + int(round(p["base"]))
        for r, c in cells:
            if math.hypot(c + 0.5 - x, r + 0.5 - y) <= R * 1.3 + 0.5:
                ctx.vol[zb:, r, c] = 0
    else:
        zb = max(ctx.top(r, c) for r, c in cells if math.hypot(c + 0.5 - x, r + 0.5 - y) <= max(R, 1))
    mat = ctx.pal(p["colour"] or COPPER, ctx.mats[p["material"]])
    n = 0
    if p["shaft"] is not None:  # the tower's sides under the helm in the facade's colour (not the roof's)
        sh = ctx.colour(p, "shaft_colour", ctx.wall, "shaft_material", "wall")
        for r, c in cells:
            if _in_plan(plan, c + 0.5 - x, r + 0.5 - y, R + 0.3):  # (a prism of the helm's plan, gaps filled)
                lo = g0 + int(round(p["shaft"]))
                n += max(zb - lo, 0)
                ctx.vol[lo:zb, r, c] = sh
    for k in range(H):
        rad = R * _profile(p["shape"], (k + 0.5) / H) + 0.3
        for r, c in cells:
            if _in_plan(plan, c + 0.5 - x, r + 0.5 - y, rad):
                n += ctx.set(zb + k, r, c, mat)
    tip = ctx.pal(p["tip_colour"], ctx.mats["metal"])
    zt = zb + H
    if p["tip"] == "ball":
        n += ctx.set(zt, r0, c0, tip)
    elif p["tip"] == "cross":
        for k in range(3):
            n += ctx.set(zt + k, r0, c0, tip)
        if p["cross_arms"] == "ew":
            n += ctx.set(zt + 1, r0, c0 - 1, tip) + ctx.set(zt + 1, r0, c0 + 1, tip)
        else:
            n += ctx.set(zt + 1, r0 - 1, c0, tip) + ctx.set(zt + 1, r0 + 1, c0, tip)
    return n


def _box(ctx, y, x, n, width, depth0, depth1):
    """cells whose centre lies within width/2 across and depth0..depth1 along n (east, south) from (y, x): [(r, c, s, t)]"""
    a = (-n[1], n[0])
    reach = int(math.ceil(max(width, abs(depth0), abs(depth1)))) + 2
    out = []
    for r in range(int(y) - reach, int(y) + reach + 1):
        for c in range(int(x) - reach, int(x) + reach + 1):
            dx, dy = c + 0.5 - x, r + 0.5 - y
            s, t = dx * n[0] + dy * n[1], dx * a[0] + dy * a[1]
            if depth0 <= s < depth1 and abs(t) < width / 2 and ctx.inside(r, c):
                out.append((r, c, s, t))
    return out


def dormer(ctx, y, x, p):
    """A gabled dormer on a pitched roof: its front `facing` (auto: towards the nearest eave) at the point, `depth` m
    back into the roof, `width` wide, `height` m of front wall over the roof at its front, a window in it"""
    n = ctx.facing(y, x, p["facing"])
    cells = _box(ctx, y, x, n, p["width"], -0.5, p["depth"])
    cells = [q for q in cells if ctx.in_fp(q[0], q[1])]
    if not cells:
        return 0
    zb = min(ctx.top(r, c) for r, c, s, _ in cells if s < 0.5) if any(s < 0.5 for _, _, s, _ in cells) \
        else min(ctx.top(r, c) for r, c, _, _ in cells)
    h = int(round(p["height"]))
    wall = ctx.colour(p, "colour", ctx.wall)
    roof = ctx.colour(p, "roof_colour", ctx.roof, "roof_material", "roof")
    win = ctx.pal(GLASS, ctx.mats["window"])
    k = 0
    for r, c, s, t in cells:
        cap = max(0, int(p["width"] / 2 - abs(t) - 0.5))  # the gable over the front wall (from 3 m wide)
        zt = zb + h + cap
        if zt <= ctx.top(r, c):
            continue
        front = s < 0.5
        body = wall if front else roof  # (the cheeks and the back in the roof's sheet, the front in the facade's)
        ctx.vol[zb:zt, r, c] = np.where(ctx.vol[zb:zt, r, c] == 0, body, ctx.vol[zb:zt, r, c])
        ctx.vol[zt - 1, r, c] = roof
        k += zt - zb
        if p["window"] and front and (p["width"] < 3 or abs(t) <= p["width"] / 2 - 1):
            for z in range(zb, zb + h - 1):
                ctx.vol[z, r, c] = win
    return k


def chimney(ctx, y, x, p):
    """A chimney stack `width` x `depth` m standing `height` m over the roof's highest cell under it"""
    w, d = int(round(p["width"])), int(round(p["depth"]))
    r0, c0 = int(math.floor(y - (d - 1) / 2)), int(math.floor(x - (w - 1) / 2))
    cells = [(r, c) for r in range(r0, r0 + d) for c in range(c0, c0 + w) if ctx.inside(r, c)]
    if not cells:
        return 0
    zb = max(ctx.top(r, c) for r, c in cells)
    zt = zb + int(round(p["height"]))
    v = ctx.pal(p["colour"], ctx.mats[p["material"]])
    for r, c in cells:
        lo = ctx.top(r, c)
        ctx.vol[lo:zt, r, c] = v
    return len(cells) * (zt - zb)


def bay_window(ctx, y, x, p):
    """An oriel (Erker): a box `depth` m out of the facade nearest the point, `width` wide, from `from` to `to` m over
    the ground, windows in its front, a roof on top"""
    n = ctx.facing(y, x, p["facing"])
    g0 = int(ctx.g[int(y), int(x)]) if ctx.inside(int(y), int(x)) else 0
    # from the facade: the first cell outside the footprint along n
    fy, fx = y, x
    for _ in range(30):
        if not ctx.in_fp(int(fy), int(fx)):
            break
        fy, fx = fy + n[1] * 0.5, fx + n[0] * 0.5
    cells = [q for q in _box(ctx, fy, fx, n, p["width"], -0.5, p["depth"] - 0.5) if not ctx.in_fp(q[0], q[1])]
    z0, z1 = g0 + int(round(p["from"])), g0 + int(round(p["to"]))
    wall = ctx.colour(p, "colour", ctx.wall)
    roof = ctx.colour(p, "roof_colour", ctx.roof, "roof_material", "roof")
    win = ctx.pal(GLASS, ctx.mats["window"])
    k = 0
    for r, c, s, t in cells:
        front = s >= p["depth"] - 1.5 and abs(t) < p["width"] / 2 - 0.75
        for z in range(z0, z1):
            glass = front and z0 < z < z1 - 1 and (z - z0) % 3 != 0
            k += ctx.set(z, r, c, win if glass else wall)
        k += ctx.set(z1, r, c, roof)
    return k


def arcade(ctx, y, x, p):
    """Arcades in the ground floor: `count` arches `span` m apart along the facade nearest the point (centred on it),
    each `span - pier` wide and `height` m to its crown, a hall `depth` m deep behind them"""
    n = ctx.facing(y, x, p["facing"])
    # the facade: walk out to the footprint's edge, then a cell back in
    fy, fx = y, x
    for _ in range(30):
        if not ctx.in_fp(int(fy + n[1] * 0.5), int(fx + n[0] * 0.5)):
            break
        fy, fx = fy + n[1] * 0.5, fx + n[0] * 0.5
    span, cnt, pier = p["span"], p["count"], p["pier"]
    L = span * cnt
    rad = (span - pier) / 2
    spring = max(p["height"] - rad, 1)
    k = 0
    for r, c, s, t in _box(ctx, fy, fx, (-n[0], -n[1]), L, -0.5, p["depth"]):
        if not ctx.in_fp(r, c):
            continue
        g0 = int(ctx.g[r, c])
        tt = (t + L / 2) % span - span / 2  # across the bay, from its centre
        if s < 1:  # the facade row: the arches
            if abs(tt) > rad:
                continue
            h = spring + math.sqrt(max(rad * rad - tt * tt, 0))
        else:
            h = p["height"]
        for z in range(g0, g0 + int(round(h))):
            if ctx.vol[z, r, c]:
                ctx.vol[z, r, c] = 0
                k += 1
    return k


def weir(ctx, y, x, p):
    """A weir's bays: `count` openings `span` m apart (centre to centre) along `bearing`, centred on the point, each
    `span - pier` wide, cut through the whole footprint from the gates' top `sill` up to the service bridge's
    underside `soffit` (m a.s.l.); what is left between `pier`s and over the bays (piers, gates, bridge) takes `colour`
    when given. For a weir or dam OSM draws as one building outline across the river (a power station's whole plant)"""
    from aoi import BASE
    b = math.radians(p["bearing"])
    ax = (math.sin(b), -math.cos(b))  # (east, south)
    span, cnt = p["span"], p["count"]
    L = span * cnt
    half = (span - p["pier"]) / 2
    z0, z1 = int(round(p["sill"] - BASE)), int(round(p["soffit"] - BASE))
    col = ctx.pal(p["colour"], ctx.mats[p["material"]]) if p["colour"] else None
    k = 0
    for r, c in zip(ctx.rr, ctx.cc):
        t = (c + 0.5 - x) * ax[0] + (r + 0.5 - y) * ax[1]
        if abs(t) > L / 2 + p["pier"] / 2:
            continue
        tt = (t + L / 2) % span - span / 2  # from the bay's centre
        if col is not None:
            nz = np.flatnonzero(ctx.vol[:, r, c])
            nz = nz[nz >= ctx.g[r, c]]
            ctx.vol[nz, r, c] = col
        if abs(t) < L / 2 and abs(tt) < half:
            seg = ctx.vol[z0:z1, r, c]
            k += int(np.count_nonzero(seg))
            seg[:] = 0
    return k


PARTS = {
    "weir": dict(fn=weir, params=dict(
        count=_p("int", 6, 1, 30), span=_p("num", 30, 4, 80, "m, centre to centre"), pier=_p("num", 6, 1, 20, "m"),
        bearing=_p("num", 0, 0, 360, "degrees: the weir's axis, along which the bays follow each other"),
        sill=_p("num", 300, 250, 400, "m a.s.l.: the gates' top"), soffit=_p("num", 310, 250, 400, "m a.s.l."),
        colour=_p("colour", None, doc="default: leave the voxels' colour"), material=_p("material", "solid"))),
    "helm": dict(fn=helm, params=dict(
        shape=_p("enum:pyramid,cone,needle,dome,onion", "pyramid"), radius=_p("num", 3, 0.5, 15, "m"),
        height=_p("num", 6, 1, 60, "m"), plan=_p("enum:square,octagon,round", None),
        base=_p("num", None, 0, 150, "m over the ground; default the tower's top"),
        colour=_p("colour", None, doc=f"default copper {COPPER}"), material=_p("material", "roof"),
        tip=_p("enum:cross,ball,none", "cross"), tip_colour=_p("colour", GOLD), cross_arms=_p("enum:ew,ns", "ew"),
        shaft=_p("num", None, 0, 150, "m over the ground: from there up to the helm the tower a prism of the helm's plan"),
        shaft_colour=_p("colour", None, doc="default the building's wall"), shaft_material=_p("material", "wall"))),
    "dormer": dict(fn=dormer, params=dict(
        width=_p("num", 3, 1, 8, "m"), depth=_p("num", 3, 1, 8, "m"), height=_p("num", 2, 1, 5, "m"), facing=FACING,
        colour=_p("colour", None, doc="default the building's wall"), material=_p("material", "wall"),
        roof_colour=_p("colour", None, doc="default the building's roof"), roof_material=_p("material", "roof"),
        window=_p("bool", True))),
    "chimney": dict(fn=chimney, params=dict(
        width=_p("num", 1, 1, 4, "m"), depth=_p("num", 1, 1, 4, "m"), height=_p("num", 2, 1, 30, "m over the roof"),
        colour=_p("colour", BRICK), material=_p("material", "wall"))),
    "bay_window": dict(fn=bay_window, params=dict(
        width=_p("num", 3, 1, 10, "m"), depth=_p("num", 1, 1, 3, "m"), facing=FACING,
        **{"from": _p("num", 3, 0, 60, "m over the ground"), "to": _p("num", 9, 1, 80, "m over the ground")},
        colour=_p("colour", None, doc="default the building's wall"), material=_p("material", "wall"),
        roof_colour=_p("colour", None, doc="default the building's roof"), roof_material=_p("material", "roof"))),
    "arcade": dict(fn=arcade, params=dict(
        count=_p("int", 3, 1, 30), span=_p("num", 4, 2, 10, "m, centre to centre"), pier=_p("num", 1, 1, 3, "m"),
        height=_p("num", 4, 2, 10, "m to the crown"), depth=_p("num", 3, 1, 12, "m"), facing=FACING)),
}
COMMON = ("part", "at", "repeat", "note")


def validate(p, where, Invalid):
    import landmarks
    import re
    if not isinstance(p, dict) or p.get("part") not in PARTS:
        raise Invalid(f"{where}.part: one of {sorted(PARTS)}, got {p.get('part') if isinstance(p, dict) else p!r}")
    spec = PARTS[p["part"]]["params"]
    bad = sorted(set(p) - set(spec) - set(COMMON))
    if bad:
        raise Invalid(f"{where}: unknown key(s) {bad} for part {p['part']} (its parameters: {sorted(spec)})")
    at = p.get("at", "centre")
    ok = at in ("centre", "highest") or (isinstance(at, list) and len(at) == 2 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in at)) or (
        isinstance(at, dict) and set(at) == {"u", "v"} and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in at.values()))
    if not ok:
        raise Invalid(f"{where}.at: \"centre\", \"highest\", [x, y] (EPSG:25832) or {{\"u\": 0..1, \"v\": 0..1}}, got {at!r}")
    if isinstance(at, list) and not (500000 < at[0] < 1000000 and 5000000 < at[1] < 6000000):
        raise Invalid(f"{where}.at: {at} is no EPSG:25832 easting/northing")
    if "repeat" in p:
        rp = p["repeat"]
        if not (isinstance(rp, dict) and set(rp) == {"count", "step"} and isinstance(rp["count"], int) and 1 <= rp["count"] <= 40
                and isinstance(rp["step"], list) and len(rp["step"]) == 2 and all(isinstance(v, (int, float)) for v in rp["step"])):
            raise Invalid(f"{where}.repeat: {{\"count\": 1..40, \"step\": [dx east, dy north] in m}}")
    for k, v in p.items():
        if k in COMMON:
            continue
        s = spec[k]
        kind, w = s["kind"], f"{where}.{k}"
        if kind in ("num", "int"):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or (kind == "int" and not isinstance(v, int)):
                raise Invalid(f"{w}: a {'whole ' if kind == 'int' else ''}number")
            if (s["lo"] is not None and v < s["lo"]) or (s["hi"] is not None and v > s["hi"]):
                raise Invalid(f"{w}: {v} out of range [{s['lo']}, {s['hi']}]")
        elif kind == "colour":
            if not (isinstance(v, str) and re.match(r"^#[0-9a-fA-F]{6}$", v)):
                raise Invalid(f"{w}: a colour '#rrggbb'")
        elif kind == "material":
            if v not in landmarks.MAT_IDS:
                raise Invalid(f"{w}: unknown material {v!r} (one of {', '.join(landmarks.MAT_IDS)})")
        elif kind == "bool":
            if not isinstance(v, bool):
                raise Invalid(f"{w}: true or false")
        elif kind == "facing":
            if not (v in ("auto", "n", "e", "s", "w") or (isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 360)):
                raise Invalid(f"{w}: auto, n, e, s, w or a bearing in degrees")
        elif kind.startswith("enum:"):
            if v not in kind[5:].split(","):
                raise Invalid(f"{w}: one of {kind[5:]}")
    if p["part"] == "bay_window" and p.get("to", 9) <= p.get("from", 3):
        raise Invalid(f"{where}: `to` must be above `from`")


def with_defaults(p):
    out = {k: s["default"] for k, s in PARTS[p["part"]]["params"].items()}
    out.update(p)
    return out


def place(ctx, p, to_grid):
    """the points (y, x: region cells, floats) a part spec stands at"""
    at = p.get("at", "centre")
    if at == "centre":
        u, v, hu, hv, ax, perp, ctr = frame(ctx.rr, ctx.cc, ctx.R0, ctx.C0)
        x, y = ctr[0] - ctx.C0, ctr[1] - ctx.R0
    elif at == "highest":
        tops = np.array([ctx.top(r, c) for r, c in zip(ctx.rr, ctx.cc)])
        k = int(np.argmax(tops))
        y, x = ctx.rr[k] + 0.5, ctx.cc[k] + 0.5
    elif isinstance(at, list):
        x, y = (float(v) for v in to_grid(at[0], at[1]))
    else:
        u, v, hu, hv, ax, perp, ctr = frame(ctx.rr, ctx.cc, ctx.R0, ctx.C0)
        q = ctr + (at["u"] - 0.5) * 2 * hu * ax + (at["v"] - 0.5) * 2 * hv * perp
        x, y = q[0] - ctx.C0, q[1] - ctx.R0
    rp = p.get("repeat") or {"count": 1, "step": [0, 0]}
    return [(y - k * rp["step"][1], x + k * rp["step"][0]) for k in range(rp["count"])]


def build(ctx, p, to_grid):
    q = with_defaults(p)
    fn = PARTS[q["part"]]["fn"]
    return sum(fn(ctx, y, x, q) for y, x in place(ctx, q, to_grid))


def doc():
    lines = []
    for name, d in PARTS.items():
        lines.append(f"{name}: {' '.join(d['fn'].__doc__.split())}")
        for k, s in d["params"].items():
            rng = f" [{s['lo']}, {s['hi']}]" if s["lo"] is not None else ""
            lines.append(f"    {k}: {s['kind']}{rng}, default {s['default']!r}" + (f" ({s['doc']})" if s["doc"] else ""))
    return "\n".join(lines)


if __name__ == "__main__":
    print(__doc__)
    print(doc())
