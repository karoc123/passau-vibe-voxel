"""Sloped surfaces as data: the `caps` section of the level-1 nodes (tilefile.py SECTIONS; web/src/core/surface.ts
reads it; docs/plans/surface-caps.md).

A cap replaces the flat top face of one run of one column by a quad with four corner heights (1/64 m above the
volume's floor). Per column at most two: on the run that ends at the ground (grnd) and on the column's last run above
it (a bridge's deck). The section, uint16[6 * n], little-endian, planar (six arrays of n values one after the other):

  dcol  the column (row-major over S x S, S = N + 2, apron included, as cnts counts them) less the previous record's
  dz    zigzag(ztop less the previous record's ztop); ztop: the top (cells) of the run whose top face the cap replaces
  d0..d3  zigzag(corner less ztop * 64); corners 0: (x, y), 1: (x + 1, y), 2: (x + 1, y + 1), 3: (x, y + 1)

records sorted by column, then ztop; zigzag(v) = (v << 1) ^ (v >> 15) on int16. No record with all four deltas 0 (a
flat cap is no cap); no section at all in a node without caps.
"""
import numpy as np


def zigzag(v):
    v = np.asarray(v, np.int64)
    assert (v >= -32768).all() and (v <= 32767).all(), "caps: a value past int16"
    return ((v << 1) ^ (v >> 15)) & 0xFFFF


def unzig(u):
    u = np.asarray(u, np.int64)
    return (u >> 1) ^ -(u & 1)


def encode(col, ztop, q):
    """records (column, ztop, corners q[n, 4] absolute in 1/64 cell) -> the section's bytes (b"" for none)"""
    col, ztop, q = np.asarray(col, np.int64), np.asarray(ztop, np.int64), np.asarray(q, np.int64).reshape(-1, 4)
    if not len(col):
        return b""
    o = np.lexsort((ztop, col))
    col, ztop, q = col[o], ztop[o], q[o]
    dcol = np.diff(col, prepend=0)
    assert (dcol >= 0).all() and (dcol < 65536).all()
    planes = [dcol, zigzag(np.diff(ztop, prepend=0))] + [zigzag(q[:, k] - ztop * 64) for k in range(4)]
    return np.concatenate(planes).astype("<u2").tobytes()


def decode(buf):
    """the section's bytes -> (column, ztop, q[n, 4]) as encode took them"""
    a = np.frombuffer(buf, "<u2").astype(np.int64)
    n = len(a) // 6
    col = np.cumsum(a[:n])
    ztop = np.cumsum(unzig(a[n:2 * n]))
    q = np.stack([ztop * 64 + unzig(a[(2 + k) * n:(3 + k) * n]) for k in range(4)], 1)
    return col, ztop, q


# ---------------------------------------------------------------- the writer (phase A: ground and bridge decks)
#
# Per map column two nodes of a graph: G, the ground's surface (top: the tiles' ground gt), where it is neither water,
# a building nor steps; K, a bridge deck's surface (top: round(deck)), where voxelize.py built a deck. Their heights:
# G the terrain model (prep.npz dtm) where it agrees with the voxels within SRC_TOL, else the voxels' top (a fallback
# node: ground the pipeline moved in whole metres -- a bridgehead, a bore's floor, an underpass); K the deck's own
# smooth profile. Linked: 4-neighbours (any two layers) whose tops differ by a metre at most and, two ground nodes the
# terrain model knows, whose terrain differs by WALL_TOL at most (a wall the terrain model shows stays a step). Smoothed
# N_SMOOTH times (each node: twice its own height and its links', averaged), then the fallback nodes alone N_RELAX more
# times between the rest (their 1 m stairs become a slope between the good terrain around them), with them the deck
# nodes (N_DECK rounds) and the ground at a deck's end (BLEND). A grid point's height
# for a node: the mean over the nodes of the four columns around it that are linked to it there (through the square's
# four edges), so neighbours on one surface take the same number and a wall keeps a riser; in 1/64 m, held within CLAMP
# of the node's top. All on the map's grid from rasters within REACH of a cell: the same for any window cover.
#
# Which runs get a record (from the node's own columns, D1 of the plan: paved ground and decks only): the run ending
# at the column's ground with air above, its top voxel paved (PAVED_IDS: web/src/core/materials.ts pavedGround) -- or
# on a carriageway (data/qa_roadmask.bin.gz 1) any ground but grass and water (a strip of earth the data paints where a
# bridge's way meets the road: a 15 cm dip at 50 km/h) --, and
# the column's last run above the ground, its top a deck's surface (cap_ids: paved, the bare deck's concrete, a rail
# deck's ballast), within DECK_TOL of the deck's profile. Lawns, fields, steps, water and anything standing on the
# ground stay voxels.
SRC_TOL, WALL_TOL, DECK_TOL = 0.75, 0.6, 0.75  # m
N_SMOOTH, N_RELAX = 16, 48
# a deck's nodes alone, more rounds after those (with the fallback nodes'): a deck is smooth in truth, and its profile
# (voxelize.py, the ways' heights interpolated over the deck) keeps a ripple of a few cm a car at 50-70 km/h rocks on
N_DECK = 48
# links: the ground nodes this near (over ground links) one linked to a deck relax with the fallback nodes, between the
# deck and the ground beyond. The terrain model drops with the bridge it leaves out and climbs back past the deck's end
# (the Schanzlbrücke's north end: 0.6 m under the deck's end, back at the road's level 5 m on), and held there the
# ground bent the road into a sag of -4 % / +4 % over 6 m (altstadt fixture, schanzl@70: pitch jitter 0.077 -> 0.036
# rad/s; BLEND 3: 0.053, 10: 0.028)
BLEND = 6
CLAMP = 56  # 1/64 m: the cap stays above the voxel under its run's top voxel (physics keeps that one as a floor)
# 1/64 m: a corner this near a whole metre is put on it (every column round its grid point alike). 0: off. At 2 a near
# level street came out as flat voxel tops the mesher merges, but each corner it moved bent the surface by up to 2/64 m
# within a metre: a level strip with a kink at each end (6 m of it on the Schanzlbrücke's crown at 18.000 m), and on a
# 5 % grade single corners (a synthetic grade at 70 km/h: pitch jitter 0.043 -> 0.077 rad/s). Off it costs the altstadt
# fixture +0.5 % level-1 triangles of the capped nodes (3.838 -> 3.858 M) and +3.9 % caps bytes (5.98 -> 6.21 MB raw)
SNAP = 0
REACH = N_SMOOTH + N_RELAX + BLEND + 1  # (N_DECK runs with N_RELAX: max of the two)
assert N_DECK <= N_RELAX  # cells: how far from a column what decides its corners lies (tile_fields.py HALO)
# phase B: the roofs' caps (roof_section below, a section of their own: `roof`, levels 1 2 4 8) -- drawn only, the roofs
# collide as voxels. False: tile_fields.py writes none (the client then draws roofs as voxel staircases)
ROOFS = True

M_SOLID, M_MARK = 0, 9
GROUND_HEX = ("#8f8981", "#a49f97", "#c6c2b8", "#b5b4af", "#b7b1a6", "#5f636b", "#6e7178", "#6a6d73", "#8a5a52",
              "#d8ccb5", "#8a8178", "#bdbab2")  # materials.ts GROUND_COLOURS
BALLAST, KERB, STEPS, DECK = "#8a8178", "#cfc7b8", "#a8a296", "#a7a49d"


def quantised(hex_):
    """a colour as voxelize.py's Palette quantises it (to 4, Python's round)"""
    return tuple(min(255, round(int(hex_[i:i + 2], 16) / 4) * 4) for i in (1, 3, 5))


def paved_ids(palette):
    """per palette id: paved ground (web/src/core/materials.ts pavedGround, core/semantics.ts SEM.PAVED)"""
    ground = {quantised(h) for h in GROUND_HEX} - {quantised(BALLAST)}
    kerb = quantised(KERB)
    return np.array([e[3] == M_MARK or (e[3] == M_SOLID and (tuple(e[:3]) == kerb or tuple(e[:3]) in ground))
                     for e in palette], bool)


M_SOIL, M_CONCRETE = 10, 13


def cap_ids(palette):
    """per palette id, (the ground's run may get a cap: paved_ids, and the bare deck's concrete -- a bridge's way where
    it is drawn on the ground at the bridge's end; a deck's top may: any deck surface -- paved, the bare deck, a rail
    deck's ballast or track bed -- not a railing, a lamp, glass, leaves, water)"""
    paved = paved_ids(palette)
    bare = np.array([e[3] == M_CONCRETE and tuple(e[:3]) == quantised(DECK) for e in palette], bool)
    deck = paved | np.array([e[3] in (M_SOLID, M_MARK, M_SOIL, M_CONCRETE) for e in palette], bool)
    return paved | bare, deck


def _shift(a, dy, dx, fill):
    """b[r, c] = a[r + dy, c + dx] (fill beyond a)"""
    b = np.full_like(a, fill)
    R, C = a.shape
    b[max(0, -dy):R - max(0, dy), max(0, -dx):C - max(0, dx)] = a[max(0, dy):R - max(0, -dy), max(0, dx):C - max(0, -dx)]
    return b


def _add_shifted(s, m, h, dy, dx):
    """s += np.where(m, _shift(h, dy, dx, 0.0), 0.0) in place, without the copies: where m is not (or beyond h), s is
    left as it is instead of +0.0 added (the same but for the sign of a zero)"""
    R, C = s.shape
    t = slice(max(0, -dy), R - max(0, dy)), slice(max(0, -dx), C - max(0, dx))
    st = s[t]
    np.add(st, h[max(0, dy):R - max(0, -dy), max(0, dx):C - max(0, -dx)], out=st, where=m[t])


def fields(gt, water, bld, steps, dtm, deck):
    """The corners of every node of a region (arrays of the region, all (R, C)): gt the tiles' ground (int), water,
    bld (a building), steps (the ground's top is steps), dtm (m over BASE, NaN unknown), deck (m over BASE, NaN none).
    Returns dict(G=..., K=...): per layer (ex: exists, top: int top, fb: fallback, h: smoothed height, q: corners
    float [4, R, C] in m, NaN where the node is not)."""
    R, C = gt.shape
    gt = gt.astype(np.int64)
    dtm = dtm.astype(np.float64)
    ok = np.isfinite(dtm) & (np.abs(dtm - gt) <= SRC_TOL)
    exK = np.isfinite(deck)
    # (no ground node where a deck lies on the ground -- its slab of two voxels reaching down to it, at a bridge's end:
    # that ground is no surface, and linked to the deck beside it, it pulled the deck's end down half a metre)
    exG = ~water & ~bld & ~steps & ~(exK & (np.round(np.nan_to_num(deck)) - 2 <= gt))
    L = {"G": dict(ex=exG, top=gt, fb=exG & ~ok, h=np.where(ok, dtm, gt).astype(np.float64)),
         "K": dict(ex=exK, top=np.where(exK, np.round(np.nan_to_num(deck)), 0).astype(np.int64), fb=np.zeros_like(exK),
                   h=np.nan_to_num(deck).astype(np.float64))}
    for v in L.values():
        v["h"] = np.where(v["ex"], v["h"], 0.0)
    dtm0 = np.nan_to_num(dtm)
    # links to the east and south neighbour: link[(a, b, d)][r, c]: node a of (r, c) and node b of its neighbour along d
    DIRS = {"E": (0, 1), "S": (1, 0)}
    link = {}
    for d, (dy, dx) in DIRS.items():
        for a in "GK":
            for b in "GK":
                A, B = L[a], L[b]
                m = A["ex"] & _shift(B["ex"], dy, dx, False) & (np.abs(A["top"] - _shift(B["top"], dy, dx, 0)) <= 1)
                if a == b == "G":
                    known = ~A["fb"] & ~_shift(B["fb"], dy, dx, True)
                    m &= ~known | (np.abs(dtm0 - _shift(dtm0, dy, dx, 0.0)) <= WALL_TOL)
                link[a, b, d] = m
    # (per node, its links in the four directions: (other layer, mask, shift to read the other's value))
    nbrs = {a: [] for a in "GK"}
    for a in "GK":
        for b in "GK":
            nbrs[a].append((b, link[a, b, "E"], (0, 1)))
            nbrs[a].append((b, _shift(link[b, a, "E"], 0, -1, False), (0, -1)))
            nbrs[a].append((b, link[a, b, "S"], (1, 0)))
            nbrs[a].append((b, _shift(link[b, a, "S"], -1, 0, False), (-1, 0)))
    for a in "GK":
        L[a]["n"] = sum(m.astype(np.float64) for _, m, _ in nbrs[a])
        # (the terms whose mask holds nothing left out of the sums below: each added +0.0 -- most windows have no
        # deck at all, 12 of the 16 terms; the same values, but for the sign of a zero, which the corners' rounding to
        # 1/64 removes)
        nbrs[a] = [t for t in nbrs[a] if t[1].any()]
    anyK = bool(L["K"]["ex"].any())
    # the ground at a deck's end: the ground nodes within BLEND links (over the ground) of one linked to a deck node
    G_K = [m for b, m, _ in nbrs["G"] if b == "K"]
    G_G = [(m, (dy, dx)) for b, m, (dy, dx) in nbrs["G"] if b == "G"]
    end = np.zeros((R, C), bool)
    for m in G_K:
        end |= m
    for _ in range(BLEND - 1):
        grow = end.copy()
        for m, (dy, dx) in G_G:
            grow |= m & _shift(end, dy, dx, False)
        end = grow
    L["G"]["end"] = end

    def step(only_fb, deck=False):
        new = {}
        for a in "GK":
            if a == "K" and not anyK:  # (no deck node: every one kept)
                new[a] = L[a]["h"]
                continue
            s = 2 * L[a]["h"]
            for b, m, (dy, dx) in nbrs[a]:
                _add_shifted(s, m, L[b]["h"], dy, dx)
            h = s / (2 + L[a]["n"])
            free = L[a]["fb"] | (deck & (a == "K")) | L[a].get("end", False)
            keep = ~L[a]["ex"] | (~free if only_fb else np.zeros_like(L[a]["ex"]))
            new[a] = np.where(keep, L[a]["h"], h)
        for a in "GK":
            L[a]["h"] = np.where(L[a]["ex"], new[a], 0.0)

    for _ in range(N_SMOOTH):
        step(False)
    for i in range(N_RELAX):
        step(True, i < N_DECK)
    # the grid points: point (i, j) the corner before column (i, j); around it NW (i-1, j-1), NE (i-1, j), SW (i, j-1),
    # SE (i, j), the point their corner 2, 3, 1, 0. Eight nodes (4 columns x 2 layers), labelled by component over the
    # square's edges (NW-NE, SW-SE: east links; NW-SW, NE-SE: south links)
    P = (R + 1, C + 1)

    def at(a, key, cell, fill):  # a column's array at each grid point, the column NW / NE / SW / SE of it
        v = np.full(P, fill, dtype=np.asarray(a[key]).dtype)
        dy, dx = {"NW": (1, 1), "NE": (1, 0), "SW": (0, 1), "SE": (0, 0)}[cell]
        v[dy:dy + R, dx:dx + C] = a[key]
        return v

    cells = ("NW", "NE", "SW", "SE")
    nodes = [(cl, a) for cl in cells for a in "GK"]
    ex = [at(L[a], "ex", cl, False) for cl, a in nodes]
    hh = [at(L[a], "h", cl, 0.0) for cl, a in nodes]
    edges = []
    for c1, c2, d in (("NW", "NE", "E"), ("SW", "SE", "E"), ("NW", "SW", "S"), ("NE", "SE", "S")):
        for a in "GK":
            for b in "GK":
                if not link[a, b, d].any():  # (an edge that links nothing changes no label)
                    continue
                lk = at({"m": link[a, b, d]}, "m", c1, False)
                edges.append((nodes.index((c1, a)), nodes.index((c2, b)), lk))
    lab = [np.where(e, i, 99) for i, e in enumerate(ex)]
    for _ in range(len(nodes)):
        for i, j, lk in edges:
            m = np.where(lk, np.minimum(lab[i], lab[j]), 99)
            lab[i] = np.where(lk, m, lab[i])
            lab[j] = np.where(lk, m, lab[j])
    for a in "GK":
        L[a]["q"] = np.full((4, R, C), np.nan)
    has = [bool(e.any()) for e in ex]
    for i, (cl, a) in enumerate(nodes):
        if not has[i]:  # (the node nowhere: its corners NaN, as they were)
            continue
        s = np.zeros(P)
        n = np.zeros(P)
        for j in range(len(nodes)):
            if not has[j]:  # (+0.0)
                continue
            same = ex[j] & (lab[j] == lab[i])
            s += np.where(same, hh[j], 0.0)
            n += same
        corner = np.where(ex[i], s / np.maximum(n, 1), np.nan)
        k = {"SE": 0, "SW": 1, "NW": 2, "NE": 3}[cl]
        dy, dx = {"NW": (1, 1), "NE": (1, 0), "SW": (0, 1), "SE": (0, 0)}[cl]
        L[a]["q"][k] = corner[dy:dy + R, dx:dx + C]
    L["linkGG"] = {1: link["G", "G", "E"], 0: link["G", "G", "S"]}  # (report(): along x, along y)
    return L


class Stats(dict):
    """counts (printed); cells: for report(), every ground cap's map cell and corners (flat ones too), if a list"""
    cells = None

    def add(self, **kw):
        for k, v in kw.items():
            self[k] = self.get(k, 0) + v


def node_section(F, sec, r0, c0, N, D, W, paved, stats=None):
    """The caps section (bytes, b"" for none) of the level-1 node whose first cell is map cell (r0, c0), from its
    sections `sec` (cnts, grnd, runs) and the region's fields F (fields() of a region whose corner is map cell
    F["at"])."""
    c, z, q, _ = node_records(F, sec, r0, c0, N, D, W, paved, stats)
    if not len(c):
        return b""
    b = encode(c, z, q)
    if stats is not None:
        stats.add(bytes=len(b), nodes_with_caps=1)
    return b


def node_records(F, sec, r0, c0, N, D, W, paved, stats=None):
    """node_section's records: column, ztop, corners [n, 4] (1/64 m), kind (0 ground, 1 deck)"""
    S = N + 2
    counts = np.frombuffer(sec["cnts"], np.uint16).astype(np.int64)
    grnd = np.frombuffer(sec["grnd"], np.uint8).astype(np.int64)
    runs = np.frombuffer(sec["runs"], np.uint16).reshape(-1, 3).astype(np.int64)
    off = np.concatenate([[0], np.cumsum(counts)])
    col = np.repeat(np.arange(S * S), counts)
    end = runs[:, 0] + runs[:, 1]
    nxt0 = np.append(runs[1:, 0], -1)
    nxt0[off[1:][counts > 0] - 1] = -1  # (a column's last run: nothing over it)
    paved, deckable = paved
    pid = np.minimum(runs[:, 2], len(paved) - 1)
    known = runs[:, 2] < len(paved)
    pv, dv = paved[pid] & known, deckable[pid] & known
    # map cell of each column (the apron: the neighbours' cells), inside the map
    Y, X = np.divmod(np.arange(S * S), S)
    mr, mc = r0 + Y - 1, c0 + X - 1
    inmap = (mr >= 0) & (mr < D) & (mc >= 0) & (mc < W)
    ar, ac = F["at"]
    lr, lc = np.clip(mr - ar, 0, F["G"]["ex"].shape[0] - 1), np.clip(mc - ac, 0, F["G"]["ex"].shape[1] - 1)
    assert not inmap.any() or ((mr[inmap] - ar >= 0).all() and (mr[inmap] - ar < F["G"]["ex"].shape[0]).all()
                               and (mc[inmap] - ac >= 0).all() and (mc[inmap] - ac < F["G"]["ex"].shape[1]).all()), "region too small"
    out_c, out_z, out_q, out_k = [], [], [], []
    st = stats if stats is not None else Stats()
    last = np.zeros(len(runs), bool)
    last[off[1:][counts > 0] - 1] = True
    for kind, lay in (("ground", "G"), ("deck", "K")):
        Lr = F[lay]
        if kind == "ground":
            road = F["road"][lr[col], lc[col]] & inmap[col]
            sel = (end == grnd[col]) & (nxt0 != end) & (pv | (road & dv))
        else:
            dk = F["deck"][lr[col], lc[col]]
            sel = last & (end > grnd[col]) & dv & np.isfinite(dk) & (np.abs(np.nan_to_num(dk) - end) <= DECK_TOL)
        sel &= inmap[col]
        k = np.nonzero(sel)[0]
        c = col[k]
        r_, c_ = lr[c], lc[c]
        exn = Lr["ex"][r_, c_]
        if kind == "ground":
            mism = exn & (Lr["top"][r_, c_] != end[k])
            st.add(skip_ground_mismatch=int(mism.sum()))
            exn &= ~mism
        st.add(**{f"{kind}_eligible": int(len(k)), f"{kind}_no_node": int((~exn).sum())})
        k, c, r_, c_ = k[exn], c[exn], r_[exn], c_[exn]
        zt = end[k]
        q = np.stack([Lr["q"][j][r_, c_] for j in range(4)], 1)
        qi = np.round(q * 64).astype(np.int64)
        qr = np.round(qi / 64).astype(np.int64) * 64
        qi = np.where(np.abs(qi - qr) <= SNAP, qr, qi)
        lo, hi = zt[:, None] * 64 - CLAMP, zt[:, None] * 64 + CLAMP
        st.add(**{f"{kind}_clamped": int(((qi < lo) | (qi > hi)).any(1).sum())})
        qi = np.clip(qi, lo, hi)
        flat = (qi == zt[:, None] * 64).all(1)
        st.add(**{f"{kind}_capped": int((~flat).sum()), f"{kind}_flat": int(flat.sum())})
        out_c.append(c[~flat]), out_z.append(zt[~flat]), out_q.append(qi[~flat])
        out_k.append(np.full(int((~flat).sum()), 0 if kind == "ground" else 1))
        if kind == "ground" and st.cells is not None:
            st.cells.append((r_ + ar, c_ + ac, qi))
    return np.concatenate(out_c), np.concatenate(out_z), np.concatenate(out_q).reshape(-1, 4), np.concatenate(out_k)


def region_fields(region, D, W, base, tmp="data"):
    """fields() over a region (ra, rb, ca, cb) of the map's rasters, or None without data/surface.npz (data from
    before it: no caps at all)"""
    from pathlib import Path
    import sidecar
    import window as wmod
    tmp = Path(tmp)
    if not (tmp / "surface.npz").exists():
        return None
    gt = wmod.npz_region(tmp / "surface.npz", "gt", region)
    deck = wmod.npz_region(tmp / "surface.npz", "deck", region).astype(np.float64)
    water = wmod.npz_region(tmp / "ground.npz", "water", region)
    bld = wmod.npz_region(tmp / "ground.npz", "b", region) > 0
    rgb = wmod.npz_region(tmp / "ground.npz", "rgb", region)
    steps = (rgb == np.array(quantised(STEPS), np.uint8)).all(-1)
    # (prep.npz's dtm from its uncompressed copy where regions.py made a fresh one: else inflated from its start for
    # every window of tile_fields.py; the same bytes)
    sc = sidecar.load(tmp / "prep.npz", "dtm")
    dtm = (np.array(sc[region[0]:region[1], region[2]:region[3]]) if sc is not None
           else wmod.npz_region(tmp / "prep.npz", "dtm", region)).astype(np.float64) - base
    F = fields(gt, water, bld, steps, dtm, deck)
    D_, W_ = gt.shape
    qa = tmp / "qa_roadmask.bin.gz"
    F["road"] = (wmod.gz_region(qa, (D, W), np.uint8, region) == 1) if qa.exists() else np.zeros((D_, W_), bool)
    F["deck"], F["bld"] = deck, bld
    F["at"] = (region[0], region[2])
    return F


def report(root=".", windows=None, note=print):
    """The writer's self-check over a built workspace (root: data/ and web/public/data/ in it), nothing written: per
    window the caps as tile_fields.py writes them, and over the map: capped columns by kind, bytes, clamped corners,
    columns skipped, the share of carriageway cells (data/qa_roadmask.bin.gz 1, no building) with a ground cap (flat
    or not), edge mismatches (two capped neighbours linked as one surface whose shared corners differ: the clamp's),
    and the roughness of the capped carriageway (the second difference of the cells' middle heights per metre along
    rows and columns, triples of linked capped cells: p50, p99, cm). Returns the numbers."""
    import gzip
    import json
    from pathlib import Path
    import tilefile
    import window as wmod
    root = Path(root)
    pub, tmp = root / "web/public/data", root / "data"
    meta = json.loads((pub / "meta.json").read_text())
    N, W, D, base = meta["tiles"]["N"], meta["W"], meta["D"], meta["base"]
    paved = cap_ids(meta["palette"])
    qa_all = None
    if (tmp / "qa_roadmask.bin.gz").exists():
        qa_all = np.frombuffer(gzip.decompress((tmp / "qa_roadmask.bin.gz").read_bytes()), np.uint8).reshape(D, W)
    tot = Stats()
    d2s, road_n, road_c, edges, mism = [], 0, 0, 0, 0
    for win in windows or wmod.cover(D, W, None):
        region = ra, rb, ca, cb = win.region(REACH + 31)
        F = region_fields(region, D, W, base, tmp)
        if F is None:
            note("caps report: no data/surface.npz")
            return None
        st = Stats()
        st.cells = []
        for ty in range(win.r0 // N, -(-win.r1 // N)):
            for tx in range(win.c0 // N, -(-win.c1 // N)):
                f = pub / "tiles" / "1" / f"{tx}_{ty}.bin"
                if win.holds(ty * N, tx * N) and f.exists():
                    node_section(F, tilefile.read(f, N), ty * N, tx * N, N, D, W, paved, st)
        for k, v in st.items():
            tot.add(**{k: v})
        # the window's core: the ground caps' corners as a raster (NaN: none)
        R_, C_ = rb - ra, cb - ca
        Q = np.full((4, R_, C_), np.nan)
        for rr, cc, qi in st.cells:
            keep = (rr >= win.r0) & (rr < win.r1) & (cc >= win.c0) & (cc < win.c1)
            Q[:, rr[keep] - ra, cc[keep] - ca] = qi[keep].T / 64
        has = np.isfinite(Q[0])
        sl = win.local(region)
        if qa_all is not None:
            road = (qa_all[ra:rb, ca:cb] == 1) & ~F["bld"]
            road_n += int(road[sl].sum())
            road_c += int((road & has)[sl].sum())
        else:
            road = has
        mid = Q.mean(0)
        for ax, (dy, dx), (k1, k2, n1, n2) in ((1, (0, 1), (1, 2, 0, 3)), (0, (1, 0), (3, 2, 0, 1))):
            nb = _shift(has, dy, dx, False)
            lk = has & nb & F["linkGG"][ax]
            e = lk[sl]
            edges += int(e.sum())
            diff = (Q[k1] != _shift(Q[n1], dy, dx, np.nan)) | (Q[k2] != _shift(Q[n2], dy, dx, np.nan))
            mism += int((lk & diff)[sl].sum())
            # second differences along the axis over three linked capped carriageway cells
            lk2 = lk & _shift(lk, -dy, -dx, False) & road & _shift(road, dy, dx, False) & _shift(road, -dy, -dx, False)
            sub = np.zeros_like(lk2)
            sub[sl] = True
            d2s.append((_shift(mid, dy, dx, np.nan) - 2 * mid + _shift(mid, -dy, -dx, np.nan))[lk2 & sub])
    d2 = np.abs(np.concatenate(d2s)) if d2s else np.zeros(0)
    d2 = d2[np.isfinite(d2)]
    out = {k: v for k, v in tot.items()}
    out.update(road_cells=road_n, road_capped=road_c, road_share=round(road_c / max(road_n, 1), 4),
               linked_edges=edges, edge_mismatches=mism, mismatch_share=round(mism / max(edges, 1), 5),
               rough_p50_cm=round(100 * float(np.percentile(d2, 50)), 2) if len(d2) else None,
               rough_p99_cm=round(100 * float(np.percentile(d2, 99)), 2) if len(d2) else None, rough_n=int(len(d2)))
    note("caps report: " + json.dumps(out))
    return out


# ---------------------------------------------------------------- the roofs (phase B: the `roof` section)
#
# A roof cell: a building's column (data/zones.bin) whose top voxel is roof material and whose roof plane is known
# (surface.npz roof_z, roof_gx, roof_gy: LoD2's, or a fitted roof's), its voxels where voxelize.py rounded it to
# (top == round(roof_z)), give or take a metre -- or moved by whole metres with its roof round it (a landmark's roof
# rebuilt over it: the median offset of the cell and its neighbours, up to ROOF_SHIFT; the plane moved by it). A cell
# with no plane of its own amid its roof's (three or four sides) takes theirs, where its top fits it. A slope cell (10
# degrees and more, as plane_codes ships a plane code) is that plane; a flatter one (a fitted roof's flat ridge, a flat
# roof beside a slope) is level at its voxels' top. Each grid point takes, per cell around it, the cell's plane there,
# and the cells that meet at it -- of one building within 2 m, any within a metre -- one height: the lowest plane's at
# a ridge or hip (each rises towards the other), the highest one's in a valley, else their mean; a cell the result
# would move more than its span (0.75 m + half its rise per metre) off its own plane keeps its own (roofs.ts
# slopeBase's rule, before this). The cap is drawn only: its voxels may lie under or over it (the mesher hides them).
# On the map's grid, from the rasters and the nodes' tops: two nodes hold the same corners for the columns they share.
# A cell whose four corners are its voxels' top gets a record only next to a sloped one of its building.
# Levels 2, 4, 8: a block's corners are the level-1 corners of the roof cells at its own four corners, divided by s,
# where all four are roof cells and lie within the block top's span.
ROOF_LIM = 448  # 1/64 m: a roof corner within 7 m of its run's top (a 75 degree roof's)
M_ROOF = 12
ROOF_SHIFT = 3  # m: a roof's voxels this far off round(roof_z) take its plane moved to them; further, no cap


def encode_roof(col, ztop, q):
    """the roof section's bytes (b"" for none): uint16[6 * n], little-endian, planar -- dcol and dz as the caps
    section's; then zigzag(corner 0 less the previous record's corner 1 where that record is the column just before
    (its west neighbour: they share the point), else less ztop * 64), zigzag(corner 1 less corner 0), zigzag(corner 2
    less corner 1), zigzag(corner 3 less corner 0) -- along a plane the same few numbers over and over (~1/3 smaller
    gzipped than the caps' layout on the map's roofs)"""
    col, ztop, q = np.asarray(col, np.int64), np.asarray(ztop, np.int64), np.asarray(q, np.int64).reshape(-1, 4)
    if not len(col):
        return b""
    o = np.lexsort((ztop, col))
    col, ztop, q = col[o], ztop[o], q[o]
    dcol = np.diff(col, prepend=0)
    assert (dcol >= 0).all() and (dcol < 65536).all()
    west = np.r_[False, dcol[1:] == 1]
    d0 = q[:, 0] - np.where(west, np.r_[0, q[:-1, 1]], ztop * 64)
    planes = [dcol, zigzag(np.diff(ztop, prepend=0)), zigzag(d0), zigzag(q[:, 1] - q[:, 0]), zigzag(q[:, 2] - q[:, 1]),
              zigzag(q[:, 3] - q[:, 0])]
    return np.concatenate(planes).astype("<u2").tobytes()


def decode_roof(buf):
    """the roof section's bytes -> (column, ztop, q[n, 4]) as encode_roof took them"""
    a = np.frombuffer(buf, "<u2").astype(np.int64)
    n = len(a) // 6
    dcol = a[:n]
    col = np.cumsum(dcol)
    ztop = np.cumsum(unzig(a[n:2 * n]))
    d = [unzig(a[(2 + k) * n:(3 + k) * n]) for k in range(4)]
    q = np.zeros((n, 4), np.int64)
    for i in range(n):
        q[i, 0] = d[0][i] + (q[i - 1, 1] if i and dcol[i] == 1 else ztop[i] * 64)
        q[i, 1] = q[i, 0] + d[1][i]
        q[i, 2] = q[i, 1] + d[2][i]
        q[i, 3] = q[i, 0] + d[3][i]
    return col, ztop, q


def roof_ids(palette):
    """per palette id: roof material (web/src/core/semantics.ts SEM.ROOF, chamfer.ts PAL_ROOF)"""
    return np.array([e[3] == M_ROOF for e in palette], bool)


def node_tops(sec, N):
    """a node's own columns (no apron): the top of the last run (0: empty) and its palette id, [N, N] each"""
    S = N + 2
    counts = np.frombuffer(sec["cnts"], np.uint16).astype(np.int64)
    runs = np.frombuffer(sec["runs"], np.uint16).reshape(-1, 3).astype(np.int64)
    last = np.cumsum(counts) - 1
    top = np.where(counts > 0, runs[np.maximum(last, 0), 0] + runs[np.maximum(last, 0), 1], 0) if len(runs) else np.zeros(S * S, np.int64)
    pal = np.where(counts > 0, runs[np.maximum(last, 0), 2], 0) if len(runs) else np.zeros(S * S, np.int64)
    return top.reshape(S, S)[1:-1, 1:-1], pal.reshape(S, S)[1:-1, 1:-1]


def roof_fields(roof_z, gx, gy, bid, top, roof):
    """The roof cells' corners over a region (arrays (R, C)): roof_z, gx, gy (surface.npz, m over BASE; NaN unknown),
    bid (the building, 0 none), top (the column's top, -1 not known), roof (its top voxel is roof material). Returns
    dict(q: corners [4, R, C] in 1/64 m (int64; meaningless where not part), part: roof cells, g: |gx| + |gy| of the
    plane (0 on a level cell), mism: cells with a plane whose top is not round(roof_z))."""
    R, C = roof_z.shape
    fin = np.isfinite(roof_z) & np.isfinite(gx) & np.isfinite(gy)
    rz = np.nan_to_num(roof_z).astype(np.float64)
    known = fin & (bid > 0) & roof & (top >= 0)
    # (a roof whose voxels were built a whole metre or few off the height they were rounded from -- a landmark's roof
    # rebuilt over it, a row lifted with a pit's fill -- is its plane moved by those metres: as the voxels have it)
    # (the metres the roof's voxels round it are off: the median over the cell and its 8 neighbours of the building --
    # one cell a metre off its plane among its roof's keeps the plane, its voxel hidden under or over it)
    o = np.where(known, top - np.round(rz), np.nan)
    st = np.stack([np.where(_shift(bid, dy, dx, 0) == bid, _shift(o, dy, dx, np.nan), np.nan) for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            med = np.nanmedian(st, 0)
    off = np.where(known & np.isfinite(med), np.round(np.nan_to_num(med)), 0)
    part = known & (np.abs(off) <= ROOF_SHIFT) & (np.abs(top - np.round(rz) - off) <= 1)
    rz = rz + np.where(part, off, 0)
    gx_, gy_ = np.where(part, np.nan_to_num(gx), 0).astype(np.float64), np.where(part, np.nan_to_num(gy), 0).astype(np.float64)
    # a hole in a roof (a roof cell of the building with no plane of its own -- a fitted roof's cell where the distance
    # to its eaves had no direction, an odd cell's plane metres off -- and three or four sides in its roof's cells):
    # the mean of its neighbours' planes carried over to it, where its top fits that within a metre (no chimney)
    nb = np.zeros((R, C))
    sz, sgx, sgy = np.zeros((R, C)), np.zeros((R, C)), np.zeros((R, C))
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        m = _shift(part, dy, dx, False) & (_shift(bid, dy, dx, 0) == bid)
        nb += m
        # (the neighbour's plane at this cell's middle: its height less its rise towards the neighbour)
        sz += np.where(m, _shift(rz, dy, dx, 0.0) - _shift(gx_, dy, dx, 0.0) * dx - _shift(gy_, dy, dx, 0.0) * dy, 0)
        sgx += np.where(m, _shift(gx_, dy, dx, 0.0), 0)
        sgy += np.where(m, _shift(gy_, dy, dx, 0.0), 0)
    hz = sz / np.maximum(nb, 1)
    hole = ~part & (bid > 0) & roof & (top >= 0) & (nb >= 3) & (np.abs(hz - top) <= 1)
    rz = np.where(hole, hz + (top - np.round(hz)), rz)
    gx_, gy_ = np.where(hole, sgx / np.maximum(nb, 1), gx_), np.where(hole, sgy / np.maximum(nb, 1), gy_)
    part = part | hole
    # (a slope: 10 degrees and more, as plane_codes codes one; flatter: level at its top)
    k = np.floor(np.arctan(np.hypot(gx_, gy_)) / (np.pi / 72) + 0.5)
    slope = part & (k >= 4)
    gx_, gy_ = np.where(slope, gx_, 0), np.where(slope, gy_, 0)
    T64 = top.astype(np.float64) * 64
    span = np.round((0.75 + 0.5 * (np.abs(gx_) + np.abs(gy_))) * 64)
    # each cell's own height at its corners: 0 (x, y), 1 (x + 1, y), 2 (x + 1, y + 1), 3 (x, y + 1)
    OFF = ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))
    own = [np.where(slope, 64 * (rz + gx_ * ox + gy_ * oy), T64) for ox, oy in OFF]
    # the grid points: point (i, j) the corner before cell (i, j); around it NW (i-1, j-1), NE (i-1, j), SW (i, j-1),
    # SE (i, j), the point their corner 2, 3, 1, 0
    P = (R + 1, C + 1)
    CELLS = (("NW", (1, 1), 2, (0, 0)), ("NE", (1, 0), 3, (1, 0)), ("SW", (0, 1), 1, (0, 1)), ("SE", (0, 0), 0, (1, 1)))

    def at(a, d, fill):
        v = np.full(P, fill, dtype=np.asarray(a).dtype)
        v[d[0]:d[0] + R, d[1]:d[1] + C] = a
        return v
    ex = [at(part, d, False) for _, d, _, _ in CELLS]
    v = [at(own[k_], d, 0.0) for _, d, k_, _ in CELLS]
    t = [at(T64, d, 0.0) for _, d, _, _ in CELLS]
    sp = [at(span, d, 0.0) for _, d, _, _ in CELLS]
    b = [at(bid.astype(np.int64), d, 0) for _, d, _, _ in CELLS]
    ggx = [at(gx_, d, 0.0) for _, d, _, _ in CELLS]
    ggy = [at(gy_, d, 0.0) for _, d, _, _ in CELLS]
    pos = [p for _, _, _, p in CELLS]
    pairs = [(i, j) for i in range(4) for j in range(i + 1, 4)]
    # the cells that meet: of one building within 2 m, any within 1 m (a step that small drawn as a wall zigzags)
    lab = [np.where(ex[i], i, 9) for i in range(4)]
    link = {}
    for i, j in pairs:
        d = np.abs(v[i] - v[j])
        link[i, j] = ex[i] & ex[j] & ((d <= 64) | ((b[i] == b[j]) & (d <= 128)))
    for _ in range(3):
        for i, j in pairs:
            m = np.where(link[i, j], np.minimum(lab[i], lab[j]), 9)
            lab[i] = np.where(link[i, j], m, lab[i])
            lab[j] = np.where(link[i, j], m, lab[j])
    # the slope between two cells' planes along the way from i to j: > 0 each rises towards the other (a ridge)
    sl = {(i, j): (ggx[i] - ggx[j]) * (pos[j][0] - pos[i][0]) + (ggy[i] - ggy[j]) * (pos[j][1] - pos[i][1]) for i, j in pairs}

    def meet(mem):
        """per point, the height the members meet at (NaN: fewer than 2)"""
        n = sum(m.astype(np.int64) for m in mem)
        lo = np.min([np.where(mem[i], v[i], np.inf) for i in range(4)], 0)
        hi = np.max([np.where(mem[i], v[i], -np.inf) for i in range(4)], 0)
        mean = sum(np.where(mem[i], v[i], 0.0) for i in range(4)) / np.maximum(n, 1)
        ridge = np.zeros(P, bool)
        valley = np.zeros(P, bool)
        for i, j in pairs:
            both = mem[i] & mem[j]
            ridge |= both & (sl[i, j] > 0.1)
            valley |= both & (sl[i, j] < -0.1)
        h = np.where(ridge & ~valley, lo, np.where(valley & ~ridge, hi, mean))
        return np.where(n >= 2, h, np.nan)

    def fits(i, h):
        return np.abs(h - v[i]) <= sp[i]

    hs = [v[i] for i in range(4)]
    for g in range(4):
        mem = [ex[i] & (lab[i] == g) for i in range(4)]
        h = meet(mem)
        okh = np.isfinite(h)
        allfit = okh.copy()
        for i in range(4):
            allfit &= ~mem[i] | fits(i, h)
        # (some do not fit: the rest meet without them, if they all fit then)
        mem2 = [mem[i] & np.where(okh, fits(i, h), False) for i in range(4)]
        h2 = meet(mem2)
        all2 = np.isfinite(h2)
        for i in range(4):
            all2 &= ~mem2[i] | fits(i, h2)
        for i in range(4):
            hs[i] = np.where(allfit & mem[i], h, np.where(~allfit & all2 & mem2[i], h2, hs[i]))
    q = np.zeros((4, R, C), np.int64)
    for (_, d, k_, _), hh in zip(CELLS, hs):
        q[k_] = np.round(hh[d[0]:d[0] + R, d[1]:d[1] + C]).astype(np.int64)
    # a level cell (its four corners its voxels' top) gets a record too where it is next to a sloped one of its building
    # (8 neighbours): one surface with the slope, the mesher's merged tops through each other's corners -- as a voxel
    # top beside the slope's, the slope's corners lay along the voxel face's edges (T-junctions)
    sloped = part & (q != top[None] * 64).any(0)
    near = np.zeros((R, C), bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            near |= _shift(sloped, dy, dx, False) & (_shift(bid, dy, dx, 0) == bid)
    return dict(q=q, part=part, g=np.abs(gx_) + np.abs(gy_), mism=known & ~part, shifted=part & (off != 0), holes=hole,
                keep=part & near, top=top)


def region_roofs(region, D, W, N, tmp, tiles_dir, palette, zones, core):
    """roof_fields() over a region of the map: the rasters of data/surface.npz, the buildings (zones, the region's), and
    the columns' tops from the level-1 nodes over the core and 16 m round it (what the corners of the core's nodes and
    their aprons, at every level, read). None without the rasters (data from before them)."""
    from pathlib import Path
    import tilefile
    import window as wmod
    tmp = Path(tmp)
    if not ROOFS or not (tmp / "surface.npz").exists():
        return None
    try:
        rz = wmod.npz_region(tmp / "surface.npz", "roof_z", region)
    except KeyError:
        return None
    gx = wmod.npz_region(tmp / "surface.npz", "roof_gx", region)
    gy = wmod.npz_region(tmp / "surface.npz", "roof_gy", region)
    ra, rb, ca, cb = region
    top = np.full((rb - ra, cb - ca), -1, np.int64)
    pal = np.zeros((rb - ra, cb - ca), np.int64)
    r0, r1, c0, c1 = max(core[0] - 16, 0), min(core[1] + 16, D), max(core[2] - 16, 0), min(core[3] + 16, W)
    for ty in range(r0 // N, -(-r1 // N)):
        for tx in range(c0 // N, -(-c1 // N)):
            f = Path(tiles_dir) / "1" / f"{tx}_{ty}.bin"
            if not f.exists():
                continue
            t_, p_ = node_tops(tilefile.read(f, N), N)
            y0, x0 = ty * N - ra, tx * N - ca
            ya, yb, xa, xb = max(y0, 0), min(y0 + N, rb - ra), max(x0, 0), min(x0 + N, cb - ca)
            if ya < yb and xa < xb:
                top[ya:yb, xa:xb] = t_[ya - y0:yb - y0, xa - x0:xb - x0]
                pal[ya:yb, xa:xb] = p_[ya - y0:yb - y0, xa - x0:xb - x0]
    rid = roof_ids(palette)
    roof = rid[np.minimum(pal, len(rid) - 1)] & (pal < len(rid))
    F = roof_fields(rz, gx, gy, zones, top, roof)
    F["at"] = (ra, ca)
    F["rid"] = rid
    return F


def roof_section(F, sec, r0, c0, N, D, W, s=1, stats=None):
    """The roof section (bytes, b"" for none) of the node of level s whose first cell (of s m) is (r0, c0), from its
    sections `sec` (cnts, runs) and the region's roof fields F (region_roofs). Per column at most one record, on its
    last run (its top: the roof); encode_roof's layout"""
    st = stats if stats is not None else Stats()
    S = N + 2
    counts = np.frombuffer(sec["cnts"], np.uint16).astype(np.int64)
    runs = np.frombuffer(sec["runs"], np.uint16).reshape(-1, 3).astype(np.int64)
    if not len(runs):
        return b""
    last = np.maximum(np.cumsum(counts) - 1, 0)
    T = np.where(counts > 0, runs[last, 0] + runs[last, 1], 0)
    pal = runs[last, 2]
    rid = F["rid"]
    isroof = (counts > 0) & (pal < len(rid)) & rid[np.minimum(pal, len(rid) - 1)]
    Y, X = np.divmod(np.arange(S * S), S)
    lr, lc = r0 + Y - 1, c0 + X - 1  # (cells of the level)
    Ds, Ws = -(-D // s), -(-W // s)
    ok = isroof & (lr >= 0) & (lr < Ds) & (lc >= 0) & (lc < Ws)
    ar, ac = F["at"]
    R_, C_ = F["part"].shape
    q = np.zeros((S * S, 4), np.int64)
    if s == 1:
        mr, mc = lr - ar, lc - ac
        inr = ok & (mr >= 0) & (mr < R_) & (mc >= 0) & (mc < C_)
        assert (inr == ok).all(), "roofs: region too small"
        mr, mc = np.clip(mr, 0, R_ - 1), np.clip(mc, 0, C_ - 1)
        ok &= F["part"][mr, mc]
        st.add(roof_top_mismatch=int((ok & (F["top"][mr, mc] != T)).sum()))
        st.add(roof1_shifted=int((ok & F["shifted"][mr, mc]).sum()), roof1_holes=int((ok & F["holes"][mr, mc]).sum()))
        ok &= F["top"][mr, mc] == T
        keep = F["keep"][mr, mc]
        for k in range(4):
            q[:, k] = F["q"][k][mr, mc]
        g = F["g"][mr, mc]
    else:
        # the level-1 cells at the block's corners, and their corners there
        y0, x0, y1, x1 = lr * s - ar, lc * s - ac, lr * s + s - 1 - ar, lc * s + s - 1 - ac
        cs = ((y0, x0, 0), (y0, x1, 1), (y1, x1, 2), (y1, x0, 3))
        g = np.zeros(S * S)
        for y, x, k in cs:
            inr = (y >= 0) & (y < R_) & (x >= 0) & (x < C_)
            assert not (ok & ~inr & (y + ar < D) & (x + ac < W)).any(), "roofs: region too small"
            y_, x_ = np.clip(y, 0, R_ - 1), np.clip(x, 0, C_ - 1)
            ok &= inr & F["part"][y_, x_]
            # (1/64 m to 1/64 cell)
            q[:, k] = np.round(F["q"][k][y_, x_] / s).astype(np.int64)
            g = np.maximum(g, F["g"][y_, x_])
        keep = np.ones(S * S, bool)  # (a level block among its roof's: drawn with them, as at 1 m)
        span = np.round((0.75 + 0.5 * g) * 64)
        far = ok & (np.abs(q - T[:, None] * 64) > span[:, None]).any(1)
        st.add(**{f"roof{s}_far": int(far.sum())})
        ok &= ~far
    lim = (np.abs(q - T[:, None] * 64) > ROOF_LIM).any(1) & ok
    st.add(**{f"roof{s}_clamped": int(lim.sum())})
    q = np.clip(q, T[:, None] * 64 - ROOF_LIM, T[:, None] * 64 + ROOF_LIM)
    flat = (q == T[:, None] * 64).all(1)
    rec = ok & (~flat | keep)
    st.add(**{f"roof{s}_level": int((ok & flat).sum()), f"roof{s}_capped": int(rec.sum())})
    if not rec.any():
        return b""
    c = np.nonzero(rec)[0]
    b = encode_roof(c, T[c], q[c])
    st.add(**{f"roof{s}_bytes": len(b)})
    return b


def main(argv):
    import json
    if "--paved-ids" in argv:
        pal = json.loads((__import__("pathlib").Path(__file__).parent / "palette.json").read_text())["palette"]
        print(json.dumps([int(i) for i in np.nonzero(paved_ids(pal))[0]]))
        return
    if "--report" in argv:
        import window as wmod
        meta = json.loads(open("web/public/data/meta.json").read())
        out = report(".", wmod.from_args(argv, meta["D"], meta["W"]))
        raise SystemExit(0 if out else 1)
    print(__doc__)
    print("usage: uv run python scripts/caps.py --paved-ids | --report [--windows NXxNY | --window-size METRES]")


if __name__ == "__main__":
    import sys
    main(sys.argv[1:])
