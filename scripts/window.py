"""Windows over the map grid: the unit of work of the pipeline's raster steps, so that what a step holds in memory is
bounded by its window and a halo around it, not by the map.

A window's core is a rectangle of the 1 m grid (rows r0..r1, columns c0..c1, half-open), its corners on multiples of
ALIGN (1024 m = a node of tiles.py at the coarsest level, 128 cells of 8 m; also a terrain/near chunk) or on the
map's edge. Every node file of every level (tiles.py), every terrain/near chunk, every 2, 4, 8 m block of a level
and every 2 m cell lies in exactly one core: a step run over the windows of a cover of the map writes each of its
outputs once, from that window's core.

A step's work over a window reads the region around the core (`Window.region(halo)`: the core grown by `halo` cells
on each side, clipped to the map) and writes what belongs to the core. The halo is the step's reach: how far from a
cell what decides the cell can lie (a filter's radius, a node's apron, a blur). Steps declare it as HALO:

  tiles.export_window      16 m  the 1-cell apron of a level-8 node (8 m) and side_walls' neighbour block (8 m);
                                 the cascade (4 m from 2 m, 8 m from 4 m) stays inside the blocks
  tiles_lod.py             16 m  as tiles.export_window (the level-1 nodes over the region decoded)
  tile_fields.py           32 m  spil: a level-8 node's apron of 16 m cells and the bilinear tap beside it (10 m),
                                 the facade test (2 m) and the window light's blur (3 + 3 cells of 2 m); bldg's
                                 apron (8 m)
  zones.py                  0    a column's building is its own; per building the sums for its centre and box are
                                 added up over the windows
  terrain.py                8 m  a 4 m height sample is the mean over 4 m around it (2 m) and a near chunk holds the
                                 first sample of the next one (4 m); the far levels are sums of 8 m blocks, added up
                                 over the windows

Region and core are in map cells; arrays of a region are indexed from the region's corner (`Window.local`).

The volume (voxelize.py) is built region by region: a region is a window's core and a halo of region.HALO (384 m),
its decisions bounded so that the core comes out the same in any cover (scripts/region.py, regions.py,
check.py covers); it writes the tiles of its core itself (tiles.export_window).
Network-wide after the regions (regions.py), over OSM's vectors and what the regions hand over, sampling the regions'
rasters and volumes where they look (mapstore.py: nothing of the map's size in memory): the labels (the parks',
decluttered, their radii), the camera presets, traffic.py over the whole network.
Still on the whole map's rasters (a window there would change what is built, not only where):
  flood.py      the rivers: the water bodies of RIVER_MIN cells or more (a connectivity over the whole map)
  boats.py      the river: the largest water body
  web/tools/tris.mjs and lamps.mjs (node by node, and the lamps over data/zones.bin, foliage.bin, terrain.bin)

`cover(D, W, size)` cuts the map into windows of `size` x `size` metres (a multiple of ALIGN), `split(D, W, nx, ny)`
into nx x ny windows (as even as ALIGN allows); one window over the whole map is `cover(D, W, None)`. Steps take
--windows NXxNY or --window-size METRES (the whole map in one window by default) and write the same bytes either way
(`scripts/check.py windows` proves it).
"""
import gzip
import zipfile
from dataclasses import dataclass

import numpy as np

ALIGN = 1024


@dataclass(frozen=True)
class Window:
    r0: int
    r1: int
    c0: int
    c1: int
    D: int  # the map's rows and columns
    W: int
    # the map's built blocks, (r0, r1, c0, c1) each (aoi.built_boxes; meta.json `built`), or None: the whole map. A cell
    # in none is empty: whatever a step makes of it there is dropped (built)
    boxes: tuple = None

    def region(self, halo, nodes=True):
        """(ra, rb, ca, cb): the core grown by halo cells on each side, clipped to the map. nodes: a core that ends
        inside a block (one built only in its first rows) is taken to the block's end first, as far as its nodes reach
        (the cells there are not built: empty); not for a region of voxelize.py, which builds the core alone"""
        r1, c1 = (-(-self.r1 // ALIGN) * ALIGN, -(-self.c1 // ALIGN) * ALIGN) if nodes else (self.r1, self.c1)
        return max(self.r0 - halo, 0), min(r1 + halo, self.D), max(self.c0 - halo, 0), min(c1 + halo, self.W)

    def built(self, region):
        """which cells of the region (ra, rb, ca, cb) are built, a bool array; None when all of them are"""
        return built_mask(self.boxes, region)

    def local(self, region):
        """the core as slices into an array of the region (ra, rb, ca, cb)"""
        ra, _, ca, _ = region
        return slice(self.r0 - ra, self.r1 - ra), slice(self.c0 - ca, self.c1 - ca)

    def holds(self, r, c):
        """whether map cell (r, c) is in the core"""
        return self.r0 <= r < self.r1 and self.c0 <= c < self.c1

    @property
    def whole(self):
        return self.r0 == 0 and self.c0 == 0 and self.r1 == self.D and self.c1 == self.W

    def __str__(self):
        return f"rows {self.r0}-{self.r1}, cols {self.c0}-{self.c1}"


def _cuts(n, k):
    """k parts of 0..n on multiples of ALIGN, as even as that allows (fewer if n is short)"""
    blocks = -(-n // ALIGN)
    k = max(1, min(k, blocks))
    edges = [round(i * blocks / k) * ALIGN for i in range(k)] + [n]
    return [(a, min(b, n)) for a, b in zip(edges[:-1], edges[1:]) if a < min(b, n)]


def boxes_of(built):
    """the built boxes as Window.boxes takes them: None for the whole map (aoi.WHOLE, or no meta.json `built`), else a
    tuple of (r0, r1, c0, c1); `built` is aoi.BUILT's list of such, or meta.json's [x0, z0, x1, z1] (dict(meta=...))"""
    if built is None:
        return None
    if isinstance(built, dict):
        built = [(z0, z1, x0, x1) for x0, z0, x1, z1 in built["meta"]]
    return tuple(tuple(int(v) for v in b) for b in built)


def built_mask(boxes, region):
    """which cells of region (ra, rb, ca, cb) lie in a built box: a bool array, None when all of them do"""
    if boxes is None:
        return None
    ra, rb, ca, cb = region
    m = np.zeros((rb - ra, cb - ca), bool)
    for r0, r1, c0, c1 in boxes:
        y0, y1, x0, x1 = max(r0, ra), min(r1, rb), max(c0, ca), min(c1, cb)
        if y0 < y1 and x0 < x1:
            m[y0 - ra:y1 - ra, x0 - ca:x1 - ca] = True
    return None if m.all() else m


def _built_part(ws, boxes):
    """the windows ws cut to what is built: each core shrunk to the bounding box of its built cells (the blocks' north
    west corners stay, so a node of every level still lies in the core holding its first cell), those with none
    dropped. A core may still hold empty cells (a block missing between built ones, in a window of several blocks)"""
    if boxes is None:
        return ws
    out = []
    for w in ws:
        parts = [(max(r0, w.r0), min(r1, w.r1), max(c0, w.c0), min(c1, w.c1)) for r0, r1, c0, c1 in boxes]
        parts = [p for p in parts if p[0] < p[1] and p[2] < p[3]]
        if parts:
            out.append(Window(min(p[0] for p in parts), max(p[1] for p in parts), min(p[2] for p in parts),
                              max(p[3] for p in parts), w.D, w.W, boxes))
    return out


def split(D, W, nx=1, ny=1, boxes=None):
    """nx x ny windows over the map, row by row (cut to the built boxes: _built_part)"""
    return _built_part([Window(r0, r1, c0, c1, D, W) for r0, r1 in _cuts(D, ny) for c0, c1 in _cuts(W, nx)], boxes)


def cover(D, W, size=None, boxes=None):
    """windows of size x size cells (a multiple of ALIGN) over the map, row by row; None: one window, the whole map
    (cut to the built boxes: _built_part)"""
    if size is None:
        return _built_part([Window(0, D, 0, W, D, W)], boxes)
    assert size % ALIGN == 0, f"window size {size} is no multiple of {ALIGN}"
    return _built_part([Window(r0, min(r0 + size, D), c0, min(c0 + size, W), D, W)
                        for r0 in range(0, D, size) for c0 in range(0, W, size)], boxes)


def from_args(argv, D, W, boxes=None):
    """the windows asked for on the command line: --windows NXxNY, --window-size METRES, else the whole map"""
    for i, a in enumerate(argv):
        if a == "--windows":
            nx, ny = map(int, argv[i + 1].lower().split("x"))
            return split(D, W, nx, ny, boxes)
        if a == "--window-size":
            return cover(D, W, int(argv[i + 1]), boxes)
    return cover(D, W, None, boxes)


def cut(a, box, fill=0):
    """a[ra:rb, ca:cb] (box in a's own indices, may reach beyond a), fill beyond a"""
    ra, rb, ca, cb = box
    out = np.full((rb - ra, cb - ca) + a.shape[2:], fill, a.dtype)
    ya, yb, xa, xb = max(ra, 0), min(rb, a.shape[0]), max(ca, 0), min(cb, a.shape[1])
    if ya < yb and xa < xb:
        out[ya - ra:yb - ra, xa - ca:xb - ca] = a[ya:yb, xa:xb]
    return out


# ---------------------------------------------------------------- reading a region of a whole-map file
# The pipeline's intermediate files (data/*.npz, data/*.bin) are still one file per map. These read the rows of a
# region from them as a stream (memory: the region's rows times the map's width), never the whole array.

def _rows_from(fh, shape, dtype, r0, r1, offset=0):
    """rows r0..r1 of a C-ordered array of shape (rows, ...) that starts `offset` bytes into the stream fh"""
    dt = np.dtype(dtype)
    row = int(np.prod(shape[1:], dtype=np.int64)) * dt.itemsize
    fh.seek(offset + r0 * row)
    buf = fh.read((r1 - r0) * row)
    return np.frombuffer(buf, dt).reshape((r1 - r0,) + tuple(shape[1:]))


def _header(fh):
    """an .npy stream's (shape, dtype), the stream left at its data"""
    version = np.lib.format.read_magic(fh)
    read = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
    shape, fortran, dtype = read(fh)
    assert not fortran
    return shape, dtype


def npz_shape(path, key):
    with zipfile.ZipFile(path) as z, z.open(key + ".npy") as fh:
        return _header(fh)


def npz_rows(path, key, r0, r1):
    """rows r0..r1 of array `key` of an .npz (np.savez[_compressed]), read as a stream"""
    with zipfile.ZipFile(path) as z, z.open(key + ".npy") as fh:
        shape, dtype = _header(fh)
        return _rows_from(fh, shape, dtype, r0, r1, fh.tell())


def npz_region(path, key, region):
    """the region (ra, rb, ca, cb) of a 2D (or 2D x k) array of an .npz"""
    ra, rb, ca, cb = region
    return np.ascontiguousarray(npz_rows(path, key, ra, rb)[:, ca:cb])


def gz_region(path, shape, dtype, region, offset=0):
    """the region of a C-ordered array of shape (D, W, ...) stored `offset` bytes into a gzip file"""
    ra, rb, ca, cb = region
    with gzip.open(path, "rb") as fh:
        return np.ascontiguousarray(_rows_from(fh, shape, dtype, ra, rb, offset)[:, ca:cb])


class RowWriter:
    """a whole-map array written row band by row band (the windows of a cover in its order: a band's windows start on
    the same row, left to right) into a gzip stream, as gzip.GzipFile(..., mtime=0).write(a.tobytes()) would: the same
    bytes. Rows and columns no window covers (an empty block: window.py) are zeros; finish(D) writes the rest"""

    def __init__(self, fh, W, dtype, tail=()):
        self.fh, self.W, self.dtype, self.tail = fh, W, np.dtype(dtype), tuple(tail)
        self.parts, self.r, self.done = [], 0, 0

    def _flush(self, upto):
        """the rows from the band's first up to `upto` (the next band's first row, or the array's end)"""
        if upto <= self.done:
            return
        band = np.zeros((upto - self.done, self.W) + self.tail, self.dtype)
        for c, a in self.parts:
            band[self.r - self.done:self.r - self.done + a.shape[0], c:c + a.shape[1]] = a
        self.fh.write(band.tobytes())
        self.parts, self.done = [], upto

    def put(self, r, c, a):
        """a: a window's core, its first row r and column c (in the array's own cells)"""
        if self.parts and r != self.r:
            assert r >= self.r + max(a_.shape[0] for _, a_ in self.parts), "windows out of order"
            self._flush(r)
        if not self.parts:
            assert r >= self.done, "windows out of order"
            if r > self.done:
                self._flush(r)  # (rows no window covers)
            self.r = r
        self.parts.append((c, a))

    def finish(self, D):
        """the last band and the empty rows after it, up to the array's D rows"""
        if self.parts:
            assert D >= self.r + max(a_.shape[0] for _, a_ in self.parts)
        self._flush(D)
