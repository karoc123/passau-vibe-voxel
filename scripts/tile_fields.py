"""What the viewer knows per cell besides the voxels, into each node's file (tilefile.py sections), so that nothing of
the map's size is loaded whole: each node brings its own part with it, at its own cell size, and the shader reads it
from the nodes shown (web/src/fields.ts).

  bldg  the building of each cell, apron included (data/zones.bin, zones.py): the mesher never merges faces across
        buildings and gives each face its building (city.ts shows a building once all its tiles are in). At 2, 4, 8 m
        the building of the cell's middle column, else of the first column of it that has one (row by row)
  flod  per cell, no apron: the level at which the river reaches it (255: never) and the river bed in decimetres
        (data/flood.bin, flood.py); at 2, 4, 8 m those of the cell's middle column
  fols  per cell, no apron: foliage class and tree (data/foliage.bin, phenology.py) of the 2 m cell the cell's middle
        column is in (at 1 m each 2 m cell's four columns alike)
  spil  per cell of twice the node's size (2 m at level 1, where it is made; 4, 8, 16 m above), apron included: the
        light of lit windows on the street before them, two kinds (spill_map), at the cell's middle (between the 2 m
        cells): it is a soft light, blurred over ~6 m, read bilinear
The tiles in tiles/1f (foliage) get none of it (their base tile's serves), only the container.

usage: uv run python scripts/tile_fields.py   (after zones.py, flood.py, windows.py, phenology.py; again after
       voxelize.py or tiles_lod.py rewrote nodes; web/tools/tris.mjs needs bldg)
"""
import gzip
import json
from pathlib import Path

import numpy as np

import tilefile

OUT = Path("web/public/data")
TMP = Path("data")


def spill_map(kind1, W, D):
    """Light from the windows on the street before them (formerly web/src/windows.ts, at load): each 2 m cell of a
    facade (a building's cell beside open ground) sends its light out over the cells around it, blurred twice (~4 and
    ~6 m: a tent), homes and hotels in a, offices and public buildings in b; the shader weighs the two by how many of
    each are lit now (uSpill) -- churches, none. kind1: per 1 m column the building's kind (windows.bin, 0: none).
    Returns uint8 [h, w, 2] on the 2 m grid."""
    w, h = -(-W // 2), -(-D // 2)
    k1 = np.zeros((h * 2, w * 2), np.int8)
    k1[:D, :W] = kind1
    # per 2 m cell: the kind of its last building column in row order (-1: none)
    kind = np.full((h, w), -1, np.int8)
    for dy in (0, 1):
        for dx in (0, 1):
            v = k1[dy::2, dx::2]
            kind = np.where(v > 0, v, kind)
    inner = np.zeros((h, w), bool)
    inner[1:-1, 1:-1] = True
    free = kind < 0
    opn = np.zeros((h, w), np.int8)
    opn[1:-1, 1:-1] = free[1:-1, :-2].astype(np.int8) + free[1:-1, 2:] + free[:-2, 1:-1] + free[2:, 1:-1]
    src = inner & (kind >= 0) & (kind != 6) & (opn > 0)
    off = np.isin(kind, (2, 4, 5, 7))
    a = np.where(src & ~off, np.minimum(opn, 2), 0).astype(np.float32)
    b = np.where(src & off, np.minimum(opn, 2), 0).astype(np.float32)

    def box(s, r, axis):
        # the mean over 2r + 1 cells along the axis, zero beyond the map (as the running sums did)
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


def window(a, r0, c0, n, fill):
    """a[r0:r0 + n, c0:c0 + n], fill beyond a"""
    out = np.full((n, n) + a.shape[2:], fill, a.dtype)
    ra, rb, ca, cb = max(r0, 0), min(r0 + n, a.shape[0]), max(c0, 0), min(c0 + n, a.shape[1])
    if ra < rb and ca < cb:
        out[ra - r0:rb - r0, ca - c0:cb - c0] = a[ra:rb, ca:cb]
    return out


def main():
    meta = json.loads((OUT / "meta.json").read_text())
    N, W, D = meta["tiles"]["N"], meta["W"], meta["D"]
    zones = np.frombuffer(gzip.decompress((TMP / "zones.bin").read_bytes()), np.uint16).reshape(D, W)
    table = np.frombuffer(gzip.decompress((OUT / "windows.bin").read_bytes()), np.uint8)
    fb = np.frombuffer(gzip.decompress((TMP / "flood.bin").read_bytes()), np.uint8)
    spill_h, bed = fb[:W * D].reshape(D, W), fb[W * D:].reshape(D, W)
    fol = np.frombuffer(gzip.decompress((TMP / "foliage.bin").read_bytes()), np.uint8)
    w2, h2 = W // 2, D // 2
    fcls, ftree = fol[:w2 * h2].reshape(h2, w2), fol[w2 * h2:].reshape(h2, w2)
    light = spill_map(table[zones] & 7, W, D)  # (h2, w2, 2) for even W, D
    print(f"spill: {int((light > 0).any(2).sum())} cells of 2 m lit", flush=True)

    S, M = N + 2, N // 2 + 2
    total = 0
    for lv in meta["tiles"]["levels"]:
        s = lv["s"]
        b = coarse_bld(zones, s)
        fs, fd = middle(spill_h, s, 255), middle(bed, s, 0)
        # foliage per cell: the 2 m cell of its middle column
        Ds, Ws = -(-D // s), -(-W // s)
        fr, fc = (np.arange(Ds) * s + s // 2) >> 1, (np.arange(Ws) * s + s // 2) >> 1
        fok = (fr[:, None] < h2) & (fc[None, :] < w2)
        sc = np.where(fok, fcls[np.minimum(fr, h2 - 1)][:, np.minimum(fc, w2 - 1)], 0)
        st = np.where(fok, ftree[np.minimum(fr, h2 - 1)][:, np.minimum(fc, w2 - 1)], 0)
        # the window light on cells of 2s m: between the two 2 m cells around the middle (bilinear, clamped to the
        # map's edge)
        if s == 1:
            sl = light
        else:
            hs, ws = -(-D // (2 * s)), -(-W // (2 * s))
            ri, ci = np.arange(hs) * s + s // 2, np.arange(ws) * s + s // 2
            r0, r1 = np.clip(ri - 1, 0, h2 - 1), np.clip(ri, 0, h2 - 1)
            c0, c1 = np.clip(ci - 1, 0, w2 - 1), np.clip(ci, 0, w2 - 1)
            L = light.astype(np.float32)
            sl = np.floor((L[r0][:, c0] + L[r0][:, c1] + L[r1][:, c0] + L[r1][:, c1]) / 4 + 0.5).astype(np.uint8)

        n = 0
        for ty in range(lv["ny"]):
            for tx in range(lv["nx"]):
                f = OUT / "tiles" / str(s) / f"{tx}_{ty}.bin"
                if not f.exists():
                    continue
                sec = tilefile.read(f, N)
                sec["bldg"] = window(b, ty * N - 1, tx * N - 1, S, 0).astype(np.uint16).tobytes()
                fl = np.stack([window(fs, ty * N, tx * N, N, 255), window(fd, ty * N, tx * N, N, 0)])  # (planar: packs smaller)
                sec["flod"] = fl.astype(np.uint8).tobytes()
                fo = np.stack([window(sc, ty * N, tx * N, N, 0), window(st, ty * N, tx * N, N, 0)])
                sec["fols"] = fo.astype(np.uint8).tobytes()
                # (the apron beyond the map: the light as at the map's edge)
                r0, c0 = ty * (N // 2) - 1, tx * (N // 2) - 1
                rr, cc = np.clip(np.arange(r0, r0 + M), 0, sl.shape[0] - 1), np.clip(np.arange(c0, c0 + M), 0, sl.shape[1] - 1)
                sec["spil"] = sl[rr][:, cc].astype(np.uint8).transpose(2, 0, 1).tobytes()
                tilefile.write(f, sec)
                total += f.stat().st_size
                n += 1
        print(f"level {s}: {n} nodes", flush=True)
    n = 0
    for f in sorted((OUT / "tiles" / "1f").glob("*.bin")):
        tilefile.write(f, tilefile.read(f, N))
        n += 1
    print(f"1f: {n} nodes in the container; levels' nodes now {total / 2 ** 20:.2f} MB gz")
    meta["tiles"]["bytes"] = sum(p.stat().st_size for lv in meta["tiles"]["levels"] for p in (OUT / "tiles" / str(lv["s"])).glob("*.bin"))
    (OUT / "meta.json").write_text(json.dumps(meta))


if __name__ == "__main__":
    main()
