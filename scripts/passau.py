"""Passau's curated set pieces, on top of what DOM20 + OSM give (called from landmarks.details).

Grid columns below are for the cut of scripts/aoi.py (Dom at I0 = 1980); centres are read off the DOM20 surface model,
which stands ~3 m south-east of the OSM outlines here.
"""
import math

import numpy as np

CLASSIC, WINDOW, ROOF, METAL = 20, 21, 12, 6  # landmarks.MAT_IDS


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _octagon(dx, dy, R):
    a, b = max(abs(dx), abs(dy)), min(abs(dx), abs(dy))
    return a <= R and a + b <= 1.42 * R, a, b


def _cupola(vol, g, cy, cx, z0, R, drum, rise, mats, lantern=3, clear=None, fill_from=None, base_R=None, roof=None):
    """An octagonal drum of half-width R from z0 (m over the ground at the centre) up `drum` m with a tall window in
    each main face, a copper dome over it rising `rise` m, a lantern and a gold cross. Everything the surface model
    left above z0 within `clear` m of the centre goes first (its dome was a stepped pyramid in the wall's colour).
    With `fill_from`, an octagonal base of half-width base_R (default R) stands from there up to z0, under a copper
    skirt where the drum is narrower."""
    wall, win, copper, gold = mats
    g0 = int(g[int(cy), int(cx)])
    zb, zd = g0 + z0, g0 + z0 + drum
    base_R = base_R or R
    clear = clear or base_R + 3
    n = 0
    for r in range(int(cy - clear) - 1, int(cy + clear) + 2):
        for c in range(int(cx - clear) - 1, int(cx + clear) + 2):
            dy, dx = r + 0.5 - cy, c + 0.5 - cx
            d = math.hypot(dx, dy)
            if d > clear:
                continue
            col = vol[:, r, c]
            col[zb:] = 0
            in_base, _, _ = _octagon(dx, dy, base_R)
            inside, a, b = _octagon(dx, dy, R)
            if fill_from is not None and not in_base and roof is not None:
                # the surface model's crossing tower is wider than the octagon: down to the roofs round it
                zc = g0 + fill_from + 2
                if col[zc:zb].any():
                    col[zc:zb] = 0
                    nz = np.nonzero(col[:zc])[0]
                    if len(nz):
                        col[nz[-1]] = roof
            if in_base and fill_from is not None:  # no gap under the drum where the model's own drum was narrower
                nz = np.nonzero(col[:zb])[0]
                lo = max(int(nz[-1]) + 1 if len(nz) else g0 + fill_from, g0 + fill_from)
                col[lo:zb] = wall
                if not inside:
                    col[zb - 1] = copper  # the skirt round the drum's foot
                a_, b_ = max(abs(dx), abs(dy)), min(abs(dx), abs(dy))
                rim = not _octagon(dx, dy, base_R - 1)[0]
                if rim and (b_ < 1.0 or abs(a_ - b_) < 0.75) and zb - g0 - fill_from >= 9:  # a window in each face
                    seg = col[zb - 8:zb - 2]
                    seg[seg != 0] = win
            if inside:  # the octagon
                col[zb:zd] = wall
                if a > R - 1 and b < 1.0 and drum >= 6:
                    col[zb + 2:zd - 2] = win
                n += 1
            for k in range(rise):
                if d <= R * math.sqrt(max(0.0, 1 - ((k + 0.3) / rise) ** 2)) + 0.3:
                    col[zd + k] = copper
            zl = zd + rise
            if d <= 1.5:
                col[zl - 1:zl + lantern] = wall
            if d <= 1.2:
                col[zl + lantern] = copper
            if d < 0.75:
                col[zl + lantern + 1] = copper
                col[zl + lantern + 2:zl + lantern + 4] = gold
    return g0, n


_LOD2 = {}


def lod2_rel():
    """LoD2 roof heights over the DTM and building ids (scripts/lod2.py), on the grid; None without data/lod2.npz."""
    if "z" not in _LOD2:
        from pathlib import Path
        if not Path("data/lod2.npz").exists():
            return None, None
        z = np.load("data/lod2.npz")
        dtm = np.load("data/prep.npz", mmap_mode="r")["dtm"]
        _LOD2["z"], _LOD2["bid"] = np.nan_to_num(z["z"] - dtm, nan=0.0), z["bid"]
    return _LOD2["z"], _LOD2["bid"]


def _fill_from_lod2(vol, g, box, bid_at, wall, roof, min_h=6):
    """The cells of one LoD2 building in `box` (r0, r1, c0, c1) that the voxels left empty (the OSM outline stands
    ~3 m north-west of the surface model here, and the voxels follow it): walls up to the LoD2 roof, a roof voxel on
    top. Returns the number of cells filled."""
    lz, bid = lod2_rel()
    if lz is None:
        return 0
    r0, r1, c0, c1 = box
    want = bid[r0:r1, c0:c1] == bid[bid_at]
    n = 0
    for r, c in zip(*np.nonzero(want)):
        r, c = r + r0, c + c0
        h = int(round(lz[r, c]))
        gz = int(g[r, c])
        if h < min_h or vol[gz:, r, c].any():
            continue
        vol[gz:gz + h - 1, r, c] = wall
        vol[gz + h - 1, r, c] = roof
        n += 1
    return n


def _tall_windows(vol, g, cells, wall_ids, win, period=5, width=2, split_over=20, tall=None):
    """Tall windows in every outer face of the given cells: in each vertical run of wall voxels with open air in front
    (a facade, a clerestory over an aisle roof) of 9 m and more, 3 m in from either end; a run over `split_over` m
    gets two windows one above the other (a church's lower and upper row), unless the cell is in `tall` (a gothic
    choir: one window the full height). Window columns every `period` m along the face, `width` wide."""
    wall_ids = np.asarray(list(wall_ids))
    n = 0
    for r, c in cells:
        col = vol[:, r, c]
        gz = int(g[r, c])
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            t = c if dr else r
            if t % period >= width:
                continue
            out = vol[:, r + dr, c + dc]
            face = np.isin(col, wall_ids) & (out == 0)
            face[:gz + 1] = False
            z = gz + 1
            while z < len(col):
                if not face[z]:
                    z += 1
                    continue
                lo = z
                while z < len(col) and face[z]:
                    z += 1
                hi = z - 1  # the run lo..hi
                L = hi - lo + 1
                if L < 9:
                    continue
                if L > split_over and not (tall is not None and tall(r, c)):
                    h1 = (L - 9) // 2
                    spans = ((lo + 3, lo + 3 + h1), (hi - 2 - h1, hi - 2))
                else:
                    spans = ((lo + 3, hi - 2),)
                for z0, z1 in spans:
                    col[z0:z1] = np.where(np.isin(col[z0:z1], wall_ids), win, col[z0:z1])
                    n += 1
    return n


def dom(vol, g, pal, note):
    """Dom St. Stephan (Wikipedia; DOP20 2024; DOM20; LoD2): white baroque, two west towers of 68 m -- square shafts to
    45 m, an octagonal belfry and a green copper dome with a lantern each (1896) -- and the crossing dome on its
    octagonal drum over the gothic east end (transept and choir, 1407-1530). The surface model has their masses, 6 m
    short and without the lanterns; OSM gives one wall and one roof colour for the whole church, and its outline stands
    ~3 m north-west of the church: the voxels missed a strip of the south side, the choir's south flank and its apse,
    and OSM's onion over the crossing (a part drawn 3 m off) stood beside the dome as a white stump."""
    from aoi import I0
    dx = I0 - 1980
    mats = (pal(_hex("#ece7da"), CLASSIC), pal((44, 46, 50), WINDOW), pal(_hex("#7fa595"), ROOF, q=12), pal(_hex("#c9a24a"), METAL))
    wall, roof = pal((248, 248, 236), CLASSIC), pal(_hex("#a86048"), ROOF)
    win = pal((58, 70, 68), WINDOW)
    box = (715, 775, 1920 + dx, 2045 + dx)
    lz, bid = lod2_rel()
    # OSM's onion over the crossing, drawn 3 m off: anything over the LoD2 roof by more than 3 m around the crossing
    # (the new dome is built below)
    n_cut = 0
    if lz is not None:
        for r in range(726, 768):
            for c in range(1986 + dx, 2020 + dx):
                lim = int(g[r, c]) + int(round(lz[r, c])) + 3
                if lz[r, c] > 0 and vol[lim:, r, c].any():
                    vol[lim:, r, c] = 0
                    nz = np.nonzero(vol[:, r, c])[0]
                    vol[nz[-1], r, c] = roof
                    n_cut += 1
    n_fill = _fill_from_lod2(vol, g, box, (748, 1960 + dx), wall, roof)
    # windows on the church's own outer walls (not the towers'), tall gothic ones in the choir east of the crossing
    towers = ((723.5, 1941.5 + dx, 8), (764.5, 1938.5 + dx, 8), (747.5, 2004.5 + dx, 9.5))
    cells = [(r + box[0], c + box[2]) for r, c in zip(*np.nonzero(bid[box[0]:box[1], box[2]:box[3]] == bid[748, 1960 + dx]))
             if c + box[2] >= 1947 + dx  # (not the west front between the towers: long black slots up its full height)
             and all(math.hypot(r + box[0] + 0.5 - ty, c + box[2] + 0.5 - tx) > rad for ty, tx, rad in towers)] \
        if bid is not None else []
    n_win = _tall_windows(vol, g, cells, {wall, mats[0]}, win, tall=lambda r, c: c >= 2012 + dx)
    for cy, cx in ((723.5, 1941.5), (764.5, 1938.5)):
        _cupola(vol, g, cy, cx + dx, z0=45, R=4.8, drum=10, rise=7, mats=mats, clear=8.5)
    # the crossing: an octagon 15 m across to 48 m (the surface model's ring there), the drum 12 m across with its
    # windows, the dome to ~62 m and the lantern over it
    _cupola(vol, g, 747.5, 2004.5 + dx, z0=48, R=6.2, drum=7, rise=7, mats=mats, lantern=4, clear=11.5, fill_from=36, base_R=7.5, roof=roof)
    note(f"Dom St. Stephan: OSM's crossing onion cut ({n_cut} cells), {n_fill} cells of the church filled from LoD2, "
         f"{n_win} windows; two tower cupolas and the crossing dome rebuilt (copper, lanterns, crosses)")


def _battlements(vol, g, line, wall, h, step):
    """A curtain wall along `line` (grid coords): `h` m of masonry on the ground, merlons a metre high every other
    metre along it. Cells where something already stands (a building, a tower) keep it. Returns the cells built."""
    n, seen = 0, set()
    for k, t in enumerate(np.arange(0, line.length, step)):
        x, y = line.interpolate(t).coords[0]
        r, c = int(y), int(x)
        if (r, c) in seen or not (0 <= r < vol.shape[1] and 0 <= c < vol.shape[2]):
            continue
        seen.add((r, c))
        gz = int(g[r, c])
        if vol[gz:gz + h + 2, r, c].any():
            continue
        vol[gz:gz + h, r, c] = wall
        if int(t) % 2 == 0:
            vol[gz + h, r, c] = wall
        n += 1
    return n


def _parapets(vol, g, line, wall, step=0.5, drop=3):
    """A crenellated parapet on the high side of a retaining wall (a bastion's face): where the ground falls `drop` m or
    more across the line within 3 m, a metre of wall on its upper edge with merlons every other metre."""
    n, seen = 0, set()
    for t in np.arange(0.5, line.length - 0.5, step):
        (x0, y0), (x1, y1) = line.interpolate(t - 0.5).coords[0], line.interpolate(t + 0.5).coords[0]
        L = math.hypot(x1 - x0, y1 - y0) or 1
        nx, ny = -(y1 - y0) / L, (x1 - x0) / L
        x, y = line.interpolate(t).coords[0]
        prof = []
        for o in np.arange(-3, 3.01, 1.0):
            r, c = int(y + ny * o), int(x + nx * o)
            if 0 <= r < vol.shape[1] and 0 <= c < vol.shape[2]:
                prof.append((int(g[r, c]), o, r, c))
        if len(prof) < 7:
            continue
        hi, lo = max(p[0] for p in prof), min(p[0] for p in prof)
        if hi - lo < drop:
            continue
        side = 1 if prof[-1][0] > prof[0][0] else -1
        # the first cell from the low side that is up at the top: the parapet stands on the edge
        for gz, o, r, c in (prof if side > 0 else prof[::-1]):
            if gz >= hi - 1:
                break
        if (r, c) in seen or vol[gz:gz + 3, r, c].any():
            continue
        seen.add((r, c))
        vol[gz, r, c] = wall
        if int(t) % 2 == 0:
            vol[gz + 1, r, c] = wall
        n += 1
    return n


def fortresses(vol, g, pal, note, osm):
    """Veste Oberhaus and Veste Niederhaus read as a town of white houses on the hill: OSM's walls (barrier=wall, the
    curtain wall down the slope between the two) were not built at all, and the bastions' retaining walls stood bare.
    Curtain walls 4 m high and parapets on the bastions, both crenellated, in the fortress's pale render."""
    from shapely.geometry import box
    from aoi import I0
    dx = I0 - 1980
    area = box(2150 + dx, 130, 2700 + dx, 600)  # the hill from Oberhaus down to the Niederhaus' point
    wall = pal(_hex("#d9d1c0"), CLASSIC)
    n_w = n_p = 0
    for _, t, line in osm.lines:
        if not line.intersects(area):
            continue
        b = t.get("barrier")
        x0, y0, x1, y1 = line.bounds
        # the fortress's own walls: the castles' outlines, those on the hilltop, and the curtain wall down to the
        # Niederhaus -- not the garden walls along the Danube's road under the hill or in the Ilzstadt
        if not (t.get("historic") or (y1 < 440 and x1 < 2500 + dx) or (x0 >= 2450 + dx and x1 <= 2600 + dx)):
            continue
        if b in ("wall", "city_wall"):
            n_w += _battlements(vol, g, line, wall, 4, 0.5)
        elif b == "retaining_wall":
            n_p += _parapets(vol, g, line, wall)
    note(f"fortresses: {n_w} cells of curtain wall, {n_p} of parapets on the bastions")


def poststeg(vol, g, note):
    """The Poststeg, the footbridge over the station's tracks (DOP20, DOM20): level at ~11.5 m over the tracks from the
    stair tower on Bahnhofstraße to the slope up to Spitalhofstraße, which stands 6 m over the tracks; there stairs take
    it down to the pavement (OSM's Bahnsteg). The deck's height profile was smoothed over 25 m and ran the last 40 m
    down to the tracks, into the foot of the 6 m slope. The deck is lifted back to its level, and a landing and a
    flight of steps go down at its south end."""
    from aoi import I0
    dx = I0 - 1980
    c0, c1 = 998 + dx, 1018 + dx
    ref = [int(np.nonzero(vol[g[r, c]:, r, c])[0][-1]) + int(g[r, c])
           for r in range(840, 860) for c in range(c0, c1) if vol[g[r, c]:g[r, c] + 14, r, c].any()]
    if not ref:
        return
    top = int(np.median(ref))  # the deck's top voxel in the north half
    moved, last = 0, None
    for r in range(860, 910):
        for c in range(c0, c1):
            gz = int(g[r, c])
            if gz > top - 4:
                continue
            nz = np.nonzero(vol[gz:top + 1, r, c])[0]
            if not len(nz) or nz[-1] + gz >= top:
                continue
            vals = vol[gz + nz, r, c].copy()
            vol[gz + nz, r, c] = 0
            vals = vals[-2:]  # (the deck's two voxels, not what stood under it)
            vol[top - len(vals) + 1:top + 1, r, c] = vals
            moved += 1
            last = (r, c, int(vals[-1]))
    if last is None:
        note("Poststeg: deck already level")
        return
    # the steps: as wide as the deck's end, one metre down per metre south until the ground
    r_end = last[0]
    cols = [c for c in range(c0, c1) if vol[top, r_end, c]]
    lo, hi = min(cols), max(cols)
    cols = range(max(lo, hi - 2), max(lo, hi - 2) + 3)
    tread = last[2]
    steps = 0
    for k in range(1, 16):
        r = r_end + k
        zt = top - k
        if all(zt < int(g[r, c]) for c in cols):
            break
        for c in cols:
            if zt >= int(g[r, c]):
                vol[int(g[r, c]):zt + 1, r, c] = tread
        steps += 1
    note(f"Poststeg: {moved} deck cells lifted back to level, {steps} steps down at its south end")


def build(vol, g, pal, note, osm=None):
    dom(vol, g, pal, note)
    poststeg(vol, g, note)
    if osm is not None:
        fortresses(vol, g, pal, note, osm)
