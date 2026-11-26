"""Mosaic the Bavarian DOM20 surface model (0.2 m), DGM1 terrain (1 m) and DOP20 orthophoto (scripts/fetch_bayern.sh),
then resample onto the AOI grid (scripts/aoi.py).

Outputs (row 0 = grid row 0): data/prep.npz dsm at 0.5 m, dtm at 1 m, cellcol (uint8 RGB at 1 m: the median of each
cell's 5 x 5 ortho pixels, per channel); data/orto.npy the orthophoto at 0.2 m (for scripts/look.py; no step of the
build reads it), data/orto_preview.jpg.
"""
import glob
import math
import mmap
import multiprocessing
import os
import time

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.windows import from_bounds
from scipy import ndimage

from aoi import D, RAW, W, to_world, world_bounds

MINX, MINY, MAXX, MAXY = (round(v) for v in world_bounds(margin=10))
_T = [time.time()]


def tick(what):
    """the seconds since the last tick (the step's phases: what to make faster)"""
    t = time.time()
    print(f"[{t - _T[0]:5.1f} s] {what}", flush=True)
    _T[0] = t


def mosaic(pattern, res, nodata=-9999):
    """Mosaic on the sheets' own pixel grid (bounds snapped to it), so merging copies pixels instead of resampling.
    With integer-metre bounds every output pixel centre fell exactly between two source pixels (sheets can be
    offset by half a pixel), and nearest-neighbour broke the tie by float noise: an arbitrary half-pixel jitter."""
    srcs = [rasterio.open(p) for p in sorted(glob.glob(f"{RAW}/{pattern}"))]
    t = srcs[0].transform
    snap = lambda v, o: o + math.floor((v - o) / res) * res
    b = (snap(MINX, t.c), snap(MINY, t.f), snap(MAXX, t.c) + res, snap(MAXY, t.f) + res)
    arr, tr = merge(srcs, bounds=b, res=res, resampling=Resampling.nearest, nodata=nodata, target_aligned_pixels=False)
    return arr, tr


def mosaic_rgb(pattern, res):
    # sheets can carry slightly different WKT for the same CRS, so paste windows manually
    out = np.zeros((round((MAXY - MINY) / res), round((MAXX - MINX) / res), 3), np.uint8)
    for p in sorted(glob.glob(f"{RAW}/{pattern}")):
        with rasterio.open(p) as r:
            b = r.bounds
            l, bo, rt, t = max(b.left, MINX), max(b.bottom, MINY), min(b.right, MAXX), min(b.top, MAXY)
            if l >= rt or bo >= t:
                continue
            c0, c1 = round((l - MINX) / res), round((rt - MINX) / res)
            r0, r1 = round((MAXY - t) / res), round((MAXY - bo) / res)
            win = from_bounds(MINX + c0 * res, MAXY - r1 * res, MINX + c1 * res, MAXY - r0 * res, r.transform)
            a = r.read([1, 2, 3], window=win, out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.average, boundless=True, fill_value=0)
            a = np.moveaxis(a, 0, -1)
            m = a.sum(-1) > 0
            out[r0:r1, c0:c1][m] = a[m]
    return out


def coords(j0, j1, ni, src_res, out_res, origin=None):
    """(row, col) in the source raster (north-up, origin MINX/MAXY or `origin`) of the output rows j0..j1's pixel
    centres on the rotated grid, float64"""
    jj, ii = np.mgrid[j0:j1, 0:ni].astype(np.float64)
    x, y = to_world((ii + 0.5) * out_res, (jj + 0.5) * out_res)
    ox, oy = origin or (MINX, MAXY)
    return (oy - y) / src_res - 0.5, (x - ox) / src_res - 0.5


def resample(src, src_res, out_res, order, band=1024, origin=None):
    """Sample an axis-aligned (north-up, origin MINX/MAXY) raster on the rotated grid (in row bands: a
    large AOI at 0.2 m would need gigabytes of float64 coordinates in one go)."""
    nj, ni = round(D / out_res), round(W / out_res)
    out = np.empty((nj, ni) + src.shape[2:], src.dtype)
    for j0 in range(0, nj, band):
        row, col = coords(j0, min(j0 + band, nj), ni, src_res, out_res, origin)
        if src.ndim == 2:
            out[j0:j0 + band] = ndimage.map_coordinates(src, [row, col], order=order, mode="nearest")
        else:
            for k in range(src.shape[-1]):
                out[j0:j0 + band, :, k] = ndimage.map_coordinates(src[..., k], [row, col], order=order, mode="nearest")
    return out


FILL_NEAR = 40  # m: a cell of the terrain model's gap no laser return of ground or water fell in takes the nearest filled one's


def fill_dtm(dtm):
    """DGM1 ends at the Bavarian border (the Inn's Austrian bank above the Innstadt has no terrain model; the surface
    model, the orthophoto and the laser scan go on): its cells without data take the mean of the laser's ground returns
    and water (class 2, 9: as DGM1 has the river's surface) in them, then the nearest such cell's within FILL_NEAR m. In place; returns the cells filled and those left"""
    gap = dtm < -1000
    if not gap.any():
        return 0, 0
    import laspy
    from aoi import to_grid
    s, n = np.zeros(dtm.shape), np.zeros(dtm.shape, np.int64)
    rr, cc = np.nonzero(gap)
    for p in sorted(glob.glob(f"{RAW}/laser/*.laz")):
        with laspy.open(p) as f:
            h = f.header
            c0, r1 = to_grid(h.mins[0], h.mins[1])
            c1, r0 = to_grid(h.maxs[0], h.maxs[1])
            if not ((rr >= r0 - 1) & (rr <= r1 + 1) & (cc >= c0 - 1) & (cc <= c1 + 1)).any():
                continue
            pts = f.read()
        g = np.isin(np.asarray(pts.classification), (2, 9))
        c, r = to_grid(np.asarray(pts.x)[g], np.asarray(pts.y)[g])
        r, c, z = np.floor(r).astype(np.int64), np.floor(c).astype(np.int64), np.asarray(pts.z)[g]
        k = (r >= 0) & (r < dtm.shape[0]) & (c >= 0) & (c < dtm.shape[1])
        r, c, z = r[k], c[k], z[k]
        k = gap[r, c]
        np.add.at(s, (r[k], c[k]), z[k])
        np.add.at(n, (r[k], c[k]), 1)
    hit = n > 0
    dtm[hit] = (s[hit] / n[hit]).astype(dtm.dtype)
    if hit.any():  # (in the box of the cells filled: the gap beyond the sheets fetched is the map's empty blocks)
        hr, hc = np.nonzero(hit)
        ra, rb = max(hr.min() - FILL_NEAR, 0), min(hr.max() + FILL_NEAR + 1, dtm.shape[0])
        ca, cb = max(hc.min() - FILL_NEAR, 0), min(hc.max() + FILL_NEAR + 1, dtm.shape[1])
        sub = dtm[ra:rb, ca:cb]
        left = (gap & ~hit)[ra:rb, ca:cb]
        dist, (ir, ic) = ndimage.distance_transform_edt(sub < -1000, return_indices=True)
        near = left & (dist <= FILL_NEAR)
        sub[near] = sub[ir[near], ic[near]]
    return int(gap.sum() - (dtm < -1000).sum()), int((dtm < -1000).sum())


S = 5  # ortho pixels per cell (0.2 m)
BAND = 250  # ortho rows a worker samples at once: whole cells (a multiple of S), ~0.6 GB of float64 coordinates
JOBS = min(8, os.cpu_count() or 1)
_JOB = {}  # the mosaic and the shared outputs, inherited by the workers (fork)


def _orto_band(j0):
    """the ortho's rows j0..j0 + BAND sampled (bilinear, as resample) into the shared output, and their cells' colour:
    the median of each cell's S x S pixels per channel"""
    src, out, cellcol = _JOB["src"], _JOB["out"], _JOB["cellcol"]
    j1 = min(j0 + BAND, out.shape[0])
    row, col = coords(j0, j1, out.shape[1], 0.2, 0.2)
    for k in range(3):
        out[j0:j1, :, k] = ndimage.map_coordinates(src[..., k], [row, col], order=1, mode="nearest")
    med = np.median(out[j0:j1].reshape((j1 - j0) // S, S, -1, S, 3), axis=(1, 3))
    cc = med.astype(np.uint8)
    assert np.array_equal(cc, med), "the median of 25 bytes is one of them"
    cellcol[j0 // S:j1 // S] = cc


def resample_orto(src):
    """the ortho on the grid at 0.2 m (resample(src, 0.2, 0.2, order=1)) and each 1 m cell's colour (the median of
    its 25 pixels: what voxelize.py reads), in row bands over JOBS processes, into memory they share"""
    nj, ni = S * D, S * W

    def shared(shape):
        return np.frombuffer(mmap.mmap(-1, math.prod(shape)), np.uint8).reshape(shape)
    _JOB.update(src=src, out=shared((nj, ni, 3)), cellcol=shared((D, W, 3)))
    # fork: the workers read the mosaic as it is (Python 3.14 defaults to forkserver on Linux)
    with multiprocessing.get_context("fork").Pool(JOBS) as pool:
        for _ in pool.imap_unordered(_orto_band, range(0, nj, BAND)):
            pass
    out, cellcol = _JOB.pop("out"), np.array(_JOB.pop("cellcol"))
    _JOB.clear()
    return out, cellcol


_m, _t = mosaic("dsm_*.tif", 0.2)  # DOM20; sampled (nearest) at the pipeline's 0.5 m
tick("dsm mosaic")
dsm = resample(_m[0].astype(np.float32), 0.2, 0.5, order=0, origin=(_t.c, _t.f))  # nearest keeps spires
tick("dsm resampled")
_m, _t = mosaic("dtm_*.tif", 1.0)
dtm = resample(_m[0].astype(np.float32), 1.0, 1.0, order=1, origin=(_t.c, _t.f))
tick("dtm mosaic, resampled")
_f = fill_dtm(dtm)
if _f[0] or _f[1]:
    tick(f"dtm: {_f[0]} cells without DGM1 filled from the laser's ground returns, {_f[1]} left without")
del _m
for n, a in (("dsm", dsm), ("dtm", dtm)):
    print(n, a.shape, float(a[a > -1000].min()), float(a.max()), int((a < -1000).sum()), "nodata")
_o = mosaic_rgb("orto_*.tif", 0.2)
tick("orto mosaic")
orto, cellcol = resample_orto(_o)
del _o
tick(f"orto resampled, cells' colours ({JOBS} processes)")
print("orto", orto.shape, orto.reshape(-1, 3).mean(0), int((orto.sum(-1) == 0).sum()), "empty px")
np.savez_compressed("data/prep.npz", dsm=dsm, dtm=dtm, cellcol=cellcol)
tick("data/prep.npz written")
np.save("data/orto.npy", orto)  # (uncompressed: for look.py, which reads a box of it)
tick("data/orto.npy written")
from PIL import Image
Image.fromarray(orto[::4, ::4]).save("data/orto_preview.jpg", quality=85)
