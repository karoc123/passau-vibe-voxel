"""Rebuild the coarser tile levels (tiles.py LEVELS other than 1) from the level-1 tiles already in web/public/data,
without running voxelize.py again (which needs ~8 GB and the raw data): tiles/1 and tiles/1f together are the whole
finished volume (tiles/1 the city with grass as bare earth, tiles/1f trees, trunks and grass), their ground bytes
the ground level, tiles/1's trailing plane codes the roof planes, their room sections the rooms (interiors.py: filled
again for the coarser levels, as voxelize.py's export does). Level 1 itself is left as it is; meta.json's tile
manifest is updated.

Window by window (window.py): each window's nodes from the level-1 nodes over its region (the core and
tiles.HALO around it), so the memory is a window's, not the map's; the files are the same for any cover.

usage: uv run python scripts/tiles_lod.py [--check] [--windows NXxNY | --window-size METRES]   (levels 2, 4 and 8,
      ~2 min; --check: only compare the rebuilt level 8 with the one there). The rebuilt nodes lack the per-cell
      sections: run scripts/tile_fields.py after it.
"""
import json
import sys
from pathlib import Path

import numpy as np

import tilefile
from constants import M_CLOCK
import tiles
import window

OUT = Path("web/public/data")


def read_node(path, N, planes=False):
    """counts, ground, runs, roof planes (or None) and room spans ((n, 4): column, z0, len, fill; empty without) of a
    node"""
    sec = tilefile.read(path, N)
    counts = np.frombuffer(sec["cnts"], np.uint16)
    ground = np.frombuffer(sec["grnd"], np.uint8)
    runs = np.frombuffer(sec["runs"], np.uint16).reshape(-1, 3)
    pl = np.frombuffer(sec["plns"], np.uint16) if planes and "plns" in sec else None
    rooms = np.frombuffer(sec.get("room", b""), np.uint16).reshape(-1, 4)
    return counts, ground, runs, pl, rooms


def own_rooms(rooms, N, r0, c0):
    """a node's room spans (read_node) in its own N x N columns (not the apron), as interiors.runs() gives them: (row,
    col, z0, len, fill) with the node's first own row and column at r0, c0"""
    col = rooms[:, 0].astype(np.int64)
    rr, cc = col // (N + 2) - 1, col % (N + 2) - 1
    k = (rr >= 0) & (rr < N) & (cc >= 0) & (cc < N)
    return np.stack([rr[k] + r0, cc[k] + c0, *(rooms[k, j].astype(np.int64) for j in (1, 2, 3))], 1)


def paint(vol, counts, runs, N, r0, c0, keep_existing):
    """the node's own N x N columns (not the apron) into vol at rows r0.., cols c0.. (what falls outside vol is left
    out)"""
    D, W = vol.shape[1:]
    if not len(runs):
        return
    col = np.repeat(np.arange(counts.size), counts.astype(np.int64))
    rr, cc = col // (N + 2) - 1, col % (N + 2) - 1
    k = (rr >= 0) & (rr < N) & (cc >= 0) & (cc < N) & (r0 + rr >= 0) & (r0 + rr < D) & (c0 + cc >= 0) & (c0 + cc < W)
    z0, ln, v = runs[k, 0].astype(np.int64), runs[k, 1].astype(np.int64), runs[k, 2]
    rr, cc = rr[k], cc[k]
    start = np.repeat(np.cumsum(ln) - ln, ln)
    z = np.repeat(z0, ln) + np.arange(int(ln.sum())) - start
    r, c, val = np.repeat(rr + r0, ln), np.repeat(cc + c0, ln), np.repeat(v, ln)
    if keep_existing:
        val = np.where(val != 0, val, vol[z, r, c])
    vol[z, r, c] = val


def paste(dst, node, N, r0, c0):
    """the node's own N x N cells (node: its (N + 2)^2 values, apron included) into dst at rows r0.., cols c0..,
    clipped to dst"""
    a = node.reshape(N + 2, N + 2)[1:-1, 1:-1]
    ya, yb, xa, xb = max(r0, 0), min(r0 + N, dst.shape[0]), max(c0, 0), min(c0 + N, dst.shape[1])
    if ya < yb and xa < xb:
        dst[ya:yb, xa:xb] = a[ya - r0:yb - r0, xa - c0:xb - c0]


def region_volume(src, N, region, boxes=None):
    """the finished level-1 volume, ground, roof planes and rooms (interiors.runs()' spans, in the region's rows and
    columns) over region (ra, rb, ca, cb) from the level-1 nodes (src: the tiles folder; boxes: the built blocks,
    window.Window.boxes: a block not built has no nodes, it is empty)"""
    ra, rb, ca, cb = region
    nodes = [(tx, ty) for ty in range(ra // N, -(-rb // N)) for tx in range(ca // N, -(-cb // N)) if tiles.has_node(1, tx, ty, boxes)]
    data, H = {}, 1
    for tx, ty in nodes:
        b = read_node(src / "1" / f"{tx}_{ty}.bin", N, planes=True)
        f = read_node(src / "1f" / f"{tx}_{ty}.bin", N)
        data[tx, ty] = (b, f)
        for c in (b, f):
            if len(c[2]):
                H = max(H, int((c[2][:, 0].astype(np.int64) + c[2][:, 1]).max()))
    vol = np.zeros((H, rb - ra, cb - ca), np.uint16)
    g = np.zeros((rb - ra, cb - ca), np.int16)
    planes = np.zeros((rb - ra, cb - ca), np.uint16)
    rooms = []
    for (tx, ty), (b, f) in data.items():
        r0, c0 = ty * N - ra, tx * N - ca
        paint(vol, b[0], b[2], N, r0, c0, False)
        paint(vol, f[0], f[2], N, r0, c0, True)  # grass over the bare earth it stands for, trees and trunks
        paste(g, b[1], N, r0, c0)
        paste(planes, b[3], N, r0, c0)
        rooms.append(own_rooms(b[4], N, r0, c0))
    rooms = np.concatenate(rooms) if rooms else np.zeros((0, 5), np.int64)
    rooms = rooms[(rooms[:, 0] >= 0) & (rooms[:, 0] < rb - ra) & (rooms[:, 1] >= 0) & (rooms[:, 1] < cb - ca)]
    return vol, g, planes, rooms[np.lexsort((rooms[:, 2], rooms[:, 1], rooms[:, 0]))]


def main():
    meta = json.loads((OUT / "meta.json").read_text())
    N, W, D = meta["tiles"]["N"], meta["W"], meta["D"]
    l1 = next(l for l in meta["tiles"]["levels"] if l["s"] == 1)
    face = {i for i, p in enumerate(meta["palette"]) if p[3] == M_CLOCK}
    walls = [i for i, p in enumerate(meta["palette"]) if p[3] in tiles.WALL_MATS]
    check = "--check" in sys.argv
    tmp = Path("data/tiles_lod")
    dst = tmp if check else OUT / "tiles"
    levels = (8,) if check else tuple(s for s in tiles.LEVELS if s != 1)
    note = lambda *a: print(*a, flush=True)
    man = tiles.manifest(D, W, levels)
    boxes = window.boxes_of(dict(meta=meta["built"]) if "built" in meta else None)
    tiles.remove_stale(dst, man, note, split=False, boxes=boxes)
    windows = window.from_args(sys.argv, D, W, boxes)
    for w in windows:
        region = w.region(tiles.HALO)
        vol, g, planes, rooms = region_volume(OUT / "tiles", N, region, boxes)
        st = tiles.export_window(vol, g, planes, region, w, dst, face_ids=face, wall_ids=walls, levels=levels, rooms=rooms)
        print(f"window {w}: volume {vol.shape}, nodes written:",
              {s: f"{v[0] / 2 ** 20:.1f} MB" for s, v in st.items()}, flush=True)
        del vol, g, planes, rooms
    if check:
        voxels = lambda p: {k: v for k, v in tilefile.read(p, N).items() if k in ("cnts", "grnd", "runs", "plns")}
        same = sum(voxels(tmp / "8" / p.name) == voxels(p) for p in (OUT / "tiles" / "8").glob("*.bin"))
        print(f"level 8 rebuilt: {same} of {len(list((OUT / 'tiles' / '8').glob('*.bin')))} node files with identical voxels")
        return
    lv = {1: l1}  # level 1 as it is; the others as just built (a level no longer in tiles.LEVELS goes)
    for l in man:
        lv[l["s"]] = l
    meta["tiles"]["levels"] = [lv[s] for s in sorted(lv)]
    meta["tiles"]["bytes"] = sum(p.stat().st_size for s in lv for p in (OUT / "tiles" / str(s)).glob("*.bin"))
    meta["tiles"].pop("tris", None)  # the tiles' triangles, now stale: web/tools/tris.mjs counts them again
    (OUT / "meta.json").write_text(json.dumps(meta))
    print("meta.json tiles:", meta["tiles"])


if __name__ == "__main__":
    main()
