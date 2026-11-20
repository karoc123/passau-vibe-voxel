"""The map's rasters and volume as the regions left them (data/cache/regions/<row>_<col>/: core.npz, vol.npz), read on
demand, so that the steps after the regions (scripts/regions.py: the labels, the camera presets, traffic.py)
hold no array of the map's size: what they ask for is read from the regions' cores it lies in, a few cores kept at a
time, and the map-sized files (data/ground.npz ...) are written row band by row band.

MapRaster(ws, rdir, key)    a 2D (or 2D x k) raster of the map: r[i, j] (ints), r[rows, cols] (integer arrays,
                            broadcast), r[r0:r1, c0:c1] (a box, filled with `fill` beyond the map); .shape, .dtype
MapVolume(ws, rdir, H)      the volume: v[z, rows, cols] (z an int, an array or ':'), from each region's vol.npz
                            (save_volume: compressed 128 m column blocks), the blocks looked at read and some kept
write_npz(path, arrays)     an .npz (np.savez_compressed's format, read by np.load and window.npz_rows) whose arrays
                            are written row band by row band
"""
import zipfile
from collections import OrderedDict

import numpy as np

import tilefile


class _Cover:
    """which window of a cover (a grid of windows, window.split / window.cover) holds a map cell"""

    def __init__(self, ws):
        self.ws = list(ws)
        self.D, self.W = self.ws[0].D, self.ws[0].W
        self.rcuts = sorted({w.r0 for w in self.ws})
        self.ccuts = sorted({w.c0 for w in self.ws})
        self.at = {(w.r0, w.c0): w for w in self.ws}
        assert len(self.at) == len(self.rcuts) * len(self.ccuts), "the cover is not a grid"

    def index(self, r, c):
        """per cell the (row band, column band) indices of its window"""
        return np.searchsorted(self.rcuts, r, side="right") - 1, np.searchsorted(self.ccuts, c, side="right") - 1

    def window(self, ib, jb):
        return self.at[(self.rcuts[ib], self.ccuts[jb])]


class MapRaster:
    def __init__(self, ws, rdir, key, dtype=None, scale=1, fill=0, fn=None, keep=6):
        """key: the array in the regions' core.npz (or several, a tuple, combined by fn(*arrays)); scale: the size of its
        cells in map cells (2: the crowns' 2 m grid, an array of D // 2 x W // 2); dtype: what it is cast to; keep: how
        many cores are kept in memory"""
        self.cov, self.rdir, self.keys = _Cover(ws), rdir, key if isinstance(key, tuple) else (key,)
        self.fn, self.scale, self.fill, self.keep = fn, scale, fill, keep
        self._cache = OrderedDict()
        a = self._chunk(self.cov.ws[0])
        self.dtype = np.dtype(dtype) if dtype is not None else a.dtype
        self._cache.clear()  # (the first core was read before the type was known)
        self.tail = a.shape[2:]
        self.shape = (self.cov.D // scale, self.cov.W // scale) + self.tail
        self.ndim = len(self.shape)

    def _chunk(self, w):
        k = (w.r0, w.c0)
        if k in self._cache:
            self._cache.move_to_end(k)
            return self._cache[k]
        z = np.load(self.rdir(w) / "core.npz")
        arrs = [z[k_] for k_ in self.keys]
        a = self.fn(*arrs) if self.fn else arrs[0]
        if hasattr(self, "dtype"):
            a = a.astype(self.dtype, copy=False)
        self._cache[k] = a
        while len(self._cache) > self.keep:
            self._cache.popitem(last=False)
        return a

    def box(self, r0, r1, c0, c1):
        """rows r0..r1, columns c0..c1 (this raster's cells), `fill` beyond the map"""
        s = self.scale
        out = np.full((r1 - r0, c1 - c0) + self.tail, self.fill, self.dtype)
        ya, yb, xa, xb = max(r0, 0), min(r1, self.shape[0]), max(c0, 0), min(c1, self.shape[1])
        if ya >= yb or xa >= xb:
            return out
        ib0, jb0 = self.cov.index(ya * s, xa * s)
        ib1, jb1 = self.cov.index((yb - 1) * s, (xb - 1) * s)
        for ib in range(int(ib0), int(ib1) + 1):
            for jb in range(int(jb0), int(jb1) + 1):
                w = self.cov.window(ib, jb)
                a = self._chunk(w)
                wr0, wc0 = w.r0 // s, w.c0 // s
                y0, y1 = max(ya, wr0), min(yb, w.r1 // s)
                x0, x1 = max(xa, wc0), min(xb, w.c1 // s)
                out[y0 - r0:y1 - r0, x0 - c0:x1 - c0] = a[y0 - wr0:y1 - wr0, x0 - wc0:x1 - wc0]
        return out

    def __getitem__(self, idx):
        r, c = idx
        if isinstance(r, slice):
            assert r.step is None and c.step is None
            r0, r1 = r.indices(self.shape[0])[:2]
            c0, c1 = c.indices(self.shape[1])[:2]
            return self.box(r0, r1, c0, c1)
        if np.ndim(r) == 0 and np.ndim(c) == 0:
            r, c = int(r), int(c)
            if r < 0:
                r += self.shape[0]
            if c < 0:
                c += self.shape[1]
            assert 0 <= r < self.shape[0] and 0 <= c < self.shape[1], (r, c)
            s = self.scale
            ib, jb = self.cov.index(r * s, c * s)
            w = self.cov.window(int(ib), int(jb))
            return self._chunk(w)[r - w.r0 // s, c - w.c0 // s]
        r, c = np.broadcast_arrays(np.asarray(r), np.asarray(c))
        r, c = r.astype(np.int64), c.astype(np.int64)
        assert r.size == 0 or (r.min() >= 0 and r.max() < self.shape[0] and c.min() >= 0 and c.max() < self.shape[1])
        out = np.empty(r.shape + self.tail, self.dtype)
        s = self.scale
        ib, jb = self.cov.index(r * s, c * s)
        key = ib * len(self.cov.ccuts) + jb
        for k in np.unique(key):
            m = key == k
            w = self.cov.window(int(k) // len(self.cov.ccuts), int(k) % len(self.cov.ccuts))
            out[m] = self._chunk(w)[r[m] - w.r0 // s, c[m] - w.c0 // s]
        return out

    def map_chunks(self, fn, halo):
        """a raster whose every region's core is fn(the core and `halo` cells round it, `fill` beyond the map)[the core]:
        what a filter of reach `halo` gives over the whole map (a binary dilation, ...)"""
        parent = self

        class _Derived(MapRaster):
            def _chunk(self, w):
                k = (w.r0, w.c0)
                if k in self._cache:
                    self._cache.move_to_end(k)
                    return self._cache[k]
                s = parent.scale
                r0, r1, c0, c1 = w.r0 // s, w.r1 // s, w.c0 // s, w.c1 // s
                a = fn(parent.box(r0 - halo, r1 + halo, c0 - halo, c1 + halo))[halo:halo + r1 - r0, halo:halo + c1 - c0]
                if hasattr(self, "dtype"):
                    a = a.astype(self.dtype, copy=False)
                self._cache[k] = a
                while len(self._cache) > self.keep:
                    self._cache.popitem(last=False)
                return a

        d = _Derived.__new__(_Derived)
        d.cov, d.rdir, d.keys, d.fn, d.scale, d.fill, d.keep = self.cov, self.rdir, self.keys, None, self.scale, self.fill, self.keep
        d._cache = OrderedDict()
        a = d._chunk(self.cov.ws[0])
        d.dtype, d.tail = a.dtype, a.shape[2:]
        d.shape, d.ndim = self.shape[:2] + d.tail, 2 + len(d.tail)
        return d

    def bands(self):
        """the raster row band by row band (the cover's rows of windows): (first row, band)"""
        s = self.scale
        for k, r0 in enumerate(self.cov.rcuts):
            r1 = self.cov.rcuts[k + 1] if k + 1 < len(self.cov.rcuts) else self.cov.D
            yield r0 // s, self.box(r0 // s, r1 // s, 0, self.shape[1])


VBLOCK = tilefile.N  # the volume's column blocks (a level-1 node's cells)


def save_volume(path, vol):
    """a region's core volume (H, rows, cols) as a compressed .npz of its VBLOCK x VBLOCK column blocks, each cut at
    its own top ("<row block>_<col block>", from the core's corner): ~1/50 of the raw bytes, and MapVolume reads only
    the blocks it looks at"""
    H, R, C = vol.shape
    out = {}
    for br in range(0, R, VBLOCK):
        for bc in range(0, C, VBLOCK):
            b = vol[:, br:br + VBLOCK, bc:bc + VBLOCK]
            nz = np.flatnonzero(b.reshape(H, -1).any(axis=1))
            out[f"{br // VBLOCK}_{bc // VBLOCK}"] = np.ascontiguousarray(b[:nz[-1] + 1] if len(nz) else b[:0])
    np.savez_compressed(path, **out)


def load_volume(path, shape):
    """save_volume's file as the volume (H, rows, cols) again"""
    H, R, C = shape
    v = np.zeros(shape, np.uint16)
    with np.load(path) as z:
        for k in z.files:
            br, bc = (int(x) * VBLOCK for x in k.split("_"))
            b = z[k]
            v[:b.shape[0], br:br + b.shape[1], bc:bc + b.shape[2]] = b
    return v


class MapVolume:
    """the volume of the map: v[z, rows, cols] (z an int or an array; or ':' at one cell), from the regions' vol.npz,
    VBLOCK x VBLOCK column blocks read when looked at and `keep_mb` of them kept (0 above a block's own top)"""

    def __init__(self, ws, rdir, H, keep_mb=1024):
        self.cov, self.rdir = _Cover(ws), rdir
        self.shape = (H, self.cov.D, self.cov.W)
        self.dtype = np.dtype(np.uint16)
        self.keep = keep_mb << 20
        self._z, self._blocks, self._bytes = {}, OrderedDict(), 0

    def _block(self, br, bc):
        """map block (br, bc) (VBLOCK cells each way)"""
        k = (br, bc)
        if k in self._blocks:
            self._blocks.move_to_end(k)
            return self._blocks[k]
        ib, jb = self.cov.index(br * VBLOCK, bc * VBLOCK)
        w = self.cov.window(int(ib), int(jb))
        if (w.r0, w.c0) not in self._z:
            self._z[(w.r0, w.c0)] = np.load(self.rdir(w) / "vol.npz")
        b = self._z[(w.r0, w.c0)][f"{br - w.r0 // VBLOCK}_{bc - w.c0 // VBLOCK}"]
        self._blocks[k] = b
        self._bytes += b.nbytes
        while self._bytes > self.keep and len(self._blocks) > 1:
            self._bytes -= self._blocks.popitem(last=False)[1].nbytes
        return b

    def __getitem__(self, idx):
        z, r, c = idx
        H = self.shape[0]
        if np.ndim(r) == 0 and np.ndim(c) == 0:
            r, c = int(r), int(c)
            b = self._block(r // VBLOCK, c // VBLOCK)
            col = np.zeros(H, self.dtype)
            col[:b.shape[0]] = b[:, r % VBLOCK, c % VBLOCK]
            return col[z]
        assert not isinstance(z, slice), "a column (z = ':') at one cell only"
        z, r, c = np.broadcast_arrays(np.asarray(z), np.asarray(r), np.asarray(c))
        out = np.zeros(r.shape, self.dtype)
        nbc = -(-self.shape[2] // VBLOCK)
        key = (r // VBLOCK) * nbc + c // VBLOCK
        for k in np.unique(key):
            m = key == k
            b = self._block(int(k) // nbc, int(k) % nbc)
            zm = z[m]
            ok = zm < b.shape[0]
            vals = np.zeros(zm.shape, self.dtype)
            vals[ok] = b[zm[ok], r[m][ok] % VBLOCK, c[m][ok] % VBLOCK]
            out[m] = vals
        return out


def write_npz(path, arrays):
    """arrays: {key: (shape, dtype, iterator of row bands in order)}: an .npz as np.savez_compressed writes it (the
    same arrays; its bytes the same from build to build: no time in the zip)"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for key, (shape, dtype, bands) in arrays.items():
            dt = np.dtype(dtype)
            zi = zipfile.ZipInfo(key + ".npy", date_time=(1980, 1, 1, 0, 0, 0))  # (no time: the same bytes every build)
            zi.compress_type = zipfile.ZIP_DEFLATED
            with zf.open(zi, "w", force_zip64=True) as fh:
                np.lib.format.write_array_header_1_0(fh, dict(descr=np.lib.format.dtype_to_descr(dt), fortran_order=False,
                                                              shape=tuple(shape)))
                n = 0
                for band in bands:
                    band = np.ascontiguousarray(band, dt)
                    assert band.shape[1:] == tuple(shape[1:])
                    fh.write(band.tobytes())
                    n += band.shape[0]
                assert n == shape[0], (key, n, shape)
