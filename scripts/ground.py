"""Where voxelize.py's ground stands: the terrain model (DGM1) rounded to whole metres, then lifted where it dropped
under a structure that carries a road (a short tunnel's roof, a passage's bridge, a culvert, an abutment, a
bridgehead's plaza). The passes run in the order of GROUND_PASSES, each a function of a Ctx returning the new ground;
the cells each one changed are counted in the build's report ("ground passes: ..."). The two of phase "decks" need the
bridge decks (their cells and levels), which voxelize.py knows only after the buildings: they run there, on the ground
the "terrain" passes left, before anything stands on it.

All thresholds are in T. The shared pieces: dsm_low (the surface model's low end per cell: the deck or the road, not
the cars or railings on it), carriageway_mask, way_ends (a set of ways' end nodes: tunnel portals, bridge ends).

Four of the passes are one idea -- the terrain model dropped under a structure; lift to the street or the surface model
-- for four ways to tell the structure: a short road tunnel under streets (tunnel), a passage under a street on a
short bridge (passage), a carriageway the laser saw no ground under (sag), a bridge's end (bridgehead). The sag lift
needs data/laser.npz (its ground returns); without it, it does nothing.
"""
import numpy as np
from scipy import ndimage
from shapely.geometry import Point
from shapely.strtree import STRtree

from ways import MAIN_ROADS, ROADS, layer_of, num, way_width

T = dict(
    # walls: the terrain's drop within a cell's neighbours that makes a wall (m); the share of it within 3 x 3 (else a
    # slope); a steep slope (rise per metre) smoothed over the hillside
    wall_drop=3, wall_share=0.65, steep=0.25,
    # tunnel: the longest short road tunnel (m); the street level from the surface ways this far past its footprint (m),
    # their spread at most (m); the footprint lifted when it lies this far under the street (m)
    tunnel_len=150, tunnel_clear=4, tunnel_spread=2, tunnel_depth=(1.5, 6),
    # passage: the band each side of the passage (m) the ways crossing it are lifted in, their ground this far past it
    # (m) on either side; lifted when this far under the line between (m); the surface model's low end from the
    # street's surface (m) and over the terrain model (m)
    pass_len=150, pass_band=8, pass_reach=4, pass_depth=(1, 6), pass_deck=(-1, 2), pass_over_dtm=0.4,
    # sag: the depth of a carriageway's trench under the surface model (m), the widest stretch (m), the rim taken with it
    # (m) from the depth (m), the surface model's spread over 3 x 3 (m), no lift within this of a tunnel's portal (m)
    sag_depth=(1, 7), sag_span=150, sag_side=6, sag_rim=0.4, sag_smooth=0.6, sag_portal=12,
    # open cut: a layer -1 way this far under the ground (m) this far to its sides (m), at least this long (m)
    cut_depth=2, cut_side=(6, 24), cut_len=10,
    # bridgehead: the ramp down from the deck (rise per metre), grown at most this far (m) from a bridge's end within
    # bh_seed (m); the terrain this far under the surface model (m), level within bh_flat over 3 x 3 (m); a piece of at
    # least bh_cells cells
    bh_grade=0.12, bh_reach=40, bh_seed=20, bh_depth=2, bh_flat=1.5, bh_cells=30,
)


class Ctx:
    """what the passes read: the region's rasters and OSM (voxelize.py's names), and the ground they change (g)"""

    def __init__(self, **kw):
        self.__dict__.update(kw)
        self._low = {}

    def dsm_low(self, k=1, how="min"):
        """the surface model's lowest return per cell (m over BASE): a deck, not its cars or railings; over k x k
        cells, its minimum or median"""
        key = (k, how)
        if key not in self._low:
            lo = self.d4.min((1, 3)) - self.BASE if k == 1 else \
                (ndimage.minimum_filter if how == "min" else ndimage.median_filter)(self.dsm_low(), k)
            self._low[key] = lo
        return self._low[key]


def way_ends(osm, pred):
    """the end nodes (rounded to a millimetre) of the ways whose tags pass pred"""
    return {_node(p_) for _, t_, l_ in osm.lines if pred(t_) for p_ in (l_.coords[0], l_.coords[-1])}


def _node(p_):
    return round(p_[0], 3), round(p_[1], 3)


def carriageway_mask(ctx):
    """the carriageways on the ground: road classes, not in a tunnel, covered or on a bridge, their drawn width"""
    m = np.zeros((ctx.D, ctx.W), np.uint8)
    ctx.burn(m, [(l_.buffer(way_width(t_) / 2, cap_style="flat"), 1) for _, t_, l_ in ctx.osm.lines
                 if t_.get("highway") in ROADS and t_.get("tunnel") in (None, "no") and t_.get("covered") in (None, "no")
                 and t_.get("bridge") in (None, "no") and layer_of(t_) >= 0 and way_width(t_)])
    return m


# ---------------------------------------------------------------- phase "terrain"

def walls(ctx):
    """The terrain smoothed over 3 m, except at its walls: a box filter made every retaining wall (an underpass, a
    trench, a ramp's sides, a building pit, a deck's abutment) a 3 m ramp, and rounding cut the ramp into ragged 1-2 m
    stairs that zigzagged along the wall -- rubble along every sunken road. Where the terrain drops 3 m or more within
    a cell's neighbours, the cell takes the upper or the lower level around it (5 x 5, of the 3 x 3 median): the upper
    where the terrain smoothed over ~3 m stands above the middle of the two -- one clean contour along the wall (each
    cell deciding on its own sample flickered between the levels along a diagonal wall). Gentle slopes (embankments,
    the escarpment) stay smooth. Rounded to whole metres: the ground occupies z in [0, g)."""
    dtm, dtm_s, note = ctx.dtm, ctx.dtm_s, ctx.note
    med = ndimage.median_filter(dtm, 3)
    lo, hi = ndimage.minimum_filter(med, 5), ndimage.maximum_filter(med, 5)
    wall = (ndimage.maximum_filter(dtm, 3) - ndimage.minimum_filter(dtm, 3) >= T["wall_drop"]) & (hi - lo >= T["wall_drop"])
    # a steep natural slope is no wall: the hillsides under Oberhaus and Mariahilf climb 3 m within a few metres too,
    # and snapped to two levels they stood as cliffs of 4-8 m. A wall takes its whole drop within its 3 x 3 cells, a
    # slope (even 45 deg) spreads it: in 3 x 3 under 0.65 of the drop over 5 x 5 is a slope
    near = ndimage.maximum_filter(med, 3) - ndimage.minimum_filter(med, 3)
    wall &= near >= T["wall_share"] * (hi - lo)
    note("ground: wall cells snapped to their level:", int(wall.sum()))
    # on a slope the 1 m terrain's jitter (crowns' pits, boulders, a filtering seam) rounded to ragged contours: a
    # stair of 1 m steps that zigzagged up the hillside in pale specks. Where the ground is steep and no wall, smoothed
    # over ~4 m: even terraces along the contour lines
    gs = ndimage.gaussian_filter(dtm, 1.5)
    gy, gx = np.gradient(ndimage.gaussian_filter(dtm, 2.0))
    steep = ndimage.binary_dilation(np.hypot(gx, gy) > T["steep"], iterations=2) & ~ndimage.binary_dilation(wall, iterations=3)
    note("ground: steep cells smoothed over the hillside:", int(steep.sum()))
    gf = np.where(wall, np.where(ndimage.gaussian_filter(dtm, 1.5) >= (lo + hi) / 2, hi, lo), np.where(steep, gs, dtm_s))
    return np.round(gf - ctx.BASE).astype(np.int32)


def pits(ctx):
    """rounding a smooth slope leaves single cells 1 m under all eight neighbours (38.49 to 38, round 38.51 to 39): a
    dark hole in a pavement or a lawn every few metres; such a cell takes their level"""
    g = ctx.g.copy()
    pit = ndimage.minimum_filter(g, footprint=np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])) - g == 1
    g[pit] += 1
    ctx.note("ground: rounding pits lifted:", int(pit.sum()))
    ctx.note(f"ground: BASE={ctx.BASE} m a.s.l., g range {g.min()}..{g.max()}")
    return g


def tunnel(ctx):
    """The street over a road tunnel: the terrain model's ground can sag metres over a short tunnel, and the trams and
    cars on it dipped into the cut. A short tunnelled carriageway (under 150 m) crossed by surface ways: the street
    level is where those ways stand 4 m clear of it on either side; its footprint lower than that by 1.5-6 m is lifted
    to it"""
    from shapely.ops import unary_union
    osm, g, D, W = ctx.osm, ctx.g.copy(), ctx.D, ctx.W
    surf = [l_ for _, t_, l_ in osm.lines if (t_.get("highway") or t_.get("railway") == "tram") and t_.get("tunnel") is None
            and layer_of(t_) >= 0]
    stree = STRtree(surf)
    n = 0
    tun = [l_.buffer((num(t_.get("lanes")) or 2) * 1.6 + 2, cap_style="flat") for _, t_, l_ in osm.lines
           if t_.get("tunnel") == "yes" and l_.length <= T["tunnel_len"]
           and (t_.get("highway") or "").replace("_link", "") in MAIN_ROADS]
    # a dual carriageway's two tunnels and the strip between them are one crossing
    tun = unary_union(tun).buffer(6).buffer(-6) if tun else None
    clear, (d0, d1) = T["tunnel_clear"], T["tunnel_depth"]
    for foot in getattr(tun, "geoms", [tun] if tun else []):
        levels = []
        for k in stree.query(foot):
            sl = surf[k]
            x_ = sl.intersection(foot)
            if x_.is_empty or x_.length < 3:
                continue
            pr = [sl.project(Point(c_)) for g_ in getattr(x_, "geoms", [x_]) for c_ in g_.coords]
            for q in (sl.interpolate(max(min(pr) - clear, 0)), sl.interpolate(min(max(pr) + clear, sl.length))):
                if 0 <= q.y < D and 0 <= q.x < W and not foot.contains(q):
                    levels.append(int(g[int(q.y), int(q.x)]))
        if len(levels) < 2 or np.percentile(levels, 80) - np.percentile(levels, 20) > T["tunnel_spread"]:
            continue
        street = int(np.median(levels))
        rr_, cc_ = ctx.cells_of(foot)
        low = (street - g[rr_, cc_] >= d0) & (street - g[rr_, cc_] <= d1)
        g[rr_[low], cc_[low]] = street
        n += int(low.sum())
    ctx.note("ground over short road tunnels lifted to the street crossing them:", n)
    return g


def passage(ctx):
    """The street over a passage: a footway, cycleway or service road under a street carried over it on a short bridge,
    OSM mapping the passage (tunnel=yes) and the street on it as plain ground (the Donauradweg under the B 8 at the
    Haissengasse). The terrain model leaves the bridge out and spans its gap from portal to portal: a trench 2-4 m deep
    across the street, the width of the structure (~14 m), and underpass.py sank its corridor under the trench's floor.
    Each surface way crossing the passage within pass_band m of it (between its portals) is lifted, across the way's
    width, to the line between its ground pass_band + pass_reach m from the passage on either side, where the ground
    lies 1-6 m under that line and the surface model on it, over the terrain model (its lowest return within -1..+2 m
    of the street's surface and 0.4 m or more over the terrain: the deck it saw, or a car on it; not a wall's foot
    beside a way along the passage's band, open to the sky, nor a crown over a path across a wooded hill the passage
    is bored through, nor a hollow the terrain model sees too). A way whose ground does not climb over the passage --
    a path at the passage's own level -- lifts nothing"""
    import shapely
    osm, g, D, W, dtm = ctx.osm, ctx.g.copy(), ctx.D, ctx.W, ctx.dtm
    xing = [(t_, l_) for _, t_, l_ in osm.lines if (t_.get("highway") or t_.get("railway") in ("rail", "light_rail", "tram"))
            and t_.get("tunnel") in (None, "no") and t_.get("bridge") in (None, "no") and layer_of(t_) >= 0]
    xtree = STRtree([l_ for _, l_ in xing])
    dsm_lo = ctx.dsm_low()
    reach, (d0, d1), (k0, k1) = T["pass_reach"], T["pass_depth"], T["pass_deck"]
    n = 0
    for _, t_, l_ in osm.lines:
        hw_ = (t_.get("highway") or "").replace("_link", "")
        if t_.get("tunnel") != "yes" or not hw_ or l_.length > T["pass_len"] or hw_ in MAIN_ROADS:
            continue
        band = l_.buffer(T["pass_band"], cap_style="flat")
        for k in xtree.query(band):
            xt, sl = xing[k]
            x_ = sl.intersection(band)
            if x_.is_empty or x_.length < 3:
                continue
            pr = [sl.project(Point(c_)) for g_ in getattr(x_, "geoms", [x_]) for c_ in g_.coords]
            s0, s1 = min(pr) - reach, max(pr) + reach
            qa, qb = sl.interpolate(s0), sl.interpolate(s1)
            if s0 < 0 or s1 > sl.length or not all(0 <= q.y < D and 0 <= q.x < W for q in (qa, qb)):
                continue
            ga, gb = int(g[int(qa.y), int(qa.x)]), int(g[int(qb.y), int(qb.x)])
            corr = sl.buffer(max(way_width(xt), 2) / 2 + 1, cap_style="flat").intersection(band)
            rr_, cc_ = ctx.cells_of(corr, fallback=False)
            if not len(rr_):
                continue
            s_ = shapely.line_locate_point(sl, shapely.points(cc_ + 0.5, rr_ + 0.5))
            street = np.round(ga + (gb - ga) * np.clip((s_ - s0) / (s1 - s0), 0, 1)).astype(g.dtype)
            lo_ = dsm_lo[rr_, cc_] - (street - 0.5)
            low = (street - g[rr_, cc_] >= d0) & (street - g[rr_, cc_] <= d1) & (lo_ >= k0) & (lo_ <= k1) \
                & (dsm_lo[rr_, cc_] - (dtm[rr_, cc_] - ctx.BASE) >= T["pass_over_dtm"])
            g[rr_[low], cc_[low]] = street[low]
            n += int(low.sum())
    ctx.note("ground over passages lifted to the streets crossing them:", n)
    return g


def sag(ctx):
    """A carriageway on a structure no tag tells of: the terrain model leaves out what carries a road -- a culvert or a
    short bridge mapped as plain road (the B 85 by the Danube at project col 775, row 499: a trench 6 m deep and 40 m
    long), a junction on a deck over the ramp of a tunnel (-882, 667), an approach on its abutment's wedge before the
    mapped bridge (the B 8 at 914, 709), the street over a passage whose ways end on it (-1641, 599: the passage lift
    needs them to reach 12 m past it) -- and the road dipped with the terrain, 1-6 m, into a trench or a dent. Where the
    laser saw no ground under the road (no ground return in the cell: a deck, not a lawn or a forest floor under a
    crown) and the surface model's lowest return over 3 x 3 m is smooth and stands 1-7 m over the ground, the ground of
    a carriageway (not on a bridge or under one, not in a building, not by the river) is lifted to that return -- a
    stretch at a time (8-connected, 150 m across at most: region-local), where its rim meets carriageway the terrain
    model agrees with (the surface model within a metre of the ground) at the level it is lifted to (the median step
    there a metre at most: a canopy, a roof or a deck over the road stands metres over the road's ground at its rim).
    The surface it was lifted to is the caps' source there (ctx.src, data/surface.npz gsrc), not the terrain model
    under it. The pavements, the median and the verges beside such a stretch (6 m round it at most, through cells
    passing the same tests but for the carriageway) rise with it: no pit left along the road"""
    osm, g, D, W, note = ctx.osm, ctx.g, ctx.D, ctx.W, ctx.note
    if ctx.n_ground is None:
        note("no data/laser.npz: carriageways on untagged structures not lifted")
        return g
    (s0, s1), side = T["sag_depth"], T["sag_side"]
    _ng = ctx.n_ground
    _lo3 = ctx.dsm_low(3, "min")
    _smooth = ndimage.maximum_filter(_lo3, 3) - ndimage.minimum_filter(_lo3, 3) <= T["sag_smooth"]
    _cw = carriageway_mask(ctx)
    _over = np.zeros((D, W), np.uint8)
    # (under a bridge: its ways' width and a metre each side, not past their ends -- the approach up to a bridge's
    # first node is a carriageway like any other -- and its outline)
    ctx.burn(_over, [(l_.buffer(max(way_width(t_), 2) / 2 + 1, cap_style="flat"), 1) for _, t_, l_ in osm.lines
                     if t_.get("bridge") not in (None, "no") and (t_.get("highway") or t_.get("railway"))]
             + [(a_ if t_.get("man_made") == "bridge" else a_.buffer(1), 1) for _, _, t_, a_ in osm.areas
                if t_.get("man_made") == "bridge" or t_.get("building") or t_.get("building:part")])
    # nor a way going on from a tunnel's portal, within sag_portal m of it: it leaves the passage at the passage's
    # level, under the street's deck (the service road out of the passage 1205663780 under the St 2125 at -1642, 602
    # had been lifted 4 m onto the deck over its portal)
    portals = way_ends(osm, lambda t_: t_.get("tunnel") not in (None, "no") and t_.get("highway"))
    ctx.burn(_over, [(l_.buffer(max(way_width(t_), 2) / 2 + 1, cap_style="flat").intersection(Point(p_).buffer(T["sag_portal"])), 1)
                     for _, t_, l_ in osm.lines if t_.get("highway") and t_.get("tunnel") in (None, "no")
                     for p_ in (l_.coords[0], l_.coords[-1]) if _node(p_) in portals])
    _dep = _lo3 - g
    _riv = ctx.river_level(np.arange(D)[:, None], np.arange(W)[None, :]) - ctx.BASE
    _open = (_dep >= s0) & (_dep <= s1) & _smooth & (_ng == 0) & (_over == 0) & (g > _riv + 1)
    _cand = (_cw > 0) & _open
    _to = np.round(_lo3).astype(np.int32)
    _agree = (_cw > 0) & ~_cand & (np.abs(_dep) < 1)
    _nb = ndimage.grey_dilation(np.where(_agree, g, -10000), size=(3, 3))
    _lab, _n = ndimage.label(_cand, np.ones((3, 3), bool))
    n_c = 0
    _up = np.zeros((D, W), bool)
    for _i, _sl in enumerate(ndimage.find_objects(_lab)):
        _k = _lab[_sl] == _i + 1
        _e = _k & (_nb[_sl] > -5000)
        if _e.sum() < 2 or max(_sl[0].stop - _sl[0].start, _sl[1].stop - _sl[1].start) > T["sag_span"] \
                or np.median(np.abs(_to[_sl][_e] - _nb[_sl][_e])) > 1:
            continue
        _up[_sl] |= _k
        n_c += 1
    n_r = int(_up.sum())
    n_fill = 0
    if n_r:
        # round it (sag_side m) the surface model stands from half a metre over the ground: the stretch's rim, where
        # the ground rounds to the same metre but the terrain model lies 0.5-1 m under the road (the caps would dip
        # to it), and the pavements beside it
        _rim = (_dep >= T["sag_rim"]) & (_dep <= s1) & _smooth & (_ng == 0) & (_over == 0) & (g > _riv + 1)
        _up = ndimage.binary_dilation(_up, np.ones((3, 3), bool), iterations=side, mask=_rim | _up)
        # and the cells in it the surface model does not see (a crown over the road, a lorry): the level of the
        # nearest lifted cell (sag_side m at most), where the surface model stands at it or over it and the laser saw
        # no ground under it either -- no pit left in the road under a tree
        _d, (_ir, _ic) = ndimage.distance_transform_edt(~_up, return_indices=True)
        _f = np.where(_up, _to, _to[_ir, _ic])
        _hole = ~_up & (_d <= side) & (_f - g >= 1) & (_f - g <= s1) & (_lo3 >= _f - 0.5) & (_ng == 0) \
            & (_over == 0) & (g > _riv + 1)
        n_fill = int(_hole.sum())
        ctx.src[_hole] = _lo3[_ir, _ic][_hole]
        g = np.where(_hole, _f, g).astype(g.dtype)
    g = np.where(_up, np.maximum(g, _to), g).astype(g.dtype)
    ctx.src[_up] = _lo3[_up]
    note("carriageways on structures the terrain model left out: ground lifted to the surface model:", int(_up.sum()),
         "cells in", n_c, "stretches, of them on the carriageways", n_r, "; under crowns and lorries in them:", n_fill)
    return g


def open_cut(ctx):
    """A carriageway or a railway tagged one layer down but with no tunnel is an open cut (a sunken expressway, a
    railway cutting): it had been left out as if underground. Where the ground along it stands 2 m or more under the
    ground 6-24 m to its sides (a dual carriageway's cut is 30 m wide), it is drawn and driven: its id in ctx.open_cut,
    and its layer set to 0 in the tags (every later test of voxelize.py, ways.underground included, sees a way on the
    ground). The ground is not changed"""
    g, (w0, w1) = ctx.g, T["cut_side"]
    for oid, t, line in ctx.osm.lines:
        if not ((t.get("highway") or "").replace("_link", "") in MAIN_ROADS or t.get("railway") == "rail"):
            continue
        if layer_of(t) >= 0 or t.get("tunnel") not in (None, "no") or t.get("covered") not in (None, "no") \
                or t.get("location") == "underground" or t.get("indoor") == "yes" or line.length < T["cut_len"]:
            continue
        rr_, cc_ = ctx.cells_of(line.buffer(1.5, cap_style="flat"))
        sr, sc = ctx.cells_of(line.buffer(w1, cap_style="flat").difference(line.buffer(w0, cap_style="flat")))
        if len(rr_) and len(sr) and np.percentile(g[sr, sc], 85) - np.median(g[rr_, cc_]) >= T["cut_depth"]:
            ctx.open_cut.add(oid)
            t["layer"] = "0"
    ctx.note("open cuts (layer -1, no tunnel) drawn:", len(ctx.open_cut))
    return g


# ---------------------------------------------------------------- phase "decks"

def bridgehead(ctx):
    """The ground at a bridgehead lifted to the surface the terrain model dropped with the bridge. The DGM1 leaves out
    bridges, and with them often the last metres of the approach, an abutment, or the plaza over a road that dives under
    the bridgehead (the Schanzlbrücke's north end over the B 12's covered stretch): the ground there lay 7 m under the
    deck, and the junction beside it was a crater -- the carriageway falling into a pit between the deck and the
    approach. Such a cell is open ground (no building, water, deck or tree crown) next to the deck, whose terrain stands
    2 m or more under the surface model, and the surface model there is level and at the deck's height or on a ramp
    down from it (12 % at most, within bh_reach metres of the deck): it is lifted to the surface model's level
    (an embankment, its exposed sides masonry). A road or path that really passes under the bridge is open to the
    sky beside the deck: the surface model sees it down at the ground, and it stays. Grown out from the deck cell by
    cell through such cells only (a max-plus dilation: no ties, the same in every region)."""
    from ways import HW, underground
    osm, g, deck, zt_, D, W = ctx.osm, ctx.g, ctx.deck, ctx.zt, ctx.D, ctx.W
    dmin = ctx.dsm_low(5, "median")  # the surface model's low end per cell, over 5 m (no cars)
    flat = ndimage.maximum_filter(dmin, 3) - ndimage.minimum_filter(dmin, 3) <= T["bh_flat"]  # a road's surface, not a crown
    # a way at the ground that does not come off a bridge (no node shared with a bridge way's end) passes under the
    # bridge or the structure beside it -- the tracks under a building site's deck by the station -- and stays open
    ends = way_ends(osm, lambda t_: ctx.on_bridge(t_) and (t_.get("highway") or t_.get("railway")))
    ground = [(t_, l_) for _, t_, l_ in osm.lines if (t_.get("highway") or t_.get("railway") in (
        "rail", "tram", "light_rail", "subway", "narrow_gauge")) and not ctx.on_bridge(t_) and not underground(t_)]
    under = np.zeros((D, W), np.uint8)
    ctx.burn(under, [(l_.buffer((num(t_.get("width")) or HW.get((t_.get("highway") or "").replace("_link", ""), 0)
                                 or (3.8 if t_.get("railway") else 2)) / 2 + 1), 1) for t_, l_ in ground
                     if not ends & {_node(p_) for p_ in l_.coords}])
    # and the railway's land (its tracks and platforms under a footbridge)
    ctx.burn(under, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("landuse") == "railway" or t_.get("railway") == "platform"])
    # grown from the deck at a bridge's end only: within bh_seed m of a bridge way's end that a way on the ground goes
    # on from (not along a footbridge's span over a station's tracks and the building site beside it)
    open_ends = ends & {_node(p_) for _, l_ in ground for p_ in l_.coords}
    seed = np.zeros((D, W), np.uint8)
    ctx.burn(seed, [(Point(p_).buffer(T["bh_seed"]), 1) for p_ in sorted(open_ends)])
    # nor the banks: over the water the surface model is a smooth sheet metres up (the Ilz under its bridges), and
    # ground within 2 m of the rivers' level is their bank or bed
    near_water = ndimage.binary_dilation(ctx.water, iterations=4) | (g <= ctx.river_lv - ctx.BASE + 2)
    cand = ~deck & ~ctx.bmask & ~near_water & ~ctx.veg & flat & (dmin - g >= T["bh_depth"]) & (under == 0)
    # (and the ground lifted to the surface model already, ctx.src: still part of the piece it lies in -- else the
    # piece round it shrank under the opening and the size below and fell back to the trench, 3 m under the road)
    cand |= np.isfinite(ctx.src) & ~deck & ~ctx.bmask & ~near_water & (under == 0)
    NEG = np.float32(-1e4)
    src = deck & (seed > 0)
    cone = np.where(src, zt_, NEG).astype(np.float32)  # the highest a cell may stand: the deck less 12 % per metre
    top = cone.copy()  # the deck level it comes from
    st = -T["bh_grade"] * np.array([[2 ** 0.5, 1, 2 ** 0.5], [1, 0, 1], [2 ** 0.5, 1, 2 ** 0.5]], np.float32)
    acc = np.zeros((D, W), bool)
    for _ in range(T["bh_reach"]):
        c2 = ndimage.grey_dilation(cone, structure=st, mode="constant", cval=NEG)
        t2 = ndimage.grey_dilation(top, size=(3, 3), mode="constant", cval=NEG)
        ok = cand & (c2 > NEG / 2) & (dmin >= c2 - 1.5) & (dmin <= t2 + 1.0)
        new = ok & ~acc
        if not new.any():
            break
        acc |= ok
        cone = np.where(src, cone, np.where(ok, c2, NEG)).astype(np.float32)
        top = np.where(src, top, np.where(ok, t2, NEG)).astype(np.float32)
    # not a sliver along a deck's edge (the surface model's deck smeared a cell or two over the bank beside it, or
    # over the road under a viaduct): a soil curtain hung from the deck's edge to the ground; nor a wedge by an
    # abutment over the bank falling away beside it. A piece 3 m wide and of bh_cells cells or more: an approach, a
    # plaza (the cells the opening shaved off a piece's rim come back: no notches of pit at its edge)
    acc0, acc = acc, ndimage.binary_opening(acc, np.ones((3, 3), bool))
    lab, n = ndimage.label(acc, np.ones((3, 3), bool))
    if n:
        acc &= np.isin(lab, np.nonzero(ndimage.sum(acc, lab, np.arange(1, n + 1)) >= T["bh_cells"])[0] + 1)
    acc |= acc0 & ndimage.binary_dilation(acc, np.ones((3, 3), bool), iterations=2)
    return np.where(acc, np.maximum(g, np.round(np.minimum(dmin, top))), g).astype(np.int32)


def bridge_way(ctx):
    """A bridge way drawn on the ground under its level (up to 2 m: ctx.bw) stands on ground lifted to it: the terrain
    model drops with the bridge round an abutment (its pits 2-6 m deep along the edge of a short bridge's outline), and
    the way's cells had kept that ground -- holes of 1-2 m in the carriageway beside the deck, deeper than the sloped
    caps reach (caps.CLAMP): the primary_link bridge (OSM way 121880279) off the B 12 west of the Schanzlbrücke"""
    lift = ctx.bw & (ctx.zt > ctx.g)
    ctx.note("bridge ways on the ground: ground lifted to their level:", int(lift.sum()), "cells")
    return np.where(lift, ctx.zt, ctx.g).astype(np.int32)


# the order they run in: (name, phase, pass)
GROUND_PASSES = [
    ("walls", "terrain", walls),
    ("pits", "terrain", pits),
    ("tunnel", "terrain", tunnel),
    ("passage", "terrain", passage),
    ("sag", "terrain", sag),
    ("open_cut", "terrain", open_cut),
    ("bridgehead", "decks", bridgehead),
    ("bridge_way", "decks", bridge_way),
]


def run(ctx, phase):
    """the passes of phase in their order, on ctx.g; the cells each changed in ctx.changed (the first: the cells it
    set off the terrain model rounded), counted in ctx.counts and noted"""
    for name, ph, fn in GROUND_PASSES:
        if ph != phase:
            continue
        g0 = getattr(ctx, "g", None)
        if g0 is None:
            g0 = np.round(ctx.dtm - ctx.BASE).astype(np.int32)
        ctx.g = fn(ctx)
        ctx.changed[name] = ctx.g != g0
        ctx.counts[name] = int(ctx.changed[name].sum())
    ctx.note(f"ground passes ({phase}), cells changed:", ", ".join(f"{n} {ctx.counts[n]}" for n, ph, _ in GROUND_PASSES
                                                                if ph == phase))
    return ctx.g
