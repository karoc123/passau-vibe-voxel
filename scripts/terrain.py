"""Bare terrain, in chunks: the ground as the voxel tiles will show it (voxelize.py's ground height every 4 m, its top
colour every 2 m, grass as bare earth like the building tiles), so the viewer can show the land before any voxel tile
arrives (city.ts), and the coarse ground beyond the view distance (farground.ts). Each is cut into square chunks, so
the viewer fetches what is near the camera, never the whole map.

Input: data/ground.npz (voxelize.py). Output, each file gzip of a header of four uint16 (height columns and rows,
colour columns and rows), then the heights ([rows, cols] uint16, decimetres above the model base), then the colours
([rows, cols, 3] uint8 sRGB):
  web/public/data/terrain/near/{cx}_{cy}.bin  the first moment's ground, chunks of 1024 m: heights every 4 m (the
      vertex at x is the 4 m sample x / 4, cols = ceil(W / 4) over the map; a chunk holds its 257 x 257 samples, the
      last row and column shared with the next chunk), colours every 2 m (each the 1 m cell at the centre of its 2 m
      square: crisp, as the voxels), 512 x 512 per chunk; clipped at the map's edges
  web/public/data/terrain/far{k}/{cx}_{cy}.bin  the far ground at level k = 0, 1 ..: heights every 16 * 4^k m (the
      4 m sample at 4^(k+1) times the vertex's index, the last vertex at the map's edge), colours every 8 * 4^k m (the
      mean of the 2 m colours under it, rounded down), chunks of 4096 * 4^k m (257 x 257 heights, 512 x 512
      colours); levels up to the first whose one chunk covers the map (farground.ts picks them by distance)
  data/terrain.bin  the whole map as one file, for the pipeline's tools (web/tools/lamps.mjs), and the chunks' source:
      the 4 m heights, then the 2 m colours, no header

Window by window (window.py): a window's heights and colours from its region of data/ground.npz (the core and HALO
around it), its near chunks from them; the far levels are made from what every window adds to them (the heights on
their 16 m grid, the colours' sums over 8 m), the same bytes for any cover of the map.

usage: uv run python scripts/terrain.py [--chunks] [--windows NXxNY | --window-size METRES]
--chunks: only cut the chunks again, from data/terrain.bin as it is (needs meta.json's W and D)
"""
import gzip
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

import window as wmod
from aoi import BOXES

STEP = 4
CH = 256  # height samples to a chunk's side (and one more, shared with the next)
# map cells around a window's core: a near chunk holds the first 4 m sample of the next (4 m), and a sample is the
# mean over the 4 m round it (2 m)
HALO = 8
whole = Path("data/terrain.bin")
root = Path("web/public/data/terrain")


def write(path: Path, hs: np.ndarray, cs: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(np.array([hs.shape[1], hs.shape[0], cs.shape[1], cs.shape[0]], np.uint16).tobytes())
        fh.write(np.ascontiguousarray(hs).tobytes())
        fh.write(np.ascontiguousarray(cs).tobytes())
    return path.stat().st_size


def n_chunks(n):
    """chunks along a side of n height samples (each CH steps; none starts at the last sample)"""
    return max(1, (n - 2) // CH + 1)


def chunks(hs: np.ndarray, cs: np.ndarray, out: Path):
    """hs: the level's heights over the map (vertices), cs: its colours; chunks of CH height steps, 2 CH colours"""
    n, size = 0, 0
    for cy in range(n_chunks(hs.shape[0])):
        for cx in range(n_chunks(hs.shape[1])):
            hc = hs[cy * CH:cy * CH + CH + 1, cx * CH:cx * CH + CH + 1]
            cc = cs[cy * 2 * CH:(cy + 1) * 2 * CH, cx * 2 * CH:(cx + 1) * 2 * CH]
            size += write(out / f"{cx}_{cy}.bin", hc, cc)
            n += 1
    print(out.name, hs.shape, cs.shape[:2], n, "chunks", size // 1024, "KB")


class Far:
    """what the far levels need of the map, filled window by window: the 4 m heights on rows and columns that are
    multiples of 4 or the last one (the far levels' vertices: the sample at 4^(k+1) times the index, the last at the
    map's edge), and the 2 m colours' sums over 4 x 4 (8 m, the far levels' texels are made of them)"""

    def __init__(self, th, tw, ch, cw):
        self.th, self.tw, self.ch, self.cw = th, tw, ch, cw
        self.ri = np.unique(np.r_[np.arange(0, th, 4), th - 1])
        self.ci = np.unique(np.r_[np.arange(0, tw, 4), tw - 1])
        self.h = np.zeros((len(self.ri), len(self.ci)), np.uint16)
        self.s8 = np.zeros((ch // 4, cw // 4, 3), np.uint64)

    def add(self, h, hr, c, cr):
        """h: 4 m heights of a window's core from 4 m row / column hr = (r, c); c: 2 m colours from cr = (r, c),
        whole 8 m blocks"""
        y = (self.ri >= hr[0]) & (self.ri < hr[0] + h.shape[0])
        x = (self.ci >= hr[1]) & (self.ci < hr[1] + h.shape[1])
        self.h[np.ix_(y, x)] = h[np.ix_(self.ri[y] - hr[0], self.ci[x] - hr[1])]
        by, bx = cr[0] // 4, cr[1] // 4
        nb, nx = min(c.shape[0] // 4, self.s8.shape[0] - by), min(c.shape[1] // 4, self.s8.shape[1] - bx)
        if nb > 0 and nx > 0:
            blk = c[:nb * 4, :nx * 4].reshape(nb, 4, nx, 4, 3).astype(np.uint64).sum((1, 3))
            self.s8[by:by + nb, bx:bx + nx] = blk

    def level(self, k, W, D):
        """level k's heights and colours over the map"""
        f = 4 ** (k + 1)  # 4 m samples to a vertex, 2 m colours to a texel's side
        step = 16 * 4 ** k
        nc, nr = -(-W // step) + 1, -(-D // step) + 1
        rows = np.searchsorted(self.ri, np.minimum(np.arange(nr) * f, self.th - 1))
        cols = np.searchsorted(self.ci, np.minimum(np.arange(nc) * f, self.tw - 1))
        hs = self.h[rows][:, cols]
        wk, hk, b = self.cw // f, self.ch // f, f // 4
        s = self.s8[:hk * b, :wk * b].reshape(hk, b, wk, b, 3).sum((1, 3))
        cs = (s // (f * f)).astype(np.uint8)
        return hs, cs


def main():
    meta = json.loads(Path("web/public/data/meta.json").read_text())
    W, D = meta["W"], meta["D"]
    th, tw, ch, cw = -(-D // 4), -(-W // 4), D // 2, W // 2
    rebuild = "--chunks" not in sys.argv
    if rebuild:
        from scipy import ndimage
    if root.exists():
        shutil.rmtree(root)
    far = Far(th, tw, ch, cw)
    hw = np.zeros((th, tw), np.uint16) if rebuild else None  # the whole map's heights for data/terrain.bin (1/16 of
    # the map's cells), its colours go row band by row band through a temporary file
    tmp = tempfile.TemporaryFile(dir="data") if rebuild else None
    crow = wmod.RowWriter(tmp, cw, np.uint8, (3,)) if rebuild else None
    nn, size = 0, 0
    for win in wmod.from_args(sys.argv, D, W, BOXES):
        ra, rb, ca, cb = win.region(HALO)
        h4 = (ra // 4, -(-rb // 4), ca // 4, -(-cb // 4))  # the region's 4 m samples
        c2 = (ra // 2, min(rb // 2, ch), ca // 2, min(cb // 2, cw))  # its 2 m colours
        if rebuild:
            g = wmod.npz_region("data/ground.npz", "g", (ra, rb, ca, cb)).astype(np.float32)
            # each vertex: the mean over the 4 m around it, so roads and squares stay, the 1 m terraces don't
            h = np.round(ndimage.uniform_filter(g, STEP)[::STEP, ::STEP] * 10).astype(np.uint16)
            built = win.built((ra, rb, ca, cb))
            if built is not None:  # (a sample in an empty block: 0, no ground; the viewer leaves it out)
                h[~built[::STEP, ::STEP]] = 0
            rgb = wmod.npz_region("data/ground.npz", "rgb", (ra, rb, ca, cb))
            c = np.ascontiguousarray(rgb[1::2, 1::2])[:c2[1] - c2[0], :c2[3] - c2[2]]
        else:
            h = wmod.gz_region(whole, (th, tw), np.uint16, h4)
            c = wmod.gz_region(whole, (ch, cw, 3), np.uint8, c2, th * tw * 2)
        # the core's part
        hc = (win.r0 // 4 - h4[0], -(-win.r1 // 4) - h4[0], win.c0 // 4 - h4[2], -(-win.c1 // 4) - h4[2])
        cc = (win.r0 // 2 - c2[0], min(win.r1 // 2, ch) - c2[0], win.c0 // 2 - c2[2], min(win.c1 // 2, cw) - c2[2])
        core_h, core_c = h[hc[0]:hc[1], hc[2]:hc[3]], c[cc[0]:cc[1], cc[2]:cc[3]]
        far.add(core_h, (win.r0 // 4, win.c0 // 4), core_c, (win.r0 // 2, win.c0 // 2))
        if rebuild:
            hw[win.r0 // 4:win.r0 // 4 + core_h.shape[0], win.c0 // 4:win.c0 // 4 + core_h.shape[1]] = core_h
            crow.put(win.r0 // 2, win.c0 // 2, core_c)
        # the near chunks (1024 m: the windows' grid) whose corner lies in the core
        for cy in range(n_chunks(th)):
            for cx in range(n_chunks(tw)):
                if not win.holds(cy * CH * STEP, cx * CH * STEP):
                    continue
                y, x = cy * CH - h4[0], cx * CH - h4[2]
                hs = h[y:y + CH + 1, x:x + CH + 1]
                assert hs.shape == (min(CH + 1, th - cy * CH), min(CH + 1, tw - cx * CH)), "halo too small"
                y, x = cy * 2 * CH - c2[0], cx * 2 * CH - c2[2]
                size += write(root / "near" / f"{cx}_{cy}.bin", hs, c[y:y + 2 * CH, x:x + 2 * CH])
                nn += 1
    print("near", (th, tw), (ch, cw), nn, "chunks", size // 1024, "KB")
    if rebuild:
        crow.finish(ch)
        tmp.seek(0)
        with gzip.GzipFile(whole, "wb", compresslevel=9, mtime=0) as fh:
            fh.write(hw.tobytes())
            shutil.copyfileobj(tmp, fh)
        tmp.close()
    k = 0
    while True:
        hs, cs = far.level(k, W, D)
        chunks(hs, cs, root / f"far{k}")
        if CH * 16 * 4 ** k >= max(W, D):
            break
        k += 1


if __name__ == "__main__":
    main()
