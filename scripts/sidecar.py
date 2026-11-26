"""Uncompressed copies of the map-sized inputs (data/prep.npz, lod2.npz, laser.npz), one .npy per array in
data/cache/inputs/<npz name>/, read memory-mapped (region.load_npz): a region reads its own box of them, where reading
it from the .npz inflated the deflate stream from the array's start up to the region's last row (~4 GB for a region in
the map's bottom row: ~15 s before it started, and as long again in the feature pass).

ensure(path) writes them (regions.py, before the feature pass) when the .npz changed: stamp.json holds the .npz's size and
mtime (as region_inputs.raster_blocks keeps its hashes) and the arrays' names; written last, so an interrupted copy is
made again. The arrays are the same bytes; load() gives None where there is no fresh copy and the caller reads the .npz.
"""
import json
import os
import zipfile
from pathlib import Path

import numpy as np

CACHE = Path("data/cache/inputs")
BAND = 1 << 28  # bytes copied at a time


def _dir(path):
    return CACHE / Path(path).name


def _stamp(path):
    st = Path(path).stat()
    return [st.st_size, st.st_mtime_ns]


def fresh(path):
    """the folder of path's copies if they are those of the .npz as it is now, else None"""
    p = Path(path)
    d = _dir(p)
    try:
        rec = json.loads((d / "stamp.json").read_text())
    except (OSError, ValueError):
        return None
    if not p.exists() or rec.get("stamp") != _stamp(p) or not all((d / f"{k}.npy").exists() for k in rec.get("keys", [])):
        return None
    return d


def ensure(path):
    """the copies of the arrays of path (an .npz), made again when it changed; returns their folder (None: no file)"""
    from window import _header
    p = Path(path)
    if not p.exists():
        return None
    if (d := fresh(p)) is not None:
        return d
    d = _dir(p)
    d.mkdir(parents=True, exist_ok=True)
    (d / "stamp.json").unlink(missing_ok=True)
    stamp = _stamp(p)
    keys = []
    with zipfile.ZipFile(p) as z:
        for name in z.namelist():
            if not name.endswith(".npy"):
                continue
            k = name[:-4]
            keys.append(k)
            with z.open(name) as fh:
                shape, dtype = _header(fh)
                tmp = d / f"{k}.tmp.npy"
                m = np.lib.format.open_memmap(tmp, "w+", dtype, shape)
                row = int(np.prod(shape[1:], dtype=np.int64)) * np.dtype(dtype).itemsize
                step = max(1, BAND // max(row, 1))
                for r0 in range(0, shape[0], step):
                    r1 = min(r0 + step, shape[0])
                    m[r0:r1] = np.frombuffer(fh.read((r1 - r0) * row), dtype).reshape((r1 - r0,) + tuple(shape[1:]))
                m.flush()
                del m
                os.replace(tmp, d / f"{k}.npy")
    for f in d.glob("*.npy"):  # (an array the .npz no longer has: prep.npz's orto, 2.4 GB, before it moved to orto.npy)
        if f.name[:-4] not in keys:
            f.unlink()
    tmp = d / "stamp.tmp.json"
    tmp.write_text(json.dumps(dict(stamp=stamp, keys=keys)))
    os.replace(tmp, d / "stamp.json")
    return d


def load(path, key):
    """array `key` of the .npz at path, memory-mapped from its fresh copy, or None"""
    d = fresh(path)
    if d is None or not (d / f"{key}.npy").exists():
        return None
    return np.load(d / f"{key}.npy", mmap_mode="r")
