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
# times between the rest (their 1 m stairs become a slope between the good terrain around them). A grid point's height
# for a node: the mean over the nodes of the four columns around it that are linked to it there (through the square's
# four edges), so neighbours on one surface take the same number and a wall keeps a riser; in 1/64 m, held within CLAMP
# of the node's top. All on the map's grid from rasters within REACH of a cell: the same for any window cover.
#
# Which runs get a record (from the node's own columns, D1 of the plan: paved ground and decks only): the run ending
# at the column's ground with air above, its top voxel paved (PAVED_IDS: web/src/core/materials.ts pavedGround), and
# the column's last run above the ground, its top a deck's surface (cap_ids: paved, the bare deck's concrete, a rail
# deck's ballast), within DECK_TOL of the deck's profile. Lawns, fields, steps, water and anything standing on the
# ground stay voxels.
SRC_TOL, WALL_TOL, DECK_TOL = 0.75, 0.6, 0.75  # m
N_SMOOTH, N_RELAX = 16, 48
CLAMP = 56  # 1/64 m: the cap stays above the voxel under its run's top voxel (physics keeps that one as a floor)
# 1/64 m: a corner this near a whole metre is put on it (every column round its grid point alike: no lip), so a near
# level street is flat voxel tops the mesher merges, not a field of quads a centimetre off (the triangles)
SNAP = 2
REACH = N_SMOOTH + N_RELAX + 1  # cells: how far from a column what decides its corners lies (tile_fields.py HALO)
ROOFS = False  # phase B (roof caps): not written yet -- the client draws and collides roofs as voxels

M_SOLID, M_MARK = 0, 9
GROUND_HEX = ("#8f8981", "#a49f97", "#c6c2b8", "#b5b4af", "#b7b1a6", "#5f636b", "#6e7178", "#6a6d73", "#8a5a52",
              "#d8ccb5", "#8a8178", "#bdbab2")  # materials.ts GROUND_COLOURS
BALLAST, KERB, STEPS = "#8a8178", "#cfc7b8", "#a8a296"


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
    """per palette id, (the ground's run may get a cap: paved_ids; a deck's top may: any deck surface -- paved, the
    bare deck's concrete, a rail deck's ballast or track bed -- not a railing, a lamp, glass, leaves, water)"""
    paved = paved_ids(palette)
    deck = paved | np.array([e[3] in (M_SOLID, M_MARK, M_SOIL, M_CONCRETE) for e in palette], bool)
    return paved, deck


def _shift(a, dy, dx, fill):
    """b[r, c] = a[r + dy, c + dx] (fill beyond a)"""
    b = np.full_like(a, fill)
    R, C = a.shape
    b[max(0, -dy):R - max(0, dy), max(0, -dx):C - max(0, dx)] = a[max(0, dy):R - max(0, -dy), max(0, dx):C - max(0, -dx)]
    return b


def fields(gt, water, bld, steps, dtm, deck):
    """The corners of every node of a region (arrays of the region, all (R, C)): gt the tiles' ground (int), water,
    bld (a building), steps (the ground's top is steps), dtm (m over BASE, NaN unknown), deck (m over BASE, NaN none).
    Returns dict(G=..., K=...): per layer (ex: exists, top: int top, fb: fallback, h: smoothed height, q: corners
    float [4, R, C] in m, NaN where the node is not)."""
    R, C = gt.shape
    gt = gt.astype(np.int64)
    dtm = dtm.astype(np.float64)
    ok = np.isfinite(dtm) & (np.abs(dtm - gt) <= SRC_TOL)
    exG = ~water & ~bld & ~steps
    exK = np.isfinite(deck)
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

    def step(only_fb):
        new = {}
        for a in "GK":
            s = 2 * L[a]["h"]
            for b, m, (dy, dx) in nbrs[a]:
                s = s + np.where(m, _shift(L[b]["h"], dy, dx, 0.0), 0.0)
            h = s / (2 + L[a]["n"])
            keep = ~L[a]["ex"] | (~L[a]["fb"] if only_fb else np.zeros_like(L[a]["ex"]))
            new[a] = np.where(keep, L[a]["h"], h)
        for a in "GK":
            L[a]["h"] = np.where(L[a]["ex"], new[a], 0.0)

    for _ in range(N_SMOOTH):
        step(False)
    for _ in range(N_RELAX):
        step(True)
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
    for i, (cl, a) in enumerate(nodes):
        s = np.zeros(P)
        n = np.zeros(P)
        for j in range(len(nodes)):
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
            sel = (end == grnd[col]) & (nxt0 != end) & pv
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
    dtm = wmod.npz_region(tmp / "prep.npz", "dtm", region).astype(np.float64) - base
    F = fields(gt, water, bld, steps, dtm, deck)
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
