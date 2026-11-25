"""What the viewer knows per cell besides the voxels, into each node's file (tilefile.py sections), so that nothing of
the map's size is loaded whole: each node brings its own part with it, at its own cell size, and the shader reads it
from the nodes shown (web/src/fields.ts).

  bldg  the building of each cell, apron included (data/zones.bin, zones.py): the mesher never merges faces across
        buildings and gives each face its building (city.ts shows a building once all its tiles are in). At 2, 4, 8 m
        the building of the cell's middle column, else of the first column of it that has one (row by row)
  rivr  per cell, no apron, a bit: the river (data/river.bin, flood.py); at 2, 4, 8 m that of the cell's middle
        column. (flod, before it, is dropped from a node written before)
  fols  per cell, no apron: foliage class and tree (data/foliage.bin, phenology.py) of the 2 m cell the cell's middle
        column is in (at 1 m each 2 m cell's four columns alike)
  caps  (level 1) the sloped surfaces of paved ground and bridge decks (caps.py: from data/surface.npz, prep.npz,
        ground.npz and the node's own columns); none without data/surface.npz (data built before it)
  roof  (1, 2, 4, 8) the pitched roofs' surfaces (caps.py roof_section: from data/surface.npz's roof planes, the
        buildings and the level-1 nodes' tops over the window's core and 16 m round it)
  spil  per cell of twice the node's size (2 m at level 1, where it is made; 4, 8, 16 m above), apron included: the
        light of lit windows on the street before them, two kinds (spill_map), at the cell's middle (between the 2 m
        cells): it is a soft light, blurred over ~6 m, read bilinear
The tiles in tiles/1f (foliage) get none of it (their base tile's serves), only the container.

Window by window (window.py): a window's nodes from its region of the data/ maps (the core and HALO around it), read
as a stream, so the memory is a window's, not the map's; the files are the same for any cover of the map.

usage: uv run python scripts/tile_fields.py [--windows NXxNY | --window-size METRES] [-j N]   (after zones.py,
       flood.py, windows.py, phenology.py; again after voxelize.py or tiles_lod.py rewrote nodes; web/tools/tris.mjs
       needs bldg). -j N processes (default min(8, cores / 2)) over windows of 1024 m when no cover is given: ~35 s
       for the map instead of ~205 s in one window, under 1 GB a process instead of 12 GB; -j 1 without a cover: the
       whole map in one window
"""
import gzip
import json
import multiprocessing
import os
import sys
from pathlib import Path

import numpy as np

import caps
import tilefile
import window as wmod

OUT = Path("web/public/data")
TMP = Path("data")
# map cells around a window's core that a node's sections read: spil at level 8 reaches 10 m out (its apron of 16 m
# cells, the 2 m cells beside the middle), and what lights a 2 m cell lies within 8 m of it (the facade test beside
# it, the two blurs of 3 + 3 cells); bldg's apron 8 m; caps' corners depend on what lies within caps.REACH (71 m: the
# smoothing). The rest is the node's own cells. A multiple of 32 (the level-8 nodes' 16 m cells stay aligned)
HALO = 96
assert HALO >= caps.REACH + 1 and HALO % 32 == 0


def spill_map(kind1, W, D, at=(0, 0)):
    """Light from the windows on the street before them (formerly web/src/windows.ts, at load): each 2 m cell of a
    facade (a building's cell beside open ground) sends its light out over the cells around it, blurred twice (~4 and
    ~6 m: a tent), homes and hotels in a, offices and public buildings in b; the shader weighs the two by how many of
    each are lit now (uSpill) -- churches, none. kind1: per 1 m column the building's kind (windows.bin, 0: none), over
    the map or a region of it whose corner is map cell `at` (even); W, D: the map's size. Returns uint8 [h, w, 2] on
    the 2 m grid of kind1's cells: right where they are 8 m or more from the region's edges, or at the map's edge."""
    R, Cn = kind1.shape
    w, h = -(-Cn // 2), -(-R // 2)
    k1 = np.zeros((h * 2, w * 2), np.int8)
    k1[:R, :Cn] = kind1
    # per 2 m cell: the kind of its last building column in row order (-1: none)
    kind = np.full((h, w), -1, np.int8)
    for dy in (0, 1):
        for dx in (0, 1):
            v = k1[dy::2, dx::2]
            kind = np.where(v > 0, v, kind)
    # (not the map's outermost 2 m cells)
    gr, gc = np.arange(h) + at[0] // 2, np.arange(w) + at[1] // 2
    inner = ((gr >= 1) & (gr < -(-D // 2) - 1))[:, None] & ((gc >= 1) & (gc < -(-W // 2) - 1))[None, :]
    free = kind < 0
    opn = np.zeros((h, w), np.int8)
    opn[1:-1, 1:-1] = free[1:-1, :-2].astype(np.int8) + free[1:-1, 2:] + free[:-2, 1:-1] + free[2:, 1:-1]
    src = inner & (kind >= 0) & (kind != 6) & (opn > 0)
    off = np.isin(kind, (2, 4, 5, 7))
    a = np.where(src & ~off, np.minimum(opn, 2), 0).astype(np.float32)
    b = np.where(src & off, np.minimum(opn, 2), 0).astype(np.float32)

    def box(s, r, axis):
        # the mean over 2r + 1 cells along the axis, zero beyond the map (as the running sums did). The running sums
        # are exact (sums of float32 of a few bits over a few thousand cells, in float64): where the line starts does
        # not change them, so a region gives the map's values
        n = 2 * r + 1
        p = np.pad(s.astype(np.float64), [(r + 1, r) if k == axis else (0, 0) for k in range(2)])
        c = np.cumsum(p, axis=axis)
        hi = np.take(c, np.arange(n, n + s.shape[axis]), axis=axis)
        lo = np.take(c, np.arange(0, s.shape[axis]), axis=axis)
        return ((hi - lo) / n).astype(np.float32)

    out = np.zeros((h, w, 2), np.uint8)
    for k, s in enumerate((a, b)):
        for r in (1, 2):
            s = box(box(s, r, 1), r, 0)
        out[..., k] = np.minimum(255, np.floor(s.astype(np.float64) * 640)).astype(np.uint8)
    return out



def coarse_bld(z, s):
    """per s x s cell: the building of its middle column, else of its first column with one (row by row)"""
    if s == 1:
        return z
    D, W = z.shape
    Ds, Ws = -(-D // s), -(-W // s)
    p = np.zeros((Ds * s, Ws * s), z.dtype)
    p[:D, :W] = z
    blk = p.reshape(Ds, s, Ws, s).transpose(0, 2, 1, 3).reshape(Ds, Ws, s * s)
    h = s // 2
    mid = blk[:, :, h * s + h]
    nz = blk != 0
    first = np.take_along_axis(blk, nz.argmax(2)[..., None], 2)[..., 0]
    return np.where(mid != 0, mid, first)


def middle(a, s, fill):
    """per s x s cell: the value of its middle column (fill beyond the map)"""
    if s == 1:
        return a
    D, W = a.shape
    Ds, Ws = -(-D // s), -(-W // s)
    p = np.full((Ds * s, Ws * s), fill, a.dtype)
    p[:D, :W] = a
    return p[s // 2::s, s // 2::s]


def cut_node(a, r0, c0, n, fill):
    """a[r0:r0 + n, c0:c0 + n], fill beyond a"""
    out = np.full((n, n) + a.shape[2:], fill, a.dtype)
    ra, rb, ca, cb = max(r0, 0), min(r0 + n, a.shape[0]), max(c0, 0), min(c0 + n, a.shape[1])
    if ra < rb and ca < cb:
        out[ra - r0:rb - r0, ca - c0:cb - c0] = a[ra:rb, ca:cb]
    return out



def fields_window(win, levels, N, table, note=print, palette=None, base=None):
    """The sections of the nodes (every level in `levels`: meta.json tiles.levels) whose first row and column lie in the
    window's core, from the window's region of data/zones.bin, data/river.bin, data/foliage.bin; table: windows.bin.
    Returns {level: nodes written}."""
    D, W = win.D, win.W
    region = ra, rb, ca, cb = win.region(HALO)
    zones = wmod.gz_region(TMP / "zones.bin", (D, W), np.uint16, region)
    river = wmod.gz_region(TMP / "river.bin", (D, W), np.uint8, region)
    w2, h2 = W // 2, D // 2  # the foliage's 2 m grid
    f2 = (ra // 2, min(rb // 2, h2), ca // 2, min(cb // 2, w2))
    fcls = wmod.gz_region(TMP / "foliage.bin", (h2, w2), np.uint8, f2)
    ftree = wmod.gz_region(TMP / "foliage.bin", (h2, w2), np.uint8, f2, w2 * h2)
    light = spill_map(table[zones] & 7, W, D, (ra, ca))  # 2 m cells from (ra / 2, ca / 2)
    # the sloped caps' corners over the region (None: no data/surface.npz, no caps written)
    capf = caps.region_fields(region, D, W, base, TMP) if palette is not None else None
    deckable = caps.deck_ids(palette) if capf is not None else None
    cst = caps.Stats()
    # the roofs' corners (None: no data/surface.npz with roof_z, or caps.ROOFS off)
    roofs = caps.region_roofs(region, D, W, N, TMP, OUT / "tiles", palette, zones, (win.r0, win.r1, win.c0, win.c1)) if palette is not None else None
    L = light.astype(np.float32)
    S, M = N + 2, N // 2 + 2
    written = {}
    for lv in levels:
        s = lv["s"]
        Ds, Ws = -(-D // s), -(-W // s)
        oy, ox = ra // s, ca // s  # the region's corner at this level
        b = coarse_bld(zones, s)
        rv = middle(river, s, 0)
        # the window light on cells of 2s m: between the two 2 m cells around the middle (bilinear, clamped to the
        # map's edge); at 1 m the 2 m cells themselves
        hs, ws = (-(-D // 2), -(-W // 2)) if s == 1 else (-(-D // (2 * s)), -(-W // (2 * s)))

        def spil(r0, c0):
            gi, gj = np.clip(np.arange(r0, r0 + M), 0, hs - 1), np.clip(np.arange(c0, c0 + M), 0, ws - 1)
            if s == 1:
                return light[gi - ra // 2][:, gj - ca // 2]
            ri, ci = gi * s + s // 2, gj * s + s // 2
            y0, y1 = np.clip(ri - 1, 0, h2 - 1) - ra // 2, np.clip(ri, 0, h2 - 1) - ra // 2
            x0, x1 = np.clip(ci - 1, 0, w2 - 1) - ca // 2, np.clip(ci, 0, w2 - 1) - ca // 2
            assert min(y0.min(), x0.min()) >= 0 and y1.max() < L.shape[0] and x1.max() < L.shape[1], "halo too small"
            return np.floor((L[y0][:, x0] + L[y0][:, x1] + L[y1][:, x0] + L[y1][:, x1]) / 4 + 0.5).astype(np.uint8)

        def foliage(r0, c0):
            # per cell the 2 m cell its middle column is in (0 beyond the map and the foliage grid)
            i, j = np.arange(r0, r0 + N), np.arange(c0, c0 + N)
            fr, fc = (i * s + s // 2) >> 1, (j * s + s // 2) >> 1
            ok = ((i < Ds) & (fr < h2))[:, None] & ((j < Ws) & (fc < w2))[None, :]
            yr, xr = np.clip(fr - ra // 2, 0, fcls.shape[0] - 1), np.clip(fc - ca // 2, 0, fcls.shape[1] - 1)
            return np.stack([np.where(ok, fcls[yr][:, xr], 0), np.where(ok, ftree[yr][:, xr], 0)])

        n = 0
        for ty in range(win.r0 // (N * s), -(-win.r1 // (N * s))):
            for tx in range(win.c0 // (N * s), -(-win.c1 // (N * s))):
                if not win.holds(ty * N * s, tx * N * s):
                    continue
                f = OUT / "tiles" / str(s) / f"{tx}_{ty}.bin"
                if not f.exists():
                    continue
                sec = tilefile.read(f, N)
                sec["bldg"] = cut_node(b, ty * N - 1 - oy, tx * N - 1 - ox, S, 0).astype(np.uint16).tobytes()
                sec["rivr"] = np.packbits(cut_node(rv, ty * N - oy, tx * N - ox, N, 0) > 0, bitorder="little").tobytes()
                sec.pop("flod", None)  # (retired: a node written before rivr; tiles.py leaves unchanged nodes as they are)
                sec["fols"] = foliage(ty * N, tx * N).astype(np.uint8).tobytes()
                # (the apron beyond the map: the light as at the map's edge)
                sec["spil"] = spil(ty * (N // 2) - 1, tx * (N // 2) - 1).astype(np.uint8).transpose(2, 0, 1).tobytes()
                cb = caps.node_section(capf, sec, ty * N, tx * N, N, D, W, deckable, cst) if capf is not None and s == 1 else b""
                if cb:
                    sec["caps"] = cb
                else:
                    sec.pop("caps", None)
                rf = caps.roof_section(roofs, sec, ty * N, tx * N, N, D, W, s, cst) if roofs is not None else b""
                if rf:
                    sec["roof"] = rf
                else:
                    sec.pop("roof", None)
                tilefile.write(f, sec)
                n += 1
        written[s] = n
    nf = 0
    for ty in range(win.r0 // N, -(-win.r1 // N)):
        for tx in range(win.c0 // N, -(-win.c1 // N)):
            f = OUT / "tiles" / "1f" / f"{tx}_{ty}.bin"
            if f.exists():  # (into the container)
                tilefile.write(f, tilefile.read(f, N))
                nf += 1
    written["1f"] = nf
    note(f"window {win}: lit 2 m cells in the region {int((light > 0).any(2).sum())}, nodes {written}"
         + (f"; caps: {dict(cst)}" if capf is not None else "; caps: none (no data/surface.npz)"))
    return written


def _window_job(win):
    """fields_window in a worker of main's pool: its notes collected, for the parent to print in window order"""
    notes = []
    meta = _JOB["meta"]
    written = fields_window(win, meta["tiles"]["levels"], meta["tiles"]["N"], _JOB["table"],
                            lambda *a: notes.append(" ".join(map(str, a))), meta["palette"], meta["base"])
    return notes, written


_JOB = {}  # what the workers read (set before the pool forks)


def main():
    meta = json.loads((OUT / "meta.json").read_text())
    N, W, D = meta["tiles"]["N"], meta["W"], meta["D"]
    table = np.frombuffer(gzip.decompress((OUT / "windows.bin").read_bytes()), np.uint8)
    argv = sys.argv
    jobs = int(argv[argv.index("-j") + 1]) if "-j" in argv else min(8, max(1, (os.cpu_count() or 2) // 2))
    # the whole map in one window unless a cover is given, or windows of ALIGN in a pool of `jobs` processes: the same
    # bytes (each node belongs to the one window whose core holds its first cell; check.py windows), a window's memory
    if jobs > 1 and "--windows" not in argv and "--window-size" not in argv:
        wins = wmod.cover(D, W, wmod.ALIGN)
    else:
        wins = wmod.from_args(argv, D, W)
    jobs = max(1, min(jobs, len(wins)))
    total = {}

    def add(written):
        for k, v in written.items():
            total[k] = total.get(k, 0) + v
    if jobs == 1:
        for win in wins:
            add(fields_window(win, meta["tiles"]["levels"], N, table, lambda *a: print(*a, flush=True), meta["palette"], meta["base"]))
    else:
        _JOB.update(meta=meta, table=table)
        # fork: the workers share the parent's table and meta (Python 3.14 defaults to forkserver on Linux)
        with multiprocessing.get_context("fork").Pool(jobs) as pool:
            for notes, written in pool.imap(_window_job, wins, chunksize=1):  # (in window order)
                for n in notes:
                    print(n, flush=True)
                add(written)
    meta["tiles"]["bytes"] = sum(p.stat().st_size for lv in meta["tiles"]["levels"] for p in (OUT / "tiles" / str(lv["s"])).glob("*.bin"))
    print("nodes:", total, f"levels' nodes now {meta['tiles']['bytes'] / 2 ** 20:.2f} MB gz"
          + (f" ({len(wins)} windows, {jobs} processes)" if len(wins) > 1 else ""))
    (OUT / "meta.json").write_text(json.dumps(meta))


if __name__ == "__main__":
    main()
