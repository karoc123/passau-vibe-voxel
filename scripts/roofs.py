"""Roofs by rule (scripts/map.json `roofs.rules`, off by default): the surveyed roofs of ordinary houses are restless
less from noise than from their architecture -- dormers, cheeks, chimneys, half-hips and planes a metre apart, each
rounded to the 1 m grid on its own. Three classes, decided per building from its tags, footprint and survey alone:

- a landmark (a church, a castle and what stands in its grounds, a tower, a curated building, one drawn by its OSM
  parts) keeps its roof as it is;
- a small, simple house (not in a terrace) gets a roof made by rule: gable, hip or flat as LoD2 types it, the ridge
  along the axis the survey's slopes say (else the long side), from its surveyed eaves to its ridge in even steps (a
  whole metre up every 1-4 cells, or 1-3 m every cell); an L or a T a hip all round its outline;
- any other building keeps its surveyed roof, tidied: the LoD2 planes over all of it, a plane patch of a few cells
  (a dormer, a cheek) continued from the plane beside it, flat decks within 1.2 m of a larger one on its level, and
  single cells standing out of or sunk into their four neighbours put level with them.

Never smoothed: every cell keeps a height of a plane or a level."""
import numpy as np
from scipy import ndimage

from parts import frame

SACRED = {"cathedral", "church", "chapel", "basilica", "synagogue", "mosque", "temple", "shrine", "monastery"}
LANDMARK_BUILDINGS = SACRED | {"castle", "fortress", "palace", "tower", "bell_tower", "gatehouse", "city_gate", "ruins"}
LANDMARK_HISTORIC = {"castle", "fort", "fortress", "church", "chapel", "monastery", "tower", "city_gate", "citywalls",
                     "ruins", "palace", "manor", "monument"}
LANDMARK_MAN_MADE = {"tower", "water_tower", "chimney", "lighthouse", "observatory", "bell_tower"}
SITE_HISTORIC = {"castle", "fort", "fortress", "monastery"}
# LoD2's roofType (AdV): the rule's shape, or None (domes, cones, sheds and mixed forms keep the tidied survey)
RULE_SHAPE = {0: None, 1000: "flat", 2100: "gable", 2200: "gable", 3100: "gable", 3200: "hip", 3300: "hip",
              3400: "gable", 3500: "hip"}
SMALL = (20, 350)  # cells of a house the rule takes
FILL = 0.85  # of its smallest rectangle a house covers at least for a gable or hip along its axes
FILL_ANY = 0.55  # ... for a hip all round its outline (an L, a T); less: no rule roof
PARTY = 0.25  # of its outline's neighbours that are other buildings, at most (a terrace keeps its survey, tidied)
FLAT_RISE = 1.5  # m from eaves to ridge under which a roof is flat
STEPS = ((1, 4), (1, 3), (1, 2), (1, 1), (2, 1), (3, 1))  # (rise m, run cells) of an even step
PATCH = 10  # cells: a plane patch of fewer is a dormer or a cheek
LEVEL_SNAP = 1.2  # m: flat decks this close to a larger one's level take it
TALL = (30.0, 600)  # m over the ground and cells under which a building is a tower


def enabled():
    import aoi
    return bool(aoi.CONFIG.get("roofs", {}).get("rules", False))


def _landmark(f, sites, labels, own):
    t = f["tags"]
    p = f.get("parent")
    get = lambda k: t.get(k) if t.get(k) is not None or p is None else p["tags"].get(k)
    if f["part"] or f.get("has_parts") or own(f):
        return True
    if (get("building") in LANDMARK_BUILDINGS or get("amenity") == "place_of_worship"
            or get("historic") in LANDMARK_HISTORIC or get("man_made") in LANDMARK_MAN_MADE or get("tower:type")
            or get("name") in labels):
        return True
    rp = f["geom"].representative_point()
    return len(sites.query(rp, predicate="within")) > 0


def _box(rr, cc, pad=1):
    r0, c0 = rr.min() - pad, cc.min() - pad
    m = np.zeros((rr.max() - r0 + 1 + pad, cc.max() - c0 + 1 + pad), bool)
    m[rr - r0, cc - c0] = True
    return m, r0, c0


def _party(rr, cc, bmask, D, W):
    """the share of the footprint's outside neighbours that are other buildings' cells"""
    m, r0, c0 = _box(rr, cc, 1)
    ring = ndimage.binary_dilation(m) & ~m
    ir, ic = np.nonzero(ring)
    ir, ic = ir + r0, ic + c0
    ok = (ir >= 0) & (ir < D) & (ic >= 0) & (ic < W)
    if not ok.any():
        return 1.0
    return float(bmask[ir[ok], ic[ok]].mean())


def _rule(f, rr, cc, top, dtm, lod2, R0, C0):
    """(shape, heights a.s.l. stepped, the plane they step along a.s.l., gx, gy, its slope) of a house's rule roof, or
    why it takes none"""
    zabs = top[rr, cc].astype(np.float64) + dtm[rr, cc]
    ground = float(np.median(dtm[rr, cc]))
    shape = "gable"
    sl = None
    if lod2 is not None:
        rt = lod2["rtype"][rr, cc]
        rt = rt[rt > 0]
        if len(rt):
            vals, n = np.unique(rt, return_counts=True)
            code = int(vals[np.argmax(n)])
            if code not in RULE_SHAPE or RULE_SHAPE[code] is None:
                return "type"
            shape = RULE_SHAPE[code]
        sl = (lod2["gx"][rr, cc], lod2["gy"][rr, cc], lod2["slope"][rr, cc])
    if shape == "flat" or np.percentile(zabs, 95) - np.percentile(zabs, 10) < FLAT_RISE:
        h = np.full(len(rr), round(max(float(np.median(zabs)), ground + 2)), np.float64)
        return "flat", h, h, np.zeros(len(rr)), np.zeros(len(rr)), 0.0
    u, v, hu, hv, ax, perp, _ = frame(rr, cc, R0, C0, "long")
    g = f["geom"]
    fill = g.area / max(g.minimum_rotated_rectangle.area, 1e-6)
    if fill < FILL_ANY:
        return "shape"
    if fill < FILL:
        shape = "hip_any"  # (an L or a T: eaves all round, rising with the distance from the outline)
    if sl is not None:
        # the ridge across the slopes the survey has: falling mostly along the long axis, the ridge runs the short way
        k = np.isfinite(sl[2]) & (sl[2] >= 0.3)
        if k.sum() >= 0.3 * len(rr):
            along = np.abs(sl[0][k] * ax[0] + sl[1][k] * ax[1]).sum()
            across = np.abs(sl[0][k] * perp[0] + sl[1][k] * perp[1]).sum()
            if along > across:
                u, v, hu, hv, ax, perp, _ = frame(rr, cc, R0, C0, "short")
    fu, fv = hu - np.abs(u), hv - np.abs(v)
    if shape == "hip_any":
        m, r0, c0 = _box(rr, cc, 1)
        dist, (ir, ic) = ndimage.distance_transform_edt(m, return_indices=True)
        d = np.maximum(dist[rr - r0, cc - c0] - 1, 0)
        oy, ox = (rr - r0) - ir[rr - r0, cc - c0], (cc - c0) - ic[rr - r0, cc - c0]
    else:
        d = np.maximum((np.minimum(fu, fv) if shape == "hip" else fv) - 0.5, 0)
    edge = d < 1
    eaves = float(np.median(zabs[edge])) if edge.any() else float(np.percentile(zabs, 10))
    ridge = float(np.percentile(zabs, 95))
    E = round(max(eaves, ground + 2))
    if ridge - E < FLAT_RISE:
        h = np.full(len(rr), round(max(float(np.median(zabs)), ground + 2)), np.float64)
        return "flat", h, h, np.zeros(len(rr)), np.zeros(len(rr)), 0.0
    dmax = float(d.max())
    rise, run = min(STEPS, key=lambda s: (abs(s[0] * np.floor(dmax / s[1] + 1e-6) - (ridge - E)), s[0], -s[1]))
    k = rise / run
    h = E + rise * np.floor(d / run + 1e-6)
    plane = E + k * d
    if shape == "hip_any":
        n_ = np.maximum(np.hypot(ox, oy), 1e-6)
        gx, gy = k * ox / n_, k * oy / n_
        top_ = d >= dmax - 1e-6
    elif shape == "hip":
        across = fv <= fu
        sv, su = np.sign(v), np.sign(u)
        gx = np.where(across, -sv * perp[0], -su * ax[0]) * k
        gy = np.where(across, -sv * perp[1], -su * ax[1]) * k
        top_ = d >= dmax - 1e-6
    else:
        sv = np.sign(v)
        gx, gy = -sv * perp[0] * k, -sv * perp[1] * k
        top_ = np.abs(v) < 0.5
    gx, gy = np.where(top_, np.nan, gx), np.where(top_, np.nan, gy)
    return shape, h, plane, gx, gy, k


def _tidy(f, rr, cc, top, dtm, lod2, lod2_use, cell_maxh, gxa, gya, pitched, R0, C0):
    """the survey's roof of one building tidied in place; returns the cells changed"""
    n0 = top[rr, cc].copy()
    if lod2 is not None:
        lz = lod2["z"][rr, cc]
        have = np.isfinite(lz)
        if lod2_use[rr, cc].mean() >= 0.5:  # (one the two disagree on, rebuilt since, keeps the surface model)
            # LoD2's planes over all of it: what stood off them (a pillar of the surface model 30 cells and more, a
            # patch it disagreed on) is noise of the image matching -- unless OSM maps that part taller
            tall = np.nan_to_num(cell_maxh[rr, cc]) > lz - dtm[rr, cc] + 4
            k = have & ~lod2_use[rr, cc] & ~tall
            top[rr[k], cc[k]] = lz[k] - dtm[rr[k], cc[k]]
            gxa[rr[k], cc[k]], gya[rr[k], cc[k]] = lod2["gx"][rr[k], cc[k]], lod2["gy"][rr[k], cc[k]]
            pitched[rr[k], cc[k]] = lod2["slope"][rr[k], cc[k]] >= 0.3
            _patches(rr[have], cc[have], top, dtm, lod2, gxa, gya, R0, C0)
    _speckle(rr, cc, top, dtm)
    return int((top[rr, cc] != n0).sum())


def _patches(rr, cc, top, dtm, lod2, gxa, gya, R0, C0):
    """small plane patches continued from the plane beside them, flat decks snapped to a larger one's level"""
    gx, gy = lod2["gx"][rr, cc], lod2["gy"][rr, cc]
    z = top[rr, cc].astype(np.float64) + dtm[rr, cc]
    a = z - gx * (cc + C0) - gy * (rr + R0)  # the plane's height at the project grid's origin (every region's the same)
    key = np.stack([np.round(gx * 20), np.round(gy * 20), np.round(a * 2)], 1)
    # (planes of one gradient at different heights are different patches: the intercept is part of the key)
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
    # each patch's plane: its cells' median gradient and intercept
    pg = np.zeros((nlab + 1, 3))
    for j in range(1, nlab + 1):
        s = li == j
        pg[j] = np.median(gx[s]), np.median(gy[s]), np.median(a[s])
    # small patches: the plane of the neighbouring patch they share the most border with, if it passes within 3 m
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
    # flat decks: the levels of the patches under 0.08 slope, largest first; a smaller one within LEVEL_SNAP takes it
    flat = [j for j in range(1, nlab + 1) if size[j] and np.hypot(pg[j, 0], pg[j, 1]) < 0.08]
    kept = []
    for j in sorted(flat, key=lambda j: -size[j]):
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


def apply(render, osm_areas, top, dtm, bmask, lod2, lod2_use, cell_maxh, gxa, gya, pitched, R0, C0, own, labels, core,
          note, report):
    """the rule over every rendered building (top: heights over the terrain, written in place; gxa, gya, pitched as
    voxelize.py keeps them; core: the region's core, (row slice, column slice), where buildings are counted). Returns
    the rule roofs' plane (a.s.l., NaN elsewhere), for the roof caps"""
    from shapely.strtree import STRtree
    D, W = top.shape
    sites = STRtree([g for _, _, t, g in osm_areas if (t.get("historic") in SITE_HISTORIC or t.get("amenity") ==
                     "place_of_worship" or t.get("landuse") == "religious") and g.geom_type in ("Polygon", "MultiPolygon")])
    cover = np.zeros((D, W), np.uint8)
    for f in render:
        cover[f["rr"], f["cc"]] += 1
    plane = np.full((D, W), np.nan, np.float32)
    count = dict(landmark=0, gable=0, hip=0, hip_any=0, flat=0, tidied=0, tidied_cells=0, other=0)
    why = dict(size=0, shared=0, terrace=0, type=0, shape=0)  # (of the tidied: why no rule roof)

    def tally(f, what, n=1, into=count):
        r, c = int(np.median(f["rr"])), int(np.median(f["cc"]))
        if core[0].start <= r < core[0].stop and core[1].start <= c < core[1].stop:
            into[what] += n

    for f in render:
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 4 or f["tags"].get("building") in ("roof", "carport", "canopy") or (f["minh"] or 0) >= 2 \
                or f.get("pit"):
            tally(f, "other")
            continue
        if _landmark(f, sites, labels, own):
            tally(f, "landmark")
            continue
        mine = cover[rr, cc] == 1
        rr, cc = rr[mine], cc[mine]
        if len(rr) < 4:
            tally(f, "other")
            continue
        if np.percentile(top[rr, cc], 95) >= TALL[0] and len(rr) < TALL[1]:
            tally(f, "landmark")
            continue
        if not SMALL[0] <= len(rr) <= SMALL[1]:
            out = "size"
        elif len(rr) < len(f["rr"]):
            out = "shared"
        elif _party(rr, cc, bmask, D, W) > PARTY:
            out = "terrace"
        else:
            out = _rule(f, rr, cc, top, dtm, lod2, R0, C0)
        if isinstance(out, str):
            tally(f, out, into=why)
            tally(f, "tidied")
            tally(f, "tidied_cells", _tidy(f, rr, cc, top, dtm, lod2, lod2_use, cell_maxh, gxa, gya, pitched, R0, C0))
            continue
        shape, h, pl, gx, gy, k = out
        top[rr, cc] = h - dtm[rr, cc]
        plane[rr, cc] = pl
        gxa[rr, cc], gya[rr, cc] = gx, gy
        pitched[rr, cc] = k >= 0.3
        tally(f, shape)
    report["counters"]["roof_rules"] = dict(count, why=why)
    note("roofs by rule (buildings in the core):", count, "tidied for want of a rule roof:", why)
    return plane
