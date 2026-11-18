"""Rebuild the coarser tile levels (tiles.py LEVELS other than 1) from the level-1 tiles already in web/public/data,
without running voxelize.py again (which needs ~8 GB and the raw data): tiles/1 and tiles/1f together are the whole
finished volume (tiles/1 the city with grass as bare earth, tiles/1f trees, trunks and grass), their ground bytes
the ground level, tiles/1's trailing plane codes the roof planes. Level 1 itself is left as it is; meta.json's tile
manifest is updated.

usage: uv run python scripts/tiles_lod.py [--check]   (--check: only compare the rebuilt level 8 with the one there)
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np

import tiles

OUT = Path("web/public/data")
CLOCK = 14  # voxelMaterial.ts MAT.CLOCK (voxelize.py M_CLOCK)


def read_node(path, N, planes=False):
    buf = gzip.decompress(path.read_bytes())
    n2 = (N + 2) ** 2
    counts = np.frombuffer(buf, np.uint16, n2)
    ground = np.frombuffer(buf, np.uint8, n2, n2 * 2)
    nr = int(counts.sum())
    runs = np.frombuffer(buf, np.uint16, nr * 3, n2 * 3).reshape(-1, 3)
    pl = np.frombuffer(buf, np.uint16, n2, n2 * 3 + nr * 6) if planes and len(buf) >= n2 * 5 + nr * 6 else None
    return counts, ground, runs, pl


def paint(vol, counts, runs, N, r0, c0, keep_existing):
    """the node's own N x N columns (not the apron) into vol at rows r0.., cols c0.."""
    D, W = vol.shape[1:]
    if not len(runs):
        return
    col = np.repeat(np.arange(counts.size), counts.astype(np.int64))
    rr, cc = col // (N + 2) - 1, col % (N + 2) - 1
    k = (rr >= 0) & (rr < N) & (cc >= 0) & (cc < N) & (r0 + rr < D) & (c0 + cc < W)
    z0, ln, v = runs[k, 0].astype(np.int64), runs[k, 1].astype(np.int64), runs[k, 2]
    rr, cc = rr[k], cc[k]
    start = np.repeat(np.cumsum(ln) - ln, ln)
    z = np.repeat(z0, ln) + np.arange(int(ln.sum())) - start
    r, c, val = np.repeat(rr + r0, ln), np.repeat(cc + c0, ln), np.repeat(v, ln)
    if keep_existing:
        val = np.where(val != 0, val, vol[z, r, c])
    vol[z, r, c] = val


def main():
    meta = json.loads((OUT / "meta.json").read_text())
    N, W, D = meta["tiles"]["N"], meta["W"], meta["D"]
    l1 = next(l for l in meta["tiles"]["levels"] if l["s"] == 1)
    nodes = [(tx, ty) for ty in range(l1["ny"]) for tx in range(l1["nx"])]
    data = {}
    H = 1
    for tx, ty in nodes:
        b = read_node(OUT / "tiles" / "1" / f"{tx}_{ty}.bin", N, planes=True)
        f = read_node(OUT / "tiles" / "1f" / f"{tx}_{ty}.bin", N)
        data[tx, ty] = (b, f)
        for c in (b, f):
            if len(c[2]):
                H = max(H, int((c[2][:, 0].astype(np.int64) + c[2][:, 1]).max()))
    vol = np.zeros((H, D, W), np.uint16)
    g = np.zeros((D, W), np.int16)
    planes = np.zeros((D, W), np.uint16)
    for (tx, ty), (b, f) in data.items():
        r0, c0 = ty * N, tx * N
        h, w = min(N, D - r0), min(N, W - c0)
        paint(vol, b[0], b[2], N, r0, c0, False)
        paint(vol, f[0], f[2], N, r0, c0, True)  # grass over the bare earth it stands for, trees and trunks
        g[r0:r0 + h, c0:c0 + w] = b[1].reshape(N + 2, N + 2)[1:1 + h, 1:1 + w]
        planes[r0:r0 + h, c0:c0 + w] = b[3].reshape(N + 2, N + 2)[1:1 + h, 1:1 + w]
    del data
    print(f"volume {vol.shape} rebuilt from {len(nodes)} level-1 nodes", flush=True)
    face = {i for i, p in enumerate(meta["palette"]) if p[3] == CLOCK}

    tmp = Path("data/tiles_lod")
    if "--check" in sys.argv:
        levels = (8,)
    else:
        levels = tuple(s for s in tiles.LEVELS if s != 1)
    keep = tiles.LEVELS
    tiles.LEVELS = levels
    walls = [i for i, p in enumerate(meta["palette"]) if p[3] in tiles.WALL_MATS]
    info = tiles.export(vol, g, tmp if "--check" in sys.argv else OUT / "tiles", lambda *a: print(*a, flush=True), face_ids=face,
                        planes=planes, wall_ids=walls)
    tiles.LEVELS = keep
    if "--check" in sys.argv:
        same = sum((tmp / "8" / p.name).read_bytes() == p.read_bytes() for p in (OUT / "tiles" / "8").glob("*.bin"))
        print(f"level 8 rebuilt: {same} of {len(list((OUT / 'tiles' / '8').glob('*.bin')))} node files byte-identical")
        return
    lv = {1: l1}  # level 1 as it is; the others as just built (a level no longer in tiles.LEVELS goes)
    for l in info["levels"]:
        lv[l["s"]] = l
    meta["tiles"]["levels"] = [lv[s] for s in sorted(lv)]
    meta["tiles"]["bytes"] = sum(p.stat().st_size for s in lv for p in (OUT / "tiles" / str(s)).glob("*.bin"))
    (OUT / "meta.json").write_text(json.dumps(meta))
    print("meta.json tiles:", meta["tiles"])


if __name__ == "__main__":
    main()
