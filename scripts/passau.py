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


def _fill(vol, g, g0, r0, r1, c0, c1, z0, z1, v):
    """Cells rows r0..r1-1, cols c0..c1-1, from z0 to z1-1 m over the church's ground level g0 (from the cell's own
    ground where that stands higher or lower: nothing hangs, nothing is buried)."""
    for r in range(r0, r1):
        for c in range(c0, c1):
            lo = int(g[r, c]) if z0 <= 0 else g0 + z0
            vol[lo:g0 + z1, r, c] = v


def _ledge(vol, g0, cells, z, v):
    """A cornice: one voxel at height z on each given cell where nothing stands (the band round a tower or front)."""
    for r, c in cells:
        if vol[g0 + z, r, c] == 0:
            vol[g0 + z, r, c] = v


def _ring(r0, r1, c0, c1):
    """The cells just outside the box rows r0..r1-1, cols c0..c1-1 (no corners)."""
    return [(r0 - 1, c) for c in range(c0, c1)] + [(r1, c) for c in range(c0, c1)] + \
        [(r, c0 - 1) for r in range(r0, r1)] + [(r, c1) for r in range(r0, r1)]


def _opening(vol, g0, face, along, z0, z1, v, arch=False, depth=1):
    """A window or door in an axis-aligned face. face = ('r', row, out) or ('c', col, out): the face's outer cells
    and the direction (+1/-1) the face looks; along = the cells along the face it spans. The face's voxels from z0 to
    z1-1 become v (depth of them), with an arch: one more voxel over the middle cell(s) when the span is odd/even."""
    ax, k, out = face
    for i, t in enumerate(along):
        top = z1 + (1 if arch and (len(along) % 2 == 1 and i == len(along) // 2 or
                                    len(along) % 2 == 0 and i in (len(along) // 2 - 1, len(along) // 2) and len(along) > 2)
                    else 0)
        for d in range(depth):
            r, c = (k - out * d, t) if ax == "r" else (t, k - out * d)
            col = vol[:, r, c]
            seg = col[g0 + z0:g0 + top]
            seg[seg != 0] = v


def _west_end(vol, g, pal, mats, roof, dx):
    """The Dom's west end built anew (DOP20, LoD2, Wikipedia): the surface model gave the towers' faces and the front
    between them in patches of the neighbours' colours, the aisle roofs' red over the towers' feet, the clerestory as a
    ragged ledge. Two square towers 12 m wide to 45 m with cornices and windows on each storey; between them the
    white front standing 2 m forward, three storeys under a cornice at 30 m and the gable of the nave's roof, a portal,
    a great arched window over it and an oculus; the nave behind it 16 m wide to 30 m under a roof to 38 m, its
    aisles under lean-to roofs from 16 m to 21 m, nine bays of arched windows in the clerestory and in the aisles."""
    win = mats[1]
    wall = pal((246, 244, 232), CLASSIC)
    cornice = pal((214, 206, 188), CLASSIC)
    door = pal((78, 56, 40), 0)
    lz, bid = lod2_rel()
    J, H = bid[748, 1960 + dx], bid[722, 1940 + dx]
    g0 = int(g[745, 1940 + dx])
    C = lambda c: c + dx  # noqa: E731
    # the church's old voxels here go: its west end and the towers, rows 714-772, cols 1929-1996
    n_clear = 0
    for r in range(714, 773):
        for c in range(C(1929), C(1997)):
            if (c < C(1949) or 727 <= r < 766) and not (r > 770 and c >= C(1945)):
                b = bid[r, c]
                gz = int(g[r, c])
                if b not in (0, J, H) and 3 < lz[r, c] < 40:
                    # a neighbour (not a stub of a tower LoD2 drew as its own building): only what the old towers
                    # left over its roof goes
                    gz += int(round(lz[r, c])) + 1
                if vol[gz:, r, c].any():
                    vol[gz:, r, c] = 0
                    n_clear += 1
    # the aisles: lean-to roofs from 16 m at their outer walls to 21-22 m at the nave's
    NA, NV, SA = (729, 736), (736, 752), (752, 764)  # north aisle, nave, south aisle (rows, end exclusive)
    c0, c1 = C(1931), C(1997)
    for r in range(*NA):
        top = 16 + round((r - NA[0]) * 5 / (NA[1] - 1 - NA[0]))
        _fill(vol, g, g0, r, r + 1, c0, c1, 0, 16, wall)
        _fill(vol, g, g0, r, r + 1, c0, c1, 16, top + 1, roof)
    for r in range(*SA):
        top = 16 + round((SA[1] - 1 - r) * 6 / (SA[1] - 1 - SA[0]))
        a0 = c0 if r < 759 else C(1945)  # (south of the front the tower stands at the aisle's end)
        _fill(vol, g, g0, r, r + 1, a0, c1, 0, 16, wall)
        _fill(vol, g, g0, r, r + 1, a0, c1, 16, top + 1, roof)
    # the nave: walls to 30 m, a pitched roof to 37-38
    for r in range(*NV):
        top = 30 + min(r - NV[0], NV[1] - 1 - r)
        _fill(vol, g, g0, r, r + 1, c0, c1, 0, 30, wall)
        _fill(vol, g, g0, r, r + 1, c0, c1, 30, top + 1, roof)
    # the towers: 12 x 12 m to 45 m
    towers = ((717, 729), (759, 771))
    tc0, tc1 = C(1933), C(1945)
    for r0, r1 in towers:
        _fill(vol, g, g0, r0, r1, tc0, tc1, 0, 45, wall)
    # the front between them, 2 m forward of the towers: to the cornice at 30 m over its whole width, the gable over
    # the nave
    F0, F1 = 729, 759
    _fill(vol, g, g0, F0, F1, c0, tc0, 0, 30, wall)
    for r in range(*NV):
        top = 30 + min(r - NV[0], NV[1] - 1 - r)
        _fill(vol, g, g0, r, r + 1, c0, c0 + 2, 30, top + 2, wall)
        vol[g0 + top + 1, r, c0] = cornice  # the gable's coping
    apex = 30 + (NV[1] - NV[0]) // 2
    mid = (NV[0] + NV[1]) // 2  # rows mid-1, mid: the middle
    for r in (mid - 1, mid):
        vol[g0 + apex + 1:g0 + apex + 3, r, c0] = wall  # a plinth for the cross
    vol[g0 + apex + 3:g0 + apex + 6, mid - 1, c0] = mats[3]
    vol[g0 + apex + 4, mid - 2:mid + 1, c0] = mats[3]
    # cornices: round the towers at 15, 29 and 44 m; across the front at 15 and 29 m
    for r0, r1 in towers:
        for z in (15, 29, 44):
            _ledge(vol, g0, _ring(r0, r1, tc0, tc1), z, cornice)
    for z in (15, 29):
        _ledge(vol, g0, [(r, c0 - 1) for r in range(F0, F1)] + [(F0 - 1, c) for c in range(c0, tc0)] +
               [(F1, c) for c in range(c0, tc0)], z, cornice)
    # the eaves: a cornice under the nave's and the aisles' roofs along both sides
    for c in range(tc1, c1):
        for r, z in ((NA[0] - 1, 15), (SA[1], 15)):
            if vol[g0 + z, r, c] == 0:
                vol[g0 + z, r, c] = cornice
    for c in range(tc0, c1):
        for r, z in ((NV[0] - 1, 29), (NV[1], 29)):
            if vol[g0 + z, r, c] == 0:
                vol[g0 + z, r, c] = cornice
    # the front's openings: the portal (recessed, its door), the great window over it, side windows, the oculus
    face = ("c", c0, -1)
    _opening(vol, g0, face, range(mid - 3, mid + 3), 0, 8, 0, arch=True)
    for r in range(mid - 3, mid + 3):
        top = 9 if r in (mid - 1, mid) else 8
        vol[g0:g0 + top, r, c0 + 1] = door
    _opening(vol, g0, face, range(mid - 2, mid + 2), 17, 26, win, arch=True)
    for rr in (range(F0 + 3, F0 + 5), range(F1 - 5, F1 - 3)):
        _opening(vol, g0, face, rr, 4, 11, win, arch=True)
        _opening(vol, g0, face, rr, 18, 25, win, arch=True)
    _opening(vol, g0, face, range(mid - 1, mid + 1), 32, 34, win)
    # the towers' windows: one storey each between the cornices, on every face that stands free
    n_win = 0
    for (r0, r1) in towers:
        rm = (r0 + r1) // 2
        cm = (tc0 + tc1) // 2
        faces = [(("c", tc0, -1), range(rm - 1, rm + 1)), (("c", tc1 - 1, 1), range(rm - 1, rm + 1)),
                 (("r", r0, -1), range(cm - 1, cm + 1)), (("r", r1 - 1, 1), range(cm - 1, cm + 1))]
        for f, along in faces:
            ax, k, out = f
            for z0, z1 in ((5, 12), (18, 26), (32, 41)):
                # free: open air in front of the window's middle
                t = along[0]
                r, c = (k + out, t) if ax == "r" else (t, k + out)
                if vol[g0 + z0:g0 + z1 + 1, r, c].any():
                    continue
                _opening(vol, g0, f, along, z0, z1, win, arch=True)
                n_win += 1
    # nine bays of arched windows: the clerestory over the aisles' roofs and the aisles' own walls
    for cm in range(C(1949), C(1994), 6):
        along = range(cm - 1, cm + 2)
        for f, z0, z1 in ((("r", NV[0], -1), 23, 28), (("r", NV[1] - 1, 1), 24, 28),
                          (("r", NA[0], -1), 4, 11), (("r", SA[1] - 1, 1), 4, 11)):
            ax, k, out = f
            if vol[g0 + z0:g0 + z1 + 1, k + out, cm].any():
                continue
            _opening(vol, g0, f, along, z0, z1, win, arch=True)
            n_win += 1
    return n_clear, n_win, [((r0 + r1) / 2, (tc0 + tc1) / 2) for r0, r1 in towers]


def _stair_turret(vol, g, pal, mats, r0, r1, c0, c1, h, cap):
    """The stair tower in the corner of the south transept and the choir (DOP20: a small square under grey sheet metal;
    LoD2 drew it a lean-to in the roofs' red): what stood there goes, white walls to h m with slit windows, a pyramid
    cap of grey sheet metal `cap` m high. The church's own higher walls round it stay."""
    win = mats[1]
    metal = pal((122, 128, 132), METAL)
    g0 = int(g[(r0 + r1) // 2, (c0 + c1) // 2])
    for r in range(r0, r1):
        for c in range(c0, c1):
            col = vol[:, r, c]
            nz = np.nonzero(col[g0:])[0]
            if len(nz) and nz[-1] > h + cap + 1:
                continue
            col[g0:] = 0
            col[int(g[r, c]):g0 + h] = mats[0]
            ring = min(r - r0, r1 - 1 - r, c - c0, c1 - 1 - c)
            if ring == 0 and (r - r0 == (r1 - r0) // 2 or c - c0 == (c1 - c0) // 2):
                for z in range(4, h - 2, 5):
                    col[g0 + z:g0 + z + 2] = win
            col[g0 + h:g0 + h + min(ring + 1, cap)] = metal


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
    # the roof's tiles as the choir has them (lod2_roofs: the ortho's own red), for the rebuilt nave and aisles
    tops = [int(vol[np.nonzero(vol[:, r, c])[0][-1], r, c]) for r in range(735, 760) for c in range(2014 + dx, 2034 + dx)]
    tiles = [t for t in tops if pal.entries[t][3] == ROOF and pal.entries[t][0] > pal.entries[t][2] + 30]
    if tiles:
        roof = max(set(tiles), key=tiles.count)
    n_clear, n_west, tw = _west_end(vol, g, pal, mats, roof, dx)
    n_fill += _fill_from_lod2(vol, g, (764, 766, 1971 + dx, 1997 + dx), (748, 1960 + dx), wall, roof)
    # windows on the church's own outer walls east of the nave: tall gothic ones in the choir east of the crossing
    cells = [(r + box[0], c + box[2]) for r, c in zip(*np.nonzero(bid[box[0]:box[1], box[2]:box[3]] == bid[748, 1960 + dx]))
             if c + box[2] >= 1997 + dx and math.hypot(r + box[0] + 0.5 - 747.5, c + box[2] + 0.5 - 2004.5 - dx) > 9.5] \
        if bid is not None else []
    n_win = _tall_windows(vol, g, cells, {wall, mats[0]}, win, tall=lambda r, c: c >= 2012 + dx) + n_west
    for cy, cx in tw:
        g0 = _cupola(vol, g, cy, cx, z0=45, R=4.8, drum=10, rise=7, mats=mats, clear=8.5)[0]
        # a balustrade round the shaft's top, the belfry standing back from it
        for r in range(int(cy - 6), int(cy + 6)):
            for c in range(int(cx - 6), int(cx + 6)):
                edge = min(r - int(cy - 6), int(cy + 6) - 1 - r, c - int(cx - 6), int(cx + 6) - 1 - c) == 0
                if edge and vol[g0 + 44, r, c] and vol[g0 + 45, r, c] == 0:
                    vol[g0 + 45, r, c] = mats[0]
    # the crossing: an octagon 15 m across to 48 m (the surface model's ring there), the drum 12 m across with its
    # windows, the dome to ~62 m and the lantern over it
    _cupola(vol, g, 747.5, 2004.5 + dx, z0=48, R=6.2, drum=7, rise=7, mats=mats, lantern=4, clear=11.5, fill_from=36, base_R=7.5, roof=roof)
    _stair_turret(vol, g, pal, mats, 758, 765, 2012 + dx, 2018 + dx, 19, 4)
    note(f"Dom St. Stephan: OSM's crossing onion cut ({n_cut} cells), {n_fill} cells of the church filled from LoD2, "
         f"{n_clear} cells of its west end rebuilt (towers, front, nave, aisles), {n_win} windows; two tower cupolas "
         f"and the crossing dome rebuilt (copper, lanterns, crosses), the stair tower by the choir")


def _lod2_abs(box):
    """LoD2 roof heights in voxel z (the grid's own levels, as g has them) and building ids over box."""
    r0, r1, c0, c1 = box
    z = np.load("data/lod2.npz")
    dtm = np.load("data/prep.npz", mmap_mode="r")["dtm"][r0:r1, c0:c1]
    return z["z"][r0:r1, c0:c1], z["bid"][r0:r1, c0:c1], dtm


def _hip_roofs(vol, g, box, wall_rgb, roof, pal, min_cells=30, join=(), keep=()):
    """Every LoD2 building in box (r0, r1, c0, c1) under a clean hipped roof: the surface model's tops (and LoD2's own
    roof faces, a fit to it) are lumpy, with holes and stray dark voxels. Eaves at the LoD2 roof's lower edge, the
    ridge at its top, the roof rising evenly from every wall to the footprint's middle (a distance transform), in one
    red; the walls under it down to the ground in the castle's pale render (the facade's own material, so the shader's
    windows stay). `join`: (bid_a, bid_b) pairs whose footprints are bridged where a gap of up to 3 m parts them (a
    wing built against the main block that LoD2 drew a slit away). `keep`: ids left as they are. Returns cells."""
    from scipy import ndimage
    r0, r1, c0, c1 = box
    Z, B, dtm = _lod2_abs(box)
    G = g[r0:r1, c0:c1].astype(float)
    off = float(np.median((G - dtm)[B > 0])) if (B > 0).any() else 0.0
    Zi = np.where(B > 0, Z + off, np.nan)
    ids, counts = np.unique(B[B > 0], return_counts=True)
    masks = {b: B == b for b, n in zip(ids, counts) if n >= min_cells and b not in keep}
    for a, b in join:
        if a in masks and b in masks:
            ma, mb = masks[a], masks[b]
            gap = ~ma & ~mb & (B == 0)
            # cells of the gap that see both buildings within 3 m along a row or a column
            near = lambda m, s: ndimage.binary_dilation(m, structure=s, iterations=3)  # noqa: E731
            for s in (np.ones((1, 3), bool), np.ones((3, 1), bool)):
                masks[b] = masks[b] | (gap & near(ma, s) & near(mb, s))
    n = 0
    for b, m in masks.items():
        e = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
        edge = m & (e < 1.5)
        zs = Zi[m & (B == b)]
        ze = Zi[edge & (B == b)]
        if not len(zs) or not len(ze):
            continue
        eave, ridge = int(round(np.percentile(ze, 15))), int(round(np.percentile(zs, 97)))
        ridge = max(ridge, eave + 2)
        em = e[m].max()
        top = eave + np.round((ridge - eave) * (e - 1) / max(em - 1, 1)).astype(int)
        wall = pal(wall_rgb, 1)
        soft = [i for i, e_ in enumerate(pal.entries) if e_[3] in (1, 12, 22)]
        for r, c in zip(*np.nonzero(m)):
            R, Cc = r + r0, c + c0
            col = vol[:, R, Cc]
            gz = int(g[R, Cc])
            t = int(top[r, c])
            if t <= gz + 2:
                continue
            col[max(eave, gz):] = 0
            seg = col[gz:eave]
            seg[(seg == 0) | np.isin(seg, soft)] = wall
            col[max(eave, gz):t + 1] = roof
            n += 1
    return n


def niederhaus(vol, g, pal, note):
    """Veste Niederhaus (DOP20, LoD2): the main block under its hipped roof on the rock, the east wing against it, the
    round-cornered tower by the Ilz. The surface model's roofs were lumps with holes, and a dark slit ran between the
    main block and the wing (LoD2 draws them 2 m apart)."""
    from aoi import I0
    dx = I0 - 1980
    box = (525, 575, 2585 + dx, 2665 + dx)
    roof = pal((168, 96, 72), ROOF)
    _, B, _ = _lod2_abs(box)
    bid = lambda r, c: int(B[r - box[0], c - box[2]])  # noqa: E731
    main, wing = bid(545, 2610 + dx), bid(548, 2630 + dx)
    n = _hip_roofs(vol, g, box, (228, 222, 208), roof, pal, join=((main, wing),))
    note(f"Veste Niederhaus: {n} cells under clean hipped roofs")


def _tidy_buildings(vol, g, box, pal, wall_rgb, min_h=4):
    """The buildings of LoD2 in box (r0, r1, c0, c1), as the surface model left them, tidied: a roof cell inside a
    footprint standing 2-5 m over or under the median of its 3 x 3 neighbourhood (a lump, a hole) is brought to that
    median in its neighbours' tiles, and the walls take one pale render (their own material, so the
    shader's windows stay) instead of the ortho's grey and beige patches. Returns (cells levelled, columns)."""
    from scipy import ndimage
    r0, r1, c0, c1 = box
    _, B, _ = _lod2_abs(box)
    sub = vol[:, r0:r1, c0:c1]
    G = g[r0:r1, c0:c1].astype(int)
    nzany = sub.any(axis=0)
    top = sub.shape[0] - 1 - np.argmax(sub[::-1] != 0, axis=0)
    mats = np.array([e[3] for e in pal.entries])
    tid = np.take_along_axis(sub, top[None], 0)[0]
    bmask = (B > 0) & nzany & (top - G >= min_h) & np.isin(mats[tid], (1, 6, 12, 20, 22))
    H = np.where(bmask, top, np.nan).astype(float)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # (all-NaN neighbourhoods off the buildings)
        med = ndimage.generic_filter(H, np.nanmedian, size=3, mode="constant", cval=np.nan)
    soft = np.isin(mats, (1, 20, 22))
    soft_ids = np.nonzero(soft)[0]
    wall = pal(wall_rgb, 1)
    inner = ndimage.binary_erosion(bmask)  # (an eave cell is lower than the roof beyond it by right)
    lev = 0
    for r, c in zip(*np.nonzero(bmask)):
        col = sub[:, r, c]
        h, m = int(top[r, c]), med[r, c]
        if inner[r, c] and np.isfinite(m) and 2 <= abs(h - m) <= 5:
            m = int(round(m))
            # the neighbours' tile at that level
            nb = [(rr, cc) for rr in range(max(r - 1, 0), min(r + 2, H.shape[0])) for cc in range(max(c - 1, 0), min(c + 2, H.shape[1]))
                  if bmask[rr, cc] and int(top[rr, cc]) == m]
            rid = int(tid[nb[0]]) if nb else int(tid[r, c])
            if h > m:
                col[m + 1:] = 0
                col[m] = rid
            else:
                col[h:m + 1] = np.where(col[h:m + 1] == 0, rid, col[h:m + 1])
                col[h] = col[h] if mats[col[h]] == 12 else rid
                col[m] = rid
            lev += 1
        nz = np.nonzero(col[:])[0]
        t = nz[-1]
        seg = col[G[r, c]:t]
        seg[np.isin(seg, soft_ids)] = wall
    return lev, int(bmask.sum())


def oberhaus(vol, g, pal, note):
    """Veste Oberhaus (DOP20, LoD2): its ranges round the courtyards in one pale render under their red roofs. The
    surface model gave them grey and beige patches and lumpy roofs with holes."""
    from aoi import I0
    dx = I0 - 1980
    box = (225, 400, 2290 + dx, 2445 + dx)
    lev, n = _tidy_buildings(vol, g, box, pal, (232, 226, 212))
    # the sheet-metal roofs (the long range by St. Georg): the ortho's glare made them near white, the walls' own
    # colour from above; the green-grey they are
    sheet = pal((138, 150, 142), ROOF)
    pale = {i for i, e in enumerate(pal.entries) if e[3] == ROOF and min(e[:3]) >= 160 and max(e[:3]) - min(e[:3]) < 24}
    sub = vol[:, box[0]:box[1], box[2]:box[3]]
    top = sub.shape[0] - 1 - np.argmax(sub[::-1] != 0, axis=0)
    for r, c in zip(*np.nonzero(np.isin(np.take_along_axis(sub, top[None], 0)[0], list(pale)))):
        col = sub[:, r, c]
        col[top[r, c]] = sheet
        if top[r, c] > 0 and col[top[r, c] - 1] in pale:
            col[top[r, c] - 1] = sheet
    note(f"Veste Oberhaus: {n} building columns in one render, {lev} roof lumps and holes levelled")


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
    import os
    if os.environ.get("PASSAU_SNAP"):  # the volume as the set pieces find it, for iterating on them alone
        import pickle
        os.makedirs("data/cache", exist_ok=True)
        np.save("data/cache/passau_vol.npy", vol)
        np.save("data/cache/passau_g.npy", g)
        pickle.dump(dict(entries=pal.entries, lines=list(osm.lines) if osm is not None else []),
                    open("data/cache/passau_rest.pkl", "wb"))
    dom(vol, g, pal, note)
    niederhaus(vol, g, pal, note)
    oberhaus(vol, g, pal, note)
    poststeg(vol, g, note)
    if osm is not None:
        fortresses(vol, g, pal, note, osm)
