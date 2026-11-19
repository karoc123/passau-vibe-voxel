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

--chunks: only cut the chunks again, from data/terrain.bin as it is (needs meta.json's W and D)
"""
import gzip
import json
import shutil
import sys
from pathlib import Path

import numpy as np

STEP = 4
CH = 256  # height samples to a chunk's side (and one more, shared with the next)
whole = Path("data/terrain.bin")
if "--chunks" not in sys.argv:
    from scipy import ndimage

    z = np.load("data/ground.npz")
    g = z["g"].astype(np.float32)
    # each vertex: the mean over the 4 m around it, so roads and squares stay, the 1 m terraces don't
    h = np.round(ndimage.uniform_filter(g, STEP)[::STEP, ::STEP] * 10).astype(np.uint16)
    c = np.ascontiguousarray(z["rgb"][1::2, 1::2])
    with gzip.GzipFile(whole, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(h.tobytes())
        fh.write(c.tobytes())
meta = json.loads(Path("web/public/data/meta.json").read_text())
W, D = meta["W"], meta["D"]
th, tw, ch, cw = -(-D // 4), -(-W // 4), D // 2, W // 2
buf = gzip.decompress(whole.read_bytes())
h = np.frombuffer(buf, np.uint16, th * tw).reshape(th, tw)
c = np.frombuffer(buf, np.uint8, ch * cw * 3, th * tw * 2).reshape(ch, cw, 3)

root = Path("web/public/data/terrain")
if root.exists():
    shutil.rmtree(root)


def write(path: Path, hs: np.ndarray, cs: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(np.array([hs.shape[1], hs.shape[0], cs.shape[1], cs.shape[0]], np.uint16).tobytes())
        fh.write(np.ascontiguousarray(hs).tobytes())
        fh.write(np.ascontiguousarray(cs).tobytes())
    return path.stat().st_size


def chunks(hs: np.ndarray, cs: np.ndarray, out: Path):
    """hs: the level's heights over the map (vertices), cs: its colours; chunks of CH height steps, 2 CH colours"""
    n, size = 0, 0
    for cy in range(0, max(1, (hs.shape[0] - 2) // CH + 1)):
        for cx in range(0, max(1, (hs.shape[1] - 2) // CH + 1)):
            hc = hs[cy * CH:cy * CH + CH + 1, cx * CH:cx * CH + CH + 1]
            cc = cs[cy * 2 * CH:(cy + 1) * 2 * CH, cx * 2 * CH:(cx + 1) * 2 * CH]
            size += write(out / f"{cx}_{cy}.bin", hc, cc)
            n += 1
    print(out.name, hs.shape, cs.shape[:2], n, "chunks", size // 1024, "KB")


chunks(h, c, root / "near")
k = 0
while True:
    f = 4 ** (k + 1)  # 4 m samples to a vertex, 2 m colours to a texel's side
    step = 16 * 4 ** k
    nc, nr = -(-W // step) + 1, -(-D // step) + 1
    hs = h[np.minimum(np.arange(nr) * f, th - 1)][:, np.minimum(np.arange(nc) * f, tw - 1)]
    wk, hk = cw // f, ch // f
    cs = (c[:hk * f, :wk * f].reshape(hk, f, wk, f, 3).astype(np.uint32).sum((1, 3)) // (f * f)).astype(np.uint8)
    chunks(hs, cs, root / f"far{k}")
    if CH * step >= max(W, D):
        break
    k += 1
