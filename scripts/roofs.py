"""Buildings by rule (the map config's `roofs`: `{"rules": true, "look": "slopes" | "steps"}`, off when absent): the
surveyed houses are restless less from noise than from their architecture -- dormers, chimneys, half-hips, planes a
metre apart, outlines with every dent of the cadastre -- each rounded to the 1 m grid on its own. Decided per building
from its tags, footprint and survey alone:

- a landmark (a church, a castle and what stands in its grounds, a tower, a curated building, one drawn by its OSM
  parts, a dome or a cone) keeps its outline and roof as surveyed;
- any other building whose outline one or two rectangles cover well (in its own axes: an L or a T is two) is drawn as
  those rectangles, with straight walls, and gets a roof of one type: flat (a parapet round a hall's or a large one's),
  shed, gable, hip or mansard, from LoD2's roof type, its size and its use, each rectangle from its own surveyed eaves
  to its ridge;
- the rest keeps its surveyed roof, tidied: the LoD2 planes over all of it, a plane patch of a few cells (a dormer, a
  cheek) continued from the plane beside it, flat decks within 1.2 m of a larger one on its level, single cells standing
  out of or sunk into their four neighbours put level with them.

Two looks of the same roofs: "slopes" (the voxels the planes rounded, the roof caps draw exactly the planes) and
"steps" (even voxel steps, a whole metre every 1-4 cells or 1-3 m a cell, no plane: no caps, the voxels lit as voxels).
Never smoothed: every cell holds a plane's height or a level."""
import numpy as np
from scipy import ndimage

SACRED = {"cathedral", "church", "chapel", "basilica", "synagogue", "mosque", "temple", "shrine", "monastery"}
LANDMARK_BUILDINGS = SACRED | {"castle", "fortress", "palace", "tower", "bell_tower", "gatehouse", "city_gate", "ruins"}
LANDMARK_HISTORIC = {"castle", "fort", "fortress", "church", "chapel", "monastery", "tower", "city_gate", "citywalls",
                     "ruins", "palace", "manor", "monument"}
LANDMARK_MAN_MADE = {"tower", "water_tower", "chimney", "lighthouse", "observatory", "bell_tower"}
SITE_HISTORIC = {"castle", "fort", "fortress", "monastery"}
# a hall: its flat roof keeps a parapet (supermarkets, stores, works: seen from the air)
HALL_BUILDINGS = {"retail", "supermarket", "commercial", "industrial", "warehouse", "hangar", "manufacture",
                  "service", "sports_hall", "storage_tank"}
# LoD2's roofType (AdV): the rule's type; None: domes, cones, arches and towers' roofs stay as surveyed; "data": a mixed
# or unknown form, decided by the survey's slopes
TYPES = {1000: "flat", 2100: "shed", 2200: "gable", 3100: "gable", 3200: "hip", 3300: "hip", 3400: "mansard",
         3500: "hip", 3600: None, 3700: None, 3800: "flat", 3900: None, 4000: None, 5000: "data", 9999: "data", 0: "data"}
COVER = 0.85  # of the outline (in its own axes, dents closed) its one or two rectangles cover at least
SECOND = 0.12  # a second rectangle's share of the outline, at least (less: a bump, dropped)
FLAT_RISE = 1.5  # m from eaves to ridge under which a rectangle's roof is flat
HALL_AREA = 600  # cells: a flat roof this large has a parapet whatever its use
STEPS = ((1, 4), (1, 3), (1, 2), (1, 1), (2, 1), (3, 1))  # (rise m, run cells) of an even step
MANSARD = (0.35, 2.0)  # a mansard's steep lower part: its share of the half-width and its rise per metre
PATCH = 10  # cells: a plane patch of fewer is a dormer or a cheek
LEVEL_SNAP = 1.2  # m: flat decks this close to a larger one's level take it
TALL = (30.0, 600)  # m over the ground and cells under which a building is a tower


def config():
    import aoi
    return aoi.CONFIG.get("roofs", {})


def enabled():
    return bool(config().get("rules", False))


def look():
    return config().get("look", "slopes")


def sites_of(osm_areas):
    from shapely.strtree import STRtree
    return STRtree([g for _, _, t, g in osm_areas if (t.get("historic") in SITE_HISTORIC or t.get("amenity") ==
                    "place_of_worship" or t.get("landuse") == "religious") and g.geom_type in ("Polygon", "MultiPolygon")])


def _get(f, k):
    v = f["tags"].get(k)
    return v if v is not None or f.get("parent") is None else f["parent"]["tags"].get(k)


def landmark(f, sites, labels, own):
    if f["part"] or f.get("has_parts") or own(f):
        return True
    if (_get(f, "building") in LANDMARK_BUILDINGS or _get(f, "amenity") == "place_of_worship"
            or _get(f, "historic") in LANDMARK_HISTORIC or _get(f, "man_made") in LANDMARK_MAN_MADE
            or _get(f, "tower:type") or _get(f, "name") in labels):
        return True
    return len(sites.query(f["geom"].representative_point(), predicate="within")) > 0


def _code(lod2, rr, cc):
    if lod2 is None:
        return 0
    rt = lod2["rtype"][rr, cc]
    rt = rt[rt > 0]
    if not len(rt):
        return 0
    vals, n = np.unique(rt, return_counts=True)
    return int(vals[np.argmax(n)])


def _box(rr, cc, pad=1):
    r0, c0 = rr.min() - pad, cc.min() - pad
    m = np.zeros((rr.max() - r0 + 1 + pad, cc.max() - c0 + 1 + pad), bool)
    m[rr - r0, cc - c0] = True
    return m, r0, c0


def _largest_rect(M):
    """the largest all-True rectangle of M: (row0, row1, col0, col1), half-open; None if M is empty"""
    H, Wd = M.shape
    h = np.zeros(Wd, np.int64)
    best, out = 0, None
    for r in range(H):
        h = np.where(M[r], h + 1, 0)
        st = []
        for c in range(Wd + 1):
            cur = h[c] if c < Wd else 0
            start = c
            while st and st[-1][1] >= cur:
                s, hh = st.pop()
                if hh * (c - s) > best:
                    best, out = hh * (c - s), (r - hh + 1, r + 1, s, c)
                start = s
            st.append((start, cur))
    return out


class Frame:
    """a building's own axes on the project grid: ax along the longer side of its outline's smallest rectangle
    (rounded, so every region computes the same cells), perp across; u, v of a cell's centre from an integer origin"""

    def __init__(self, f, R0, C0):
        ring = np.asarray(f["geom"].minimum_rotated_rectangle.exterior.coords)[:4]
        e = [ring[1] - ring[0], ring[2] - ring[1]]
        a = max(e, key=lambda v: np.hypot(*v))
        a = a / np.hypot(*a)
        if a[0] < -1e-9 or (abs(a[0]) <= 1e-9 and a[1] < 0):
            a = -a
        a = np.round(a, 6)
        self.ax = a / np.hypot(*a)
        self.perp = np.array([-self.ax[1], self.ax[0]])
        self.R0, self.C0 = R0, C0
        self.o = (int(f["cc"].min()) + C0, int(f["rr"].min()) + R0)

    def uv(self, rr, cc):
        x, y = cc + self.C0 + 0.5 - self.o[0], rr + self.R0 + 0.5 - self.o[1]
        return x * self.ax[0] + y * self.ax[1], x * self.perp[0] + y * self.perp[1]


def rectangles(f, R0, C0):
    """(frame, [(u0, u1, v0, v1)]): the one or two rectangles (whole frame cells) that cover the outline, or None"""
    import rasterio.features
    from affine import Affine
    from shapely import affinity
    fr = Frame(f, R0, C0)
    # the outline itself in the frame, rasterized on its whole metres (the cells' centres turned into the frame leave
    # holes and ragged edges on its grid)
    a, b = fr.ax, fr.perp
    g = affinity.affine_transform(f["geom"], [a[0], a[1], b[0], b[1], (C0 - fr.o[0]) * a[0] + (R0 - fr.o[1]) * a[1],
                                              (C0 - fr.o[0]) * b[0] + (R0 - fr.o[1]) * b[1]])
    minx, miny, maxx, maxy = g.bounds
    u0, v0 = int(np.floor(minx)) - 1, int(np.floor(miny)) - 1
    shp = (int(np.ceil(maxy)) - v0 + 2, int(np.ceil(maxx)) - u0 + 2)
    M = rasterio.features.rasterize([(g, 1)], out_shape=shp, transform=Affine.translation(u0, v0), dtype=np.uint8) > 0
    if not M.any():
        return None
    # (a dent of a metre: closed)
    M = ndimage.binary_fill_holes(ndimage.binary_closing(M, np.ones((3, 3), bool)) | M)
    n = int(M.sum())
    r1 = _largest_rect(M)
    if r1 is None:
        return None
    rects = [r1]
    rem = M.copy()
    rem[r1[0]:r1[1], r1[2]:r1[3]] = False
    r2 = _largest_rect(rem)
    if r2 is not None:
        a2 = (r2[1] - r2[0]) * (r2[3] - r2[2])
        touch = r2[0] <= r1[1] and r1[0] <= r2[1] and r2[2] <= r1[3] and r1[2] <= r2[3]
        if a2 >= max(12, SECOND * n) and touch and min(r2[1] - r2[0], r2[3] - r2[2]) >= 3:
            rects.append(r2)
    cov = sum((r[1] - r[0]) * (r[3] - r[2]) for r in rects) / n
    if cov < COVER or min(r1[1] - r1[0], r1[3] - r1[2]) < 3:
        return None
    return fr, [(r[2] + u0, r[3] + u0, r[0] + v0, r[1] + v0) for r in rects]


def _inside(fr, rects, rr, cc):
    u, v = fr.uv(rr, cc)
    iu, iv = np.floor(u), np.floor(v)
    return np.stack([(iu >= a) & (iu < b) & (iv >= c) & (iv < d) for a, b, c, d in rects])


def simplify_outlines(render, street, nd_max_b, lod2, sites, labels, own, R0, C0, core, note, report):
    """the outlines of the buildings the rule takes, straightened to their rectangles in place (f rr, cc; f["rule"] =
    (frame, rectangles)): a cell gained only where no other building and no street is, a cell lost only where no other
    building is beside it (a party wall stays where it is)"""
    D, W = street.shape
    owner = np.zeros((D, W), np.int32)
    for i, f in enumerate(render, 1):
        owner[f["rr"], f["cc"]] = np.where(owner[f["rr"], f["cc"]] == 0, i, owner[f["rr"], f["cc"]])
    n_s = n_add = n_drop = 0
    skip = {}
    for i, f in sorted(enumerate(render, 1), key=lambda t: (-len(t[1]["rr"]), t[1]["id"])):
        rr, cc = f["rr"], f["cc"]
        incore = core[0].start <= int(np.median(rr)) < core[0].stop and core[1].start <= int(np.median(cc)) < core[1].stop
        why = None
        if len(rr) < 12 or f["part"] or f["tags"].get("building") in ("roof", "carport", "canopy") or (f["minh"] or 0) >= 2:
            why = "small or on posts"
        elif landmark(f, sites, labels, own) or TYPES.get(_code(lod2, rr, cc), "data") is None \
                or (np.percentile(nd_max_b[rr, cc], 95) >= TALL[0] and len(rr) < TALL[1]):
            why = "landmark"
        got = rectangles(f, R0, C0) if why is None else None
        if got is None:
            if incore:
                skip[why or "no rectangles"] = skip.get(why or "no rectangles", 0) + 1
            continue
        fr, rects = got
        r0, r1, c0, c1 = max(rr.min() - 3, 0), min(rr.max() + 4, D), max(cc.min() - 3, 0), min(cc.max() + 4, W)
        br, bc = np.mgrid[r0:r1, c0:c1]
        br, bc = br.ravel(), bc.ravel()
        inn = _inside(fr, rects, br, bc).any(0)
        mine = owner[br, bc] == i
        free = (owner[br, bc] == 0) & (street[br, bc] == 0)
        other = (owner > 0) & (owner != i)
        nb_other = np.zeros(len(br), bool)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            r_, c_ = np.clip(br + dy, 0, D - 1), np.clip(bc + dx, 0, W - 1)
            nb_other |= other[r_, c_]
        keep = (inn & (mine | free)) | (mine & ~inn & nb_other)
        add, drop = keep & ~mine, mine & ~keep
        owner[br[add], bc[add]] = i
        owner[br[drop], bc[drop]] = 0
        f["rr"], f["cc"] = br[keep], bc[keep]
        f["rule"] = (fr, rects)
        if incore:
            n_s += 1
            n_add += int(add.sum())
            n_drop += int(drop.sum())
    report["counters"]["roof_rules_outlines"] = dict(buildings=n_s, cells_added=n_add, cells_dropped=n_drop, kept=skip)
    note(f"outlines straightened to their rectangles (in the core): {n_s} buildings, +{n_add} / -{n_drop} cells; kept:",
         skip)


def _rect_type(lod2, rr, cc, fr, code):
    """(type, the ridge runs along u, a shed's rising side) of one rectangle from the survey's planes over it: which of
    the four ways (along its axes) they fall, on an eighth of its cells or more. LoD2's roofType alone misleads: most
    of Haidenhof's gables are typed 2100 (shed)"""
    t0 = TYPES.get(code, "data")
    if t0 == "flat" or lod2 is None:
        return "flat", True, 1.0
    gx, gy, sl = lod2["gx"][rr, cc], lod2["gy"][rr, cc], lod2["slope"][rr, cc]
    k = np.isfinite(sl) & (sl >= 0.1)
    if k.sum() < 0.3 * len(rr):
        return "flat", True, 1.0
    gu = gx[k] * fr.ax[0] + gy[k] * fr.ax[1]
    gv = gx[k] * fr.perp[0] + gy[k] * fr.perp[1]
    g = np.hypot(gu, gv)
    share = {d: float(np.mean(x > 0.5 * g)) for d, x in (("+u", gu), ("-u", -gu), ("+v", gv), ("-v", -gv))}
    on = {d for d, x in share.items() if x >= 0.12}
    if on <= {"+v", "-v"} and len(on) == 2:
        t, along_u, rising = "gable", True, 1.0
    elif on <= {"+u", "-u"} and len(on) == 2:
        t, along_u, rising = "gable", False, 1.0
    elif len(on) == 1:
        d = next(iter(on))
        t, along_u, rising = "shed", d[1] == "v", 1.0 if d[0] == "+" else -1.0
    else:
        t, along_u, rising = "hip", None, 1.0
    if t0 == "mansard" and t in ("gable", "hip"):
        t = "mansard"
    return t, along_u, rising


def _rect_roof(t, du, dv, hu, hv, along_u, rising, E, ridge, steps, BASE):
    """heights (plane, voxels) and the plane's gradient in the frame (dh/du, dh/dv) of one rectangle's roof at its
    cells (du, dv from its middle); along_u: the ridge runs along u; rising: a shed's high side (+1: +v)"""
    if not along_u:
        du, dv, hu, hv = dv, du, hv, hu
    fu, fv = hu - np.abs(du), hv - np.abs(dv)
    sv = np.where(dv >= 0, 1.0, -1.0)
    su = np.where(du >= 0, 1.0, -1.0)
    if t == "shed":
        d = np.maximum(rising * dv + hv - 0.5, 0)
        gd = (np.zeros_like(d), np.full_like(d, rising))
    elif t in ("hip", "mansard"):
        across = fv <= fu
        d = np.maximum(np.minimum(fu, fv) - 0.5, 0)
        gd = (np.where(across, 0.0, -su), np.where(across, -sv, 0.0))
    else:
        d = np.maximum(fv - 0.5, 0)
        gd = (np.zeros_like(d), -sv)
    dmax = float(d.max())
    rise_ = ridge - E
    if t == "mansard":
        dm = max(1.0, round(MANSARD[0] * dmax))
        k1 = MANSARD[1]
        k2 = max((rise_ - k1 * dm) / max(dmax - dm, 1), 0.2)
        plane = E + k1 * np.minimum(d, dm) + k2 * np.maximum(d - dm, 0)
        kk = np.where(d < dm, k1, k2)
        lo = np.minimum(d, dm)
        vox = E + np.floor(k1 * lo + 1e-6) + np.floor(np.maximum(d - dm, 0) * k2 + 1e-6)
    else:
        rs, run = min(STEPS, key=lambda s: (abs(s[0] * np.floor(dmax / s[1] + 1e-6) - rise_), s[0], -s[1]))
        kk = np.full_like(d, rs / run)
        plane = E + kk * d
        vox = E + rs * np.floor(d / run + 1e-6)
    gu, gv = gd[0] * kk, gd[1] * kk
    if not along_u:
        gu, gv = gv, gu
    # (the slopes' voxels: the plane rounded as the roof caps round it, so they draw it unmoved)
    return plane, (BASE + np.round(plane - BASE) if not steps else vox), gu, gv


def apply(render, top, dtm, BASE, lod2, lod2_use, cell_maxh, gxa, gya, pitched, R0, C0, sites, labels, own, core,
          note, report):
    """the roofs over every rendered building (top: heights over the terrain, written in place; gxa, gya, pitched as
    voxelize.py keeps them; core: the region's core (row slice, column slice), where buildings are counted). Returns
    the rule roofs' plane (a.s.l., NaN elsewhere: the roof caps' heights), and their cells"""
    D, W = top.shape
    steps = look() == "steps"
    plane = np.full((D, W), np.nan, np.float32)
    ruled = np.zeros((D, W), bool)
    count = dict(landmark=0, flat=0, flat_parapet=0, shed=0, gable=0, hip=0, mansard=0, two_rectangles=0, tidied=0,
                 other=0)

    def tally(f, what, n=1):
        r, c = int(np.median(f["rr"])), int(np.median(f["cc"]))
        if core[0].start <= r < core[0].stop and core[1].start <= c < core[1].stop:
            count[what] += n

    for f in render:
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 4 or f["tags"].get("building") in ("roof", "carport", "canopy") or (f["minh"] or 0) >= 2 \
                or f.get("pit"):
            tally(f, "other")
            continue
        if "rule" not in f:
            if landmark(f, sites, labels, own) or (np.percentile(top[rr, cc], 95) >= TALL[0] and len(rr) < TALL[1]) \
                    or TYPES.get(_code(lod2, rr, cc), "data") is None:
                tally(f, "landmark")
            else:
                tally(f, "tidied")
                _tidy(rr, cc, top, dtm, lod2, lod2_use, cell_maxh, gxa, gya, R0, C0)
            continue
        fr, rects = f["rule"]
        zabs = top[rr, cc].astype(np.float64) + dtm[rr, cc]
        ground = float(np.median(dtm[rr, cc]))
        code = _code(lod2, rr, cc)
        parapet = _get(f, "building") in HALL_BUILDINGS or _get(f, "shop") is not None or len(rr) >= HALL_AREA
        ins = _inside(fr, rects, rr, cc)
        u, v = fr.uv(rr, cc)
        best = np.full(len(rr), -np.inf)
        pl, gx, gy, vx = (np.zeros(len(rr)) for _ in range(4))
        types = []
        for j, (a, b, c, d) in enumerate(rects):
            m = ins[j]
            if not m.any():
                continue
            hu, hv = (b - a) / 2, (d - c) / 2
            du, dv = u - (a + b) / 2, v - (c + d) / 2
            zr = zabs[m]
            t, along_u, rising = _rect_type(lod2, rr[m], cc[m], fr, code)
            if along_u is None:
                along_u = hu >= hv
            # eaves: the rectangle's outer cells (a shed's low side), ridge: its 95th percentile
            fu_, fv_ = hu - np.abs(du[m]), hv - np.abs(dv[m])
            edge = (fv_ if along_u else fu_) < 1 if t not in ("hip", "mansard") else np.minimum(fu_, fv_) < 1
            if t == "shed":
                side = (rising * dv[m] if along_u else rising * du[m]) < 0
                edge &= side
            eaves = float(np.median(zr[edge])) if edge.any() else float(np.percentile(zr, 10))
            ridge = float(np.percentile(zr, 95))
            E = round(max(eaves, ground + 2))
            if t == "flat" or ridge - E < FLAT_RISE:
                t = "flat"
                lvl = round(max(float(np.median(zr)), ground + 2))
                p_, v_, gu, gv = np.full(m.sum(), float(lvl)), np.full(m.sum(), float(lvl)), np.zeros(m.sum()), np.zeros(m.sum())
            else:
                p_, v_, gu, gv = _rect_roof(t, du[m], dv[m], hu, hv, along_u, rising, E, ridge, steps, BASE)
            types.append((int(m.sum()), t))
            w = v_ > best[m]
            idx = np.flatnonzero(m)[w]
            best[idx] = v_[w]
            pl[idx], vx[idx] = p_[w], v_[w]
            gx[idx] = gu[w] * fr.ax[0] + gv[w] * fr.perp[0]
            gy[idx] = gu[w] * fr.ax[1] + gv[w] * fr.perp[1]
        lost = ~np.isfinite(best)
        if lost.any():
            k = np.flatnonzero(~lost)
            dd = (rr[lost, None] - rr[None, k]) ** 2 + (cc[lost, None] - cc[None, k]) ** 2
            near = k[np.argmin(dd, 1)]
            pl[lost], vx[lost], gx[lost], gy[lost] = pl[near], vx[near], gx[near], gy[near]
        t = max(types)[1] if types else "flat"
        flat = all(t_ == "flat" for _, t_ in types)
        parapet &= flat
        if parapet:
            m_, r0, c0 = _box(rr, cc, 1)
            rim = (ndimage.binary_dilation(~m_) & m_)[rr - r0, cc - c0]
            vx = np.where(rim, vx + 1, vx)
            pl = np.where(rim, pl + 1, pl)
        top[rr, cc] = vx - dtm[rr, cc]
        plane[rr, cc] = pl
        ruled[rr, cc] = True
        if steps:
            gxa[rr, cc] = gya[rr, cc] = np.nan
        else:
            gxa[rr, cc], gya[rr, cc] = gx, gy
        pitched[rr, cc] = np.hypot(gx, gy) >= 0.3
        tally(f, ("flat_parapet" if parapet else "flat") if flat else t)
        if len(rects) == 2:
            tally(f, "two_rectangles")
    report["counters"]["roof_rules"] = count
    note("roofs by rule (buildings in the core):", count)
    return plane, ruled


def _tidy(rr, cc, top, dtm, lod2, lod2_use, cell_maxh, gxa, gya, R0, C0):
    """the survey's roof of one building tidied in place"""
    if lod2 is not None and lod2_use[rr, cc].mean() >= 0.5:  # (one the two disagree on, rebuilt since: as it is)
        lz = lod2["z"][rr, cc]
        have = np.isfinite(lz)
        # LoD2's planes over all of it: what stood off them (a pillar of the surface model 30 cells and more, a patch
        # it disagreed on) is noise of the image matching -- unless OSM maps that part taller
        tall = np.nan_to_num(cell_maxh[rr, cc]) > lz - dtm[rr, cc] + 4
        k = have & ~lod2_use[rr, cc] & ~tall
        top[rr[k], cc[k]] = lz[k] - dtm[rr[k], cc[k]]
        gxa[rr[k], cc[k]], gya[rr[k], cc[k]] = lod2["gx"][rr[k], cc[k]], lod2["gy"][rr[k], cc[k]]
        _patches(rr[have], cc[have], top, dtm, lod2, gxa, gya, R0, C0)
    _speckle(rr, cc, top, dtm)


def _patches(rr, cc, top, dtm, lod2, gxa, gya, R0, C0):
    """small plane patches continued from the plane beside them, flat decks snapped to a larger one's level"""
    gx, gy = lod2["gx"][rr, cc], lod2["gy"][rr, cc]
    z = top[rr, cc].astype(np.float64) + dtm[rr, cc]
    a = z - gx * (cc + C0) - gy * (rr + R0)  # the plane's height at the project grid's origin (every region's the same)
    # (planes of one gradient at different heights are different patches: the intercept is part of the key)
    key = np.stack([np.round(gx * 20), np.round(gy * 20), np.round(a * 2)], 1)
    _, kid = np.unique(key, axis=0, return_inverse=True)
    kid = kid.ravel()
    m, r0, c0 = _box(rr, cc, 1)
    lab = np.zeros(m.shape, np.int32)
    nlab = 0
    for i in range(kid.max() + 1):
        s = kid == i
        b = np.zeros(m.shape, bool)
        b[rr[s] - r0, cc[s] - c0] = True
        L, n = ndimage.label(b)
        lab[b] = L[b] + nlab
        nlab += n
    if nlab < 2:
        return
    li = lab[rr - r0, cc - c0]
    size = np.bincount(li, minlength=nlab + 1)
    pg = np.zeros((nlab + 1, 3))
    for j in range(1, nlab + 1):
        s = li == j
        pg[j] = np.median(gx[s]), np.median(gy[s]), np.median(a[s])
    for j in np.argsort(size, kind="stable"):
        if j == 0 or size[j] >= PATCH:
            continue
        own = lab == j
        ring = ndimage.binary_dilation(own) & ~own & (lab > 0)
        nb = lab[ring]
        nb = nb[(nb != j) & (size[nb] >= PATCH)]
        if not len(nb):
            continue
        t = np.bincount(nb).argmax()
        s = li == j
        r_, c_ = rr[s], cc[s]
        zt = pg[t, 2] + pg[t, 0] * (c_ + C0) + pg[t, 1] * (r_ + R0)
        if np.abs(zt - z[s]).max() > 3:
            continue
        top[r_, c_] = zt - dtm[r_, c_]
        gxa[r_, c_], gya[r_, c_] = pg[t, 0], pg[t, 1]
        lab[own] = t
        li[s] = t
        size[t] += size[j]
        size[j] = 0
    flat = [j for j in range(1, nlab + 1) if size[j] and np.hypot(pg[j, 0], pg[j, 1]) < 0.08]
    kept = []
    for j in sorted(flat, key=lambda j: (-size[j], j)):
        s = li == j
        lv = float(np.median(top[rr[s], cc[s]] + dtm[rr[s], cc[s]]))
        near = [k for k in kept if abs(k - lv) <= LEVEL_SNAP]
        if near:
            top[rr[s], cc[s]] = near[0] - dtm[rr[s], cc[s]]
        else:
            kept.append(lv)


def _speckle(rr, cc, top, dtm):
    """a cell a whole metre over (or under) all four neighbours of its building that agree among themselves: level
    with them"""
    m, r0, c0 = _box(rr, cc, 1)
    h = np.full(m.shape, np.nan)
    h[rr - r0, cc - c0] = np.round(top[rr, cc] + dtm[rr, cc])
    nb = np.stack([np.roll(h, s, a) for a in (0, 1) for s in (-1, 1)])
    ok = np.isfinite(nb).all(0) & m
    lo, hi = np.nanmin(nb, 0), np.nanmax(nb, 0)
    spike = ok & (hi - lo <= 1) & ((h - hi >= 1) | (lo - h >= 1))
    ir, ic = np.nonzero(spike)
    if len(ir):
        med = np.median(nb[:, ir, ic], 0)
        top[ir + r0, ic + c0] = med - dtm[ir + r0, ic + c0]
