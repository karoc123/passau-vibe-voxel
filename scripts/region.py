"""What makes voxelize.py's synthesis region-local: the volume of a region's core comes out the same whether the region
is the whole map or a piece of it (the core and a halo of HALO metres round it), so the map can be built region by
region and the cores put together (voxelize.py; `scripts/check.py covers` proves it byte for byte).

The rule: what decides a cell lies within a bounded distance of it (its reach), and the reaches along every chain of
the build add up to less than HALO. Hence:
- inputs are cut to the region (load_npz); nothing is a statistic of the whole map: BASE is pinned (aoi.BASE), the
  rivers' levels are per stretch (windowed), the crowns' noise is hashed from the project grid's coordinates
  (noise), the palette is a registry (scripts/palette.json, voxelize.Palette)
- a feature's statistic (a lawn's median green, a path's colour, a building's roof) is over its whole outline when the
  feature spans FMAX metres or less -- it then lies in the region whenever it touches the exact part of it; a larger
  one (a lawn, an untagged car park or path) is decided over its whole outline too, from counts every region makes
  over its core in a feature pass before the regions and the driver adds up (features.py); what has no such decision
  goes per BLOCK x BLOCK block of the project grid, from its cells within FMARGIN of the block (feature_parts)
- connected components judged by their size are counted within a window of their block (windowed_sizes): a size
  threshold up to the window's span is decided the same; the rivers' bodies take their level per block the same way
- nearest-cell fills are bounded (a cell takes the nearest within some metres, or nothing)
- box filters sum exactly (boxmean: in a fixed order per cell; scipy's uniform_filter carries a running sum along the
  line, whose last bits depend on where the line starts)
- blocks of passes that work block by block (debris.py) are aligned to the project grid

HALO = 384: the largest feature decided over its whole outline (FMAX 192 m) plus the longest chain after it -- trunks
on the ground classes, a crown's cells within CROWN_R of its trunk and its shape from all of them (2 x 32 m), the
floating pieces judged whole up to 64 m (debris.py) and the tiles' apron (16 m) -- with ~40 m to spare.
"""
import numpy as np
from scipy import ndimage

import aoi

HALO = 384
FMAX = 192  # a feature spanning more is decided by the feature pass (features.py), else block by block
BLOCK, FMARGIN = 128, 64
CROWN_R = 32  # a canopy cell's crown: the nearest trunk within this many metres


def core_slices():
    r0, r1, c0, c1 = aoi.CORE
    return slice(r0, r1), slice(c0, c1)


_CORE_BUILT = []  # (the core's built cells, window.built_mask: made when first asked)


def core_built():
    """the core's built cells (bool, the core's shape), or None when all of them are (window.py)"""
    if not _CORE_BUILT:
        import window
        r0, r1, c0, c1 = aoi.CORE
        _CORE_BUILT.append(window.built_mask(aoi.BOXES, (r0 + aoi.MR0, r1 + aoi.MR0, c0 + aoi.MC0, c1 + aoi.MC0)))
    return _CORE_BUILT[0]


def in_core(r, c):
    """whether the region's cell (r, c) is its core's and built (what a region hands over: the cells of a block not
    built, in a core of several blocks, are nobody's: window.py)"""
    r0, r1, c0, c1 = aoi.CORE
    if not (r0 <= r < r1 and c0 <= c < c1):
        return False
    m = core_built()
    return m is None or bool(m[r - r0, c - c0])


def load_npz(path, keys=None):
    """the arrays of an .npz (map-sized, at whole multiples of the map's cell) cut to the region: from its uncompressed
    copy (sidecar.py) where there is a fresh one, else read as a stream"""
    import zipfile
    import sidecar
    import window
    with zipfile.ZipFile(path) as z:
        names = [n[:-4] for n in z.namelist() if n.endswith(".npy")]
    out = {}
    for k in keys or names:
        (rows, cols, *_), _ = window.npz_shape(path, k)
        s = rows // aoi.MAP_D
        assert rows == s * aoi.MAP_D and cols == s * aoi.MAP_W, (path, k)
        box = (aoi.MR0 * s, (aoi.MR0 + aoi.D) * s, aoi.MC0 * s, (aoi.MC0 + aoi.W) * s)
        m = sidecar.load(path, k)
        out[k] = window.npz_region(path, k, box) if m is None else np.array(m[box[0]:box[1], box[2]:box[3]], order="C")
    return out


# ---------------------------------------------------------------- exact filters

def boxmean(a, size):
    """scipy.ndimage.uniform_filter(a, size) (mode reflect), summed in the same order for every cell (in float64, then
    a's type): the same value wherever the array starts"""
    lo, hi = size // 2, size - size // 2 - 1
    p = np.pad(np.asarray(a, np.float64), ((lo, hi), (lo, hi)), mode="symmetric")
    D, W = a.shape
    s = np.zeros((D, W), np.float64)
    for i in range(size):
        for j in range(size):
            s += p[i:i + D, j:j + W]
    return (s / (size * size)).astype(a.dtype)


def boxsum(a, size):
    """the integer counterpart: the sum over size x size (mode reflect), exact"""
    lo, hi = size // 2, size - size // 2 - 1
    p = np.pad(np.asarray(a, np.int32), ((lo, hi), (lo, hi)), mode="symmetric")
    D, W = a.shape
    s = np.zeros((D, W), np.int32)
    for i in range(size):
        for j in range(size):
            s += p[i:i + D, j:j + W]
    return s


def movmean(a, size):
    """scipy.ndimage.uniform_filter1d(a, size, mode="nearest") on a 1D array, summed in a fixed order per sample"""
    lo, hi = size // 2, size - size // 2 - 1
    p = np.pad(np.asarray(a, np.float64), (lo, hi), mode="edge")
    s = np.zeros(len(a), np.float64)
    for i in range(size):
        s += p[i:i + len(a)]
    return s / size


# ---------------------------------------------------------------- coordinates

def project_rc(shape=None):
    """the project grid's rows and columns of the region's cells (open grids)"""
    D, W = shape or (aoi.D, aoi.W)
    return np.arange(D)[:, None] + aoi.R0, np.arange(W)[None, :] + aoi.C0


def _mix(x):
    """splitmix64's finaliser on uint64 (wrapping)"""
    x = (x ^ (x >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    x = (x ^ (x >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return x ^ (x >> np.uint64(31))


def cell_uniform(seed, k=0):
    """per cell of the region a uniform number in (0, 1), a hash of its project row and column (and seed, k)"""
    r, c = project_rc()
    key = ((r.astype(np.int64) + (1 << 24)).astype(np.uint64) << np.uint64(32)) | (c.astype(np.int64) + (1 << 24)).astype(np.uint64)
    with np.errstate(over="ignore"):
        x = _mix(key ^ _mix(np.uint64(seed * 1000003 + k + 1)))
    return ((x >> np.uint64(11)).astype(np.float64) + 0.5) / float(1 << 53)


def noise(seed, sigma):
    """smooth noise of unit variance over the region: white noise hashed from the project grid's coordinates (Box-Muller
    of two cell_uniform), blurred by a gaussian of sigma cells and divided by the blur's own gain -- not by the
    sample's standard deviation, which is the map's. float32; reach 4 sigma"""
    u1, u2 = cell_uniform(seed, 0), cell_uniform(seed, 1)
    n = (np.sqrt(-2 * np.log(u1)) * np.cos(2 * np.pi * u2)).astype(np.float32)
    x = np.arange(-int(4.0 * sigma + 0.5), int(4.0 * sigma + 0.5) + 1)
    k = np.exp(-0.5 * x * x / sigma ** 2)
    k /= k.sum()
    return ndimage.gaussian_filter(n, sigma) / np.float32((k ** 2).sum())


# ---------------------------------------------------------------- blocks of the project grid

def blocks(block):
    """the blocks of the project grid over the region: (r0, r1, c0, c1) in the region's cells, clipped to it"""
    out = []
    for br in range((aoi.R0 // block) * block, aoi.R0 + aoi.D, block):
        for bc in range((aoi.C0 // block) * block, aoi.C0 + aoi.W, block):
            out.append((max(br - aoi.R0, 0), min(br + block - aoi.R0, aoi.D), max(bc - aoi.C0, 0), min(bc + block - aoi.C0, aoi.W)))
    return out


def _grow(b, m):
    r0, r1, c0, c1 = b
    return max(r0 - m, 0), min(r1 + m, aoi.D), max(c0 - m, 0), min(c1 + m, aoi.W)


def windowed_sizes(mask, block=64, margin=64, structure=None):
    """per cell of mask, the size of its connected component within the window of its block (the block grown by
    margin): a component up to the margin's span from the block is counted whole, the same wherever the region starts.
    int32, 0 off the mask. Reach block + margin."""
    out = np.zeros(mask.shape, np.int32)
    for b in blocks(block):
        w = _grow(b, margin)
        sub = mask[w[0]:w[1], w[2]:w[3]]
        if not sub.any():
            continue
        lab, n = ndimage.label(sub, structure)
        sz = np.bincount(lab.ravel())
        sz[0] = 0
        i0, j0 = b[0] - w[0], b[2] - w[2]
        out[b[0]:b[1], b[2]:b[3]] = sz[lab[i0:i0 + b[1] - b[0], j0:j0 + b[3] - b[2]]]
    return out


def feature_parts(geom, rr, cc):
    """a feature's cells (rr, cc, those within the region) as [(block, cells it decides from)]: (None, all of them)
    once if it spans FMAX metres or less (spans: by its outline, not by its cells in the region); else per BLOCK block
    of the project grid it has cells in ((r0, c0, r1, c1) in the region's cells), its cells within FMARGIN of the block
    (a long path's colour, a big lawn's: stretch by stretch)"""
    if not len(rr) or not spans(geom):
        return [(None, (rr, cc))]
    out = []
    br, bc = (rr + aoi.R0) // BLOCK, (cc + aoi.C0) // BLOCK
    for kr, kc in sorted(set(zip(br.tolist(), bc.tolist()))):
        r0, c0 = kr * BLOCK - aoi.R0, kc * BLOCK - aoi.C0
        near = (rr >= r0 - FMARGIN) & (rr < r0 + BLOCK + FMARGIN) & (cc >= c0 - FMARGIN) & (cc < c0 + BLOCK + FMARGIN)
        out.append(((r0, c0, r0 + BLOCK, c0 + BLOCK), (rr[near], cc[near])))
    return out


def spans(geom):
    """whether a geometry spans more than FMAX metres (its decision then comes from the feature pass, goes block by
    block, or is left out)"""
    x0, y0, x1, y1 = geom.bounds
    return x1 - x0 >= FMAX or y1 - y0 >= FMAX


def shift(a, k, axis):
    """np.roll(a, k, axis) without the wrap-around: what comes in at the edge is 0 (np.roll put the map's far edge
    beside its near one, and a region's far edge is not the map's)"""
    out = np.zeros_like(a)
    src = [slice(None)] * a.ndim
    dst = [slice(None)] * a.ndim
    if k >= 0:
        src[axis], dst[axis] = slice(0, a.shape[axis] - k), slice(k, None)
    else:
        src[axis], dst[axis] = slice(-k, None), slice(0, a.shape[axis] + k)
    out[tuple(dst)] = a[tuple(src)]
    return out


def shift2(a, d):
    """np.roll(a, (dr, dc), (0, 1)) without the wrap-around"""
    return shift(shift(a, d[0], 0), d[1], 1)
