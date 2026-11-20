"""What a region of voxelize.py reads, as hashes, so that scripts/regions.py rebuilds only the regions whose inputs or
code changed (and the OSM cut each region reads instead of the whole of data/raw/osm.json).

- the map-sized rasters (data/prep.npz, lod2.npz, laser.npz): a hash per BLOCK x BLOCK block of the map (at each
  array's own resolution), made in one pass over the file and kept in data/cache/inputs/ while the file is unchanged
  (size and mtime); a region's is the hash of the blocks its box covers -- what region.load_npz reads of them
- OSM: each region reads its cut of data/raw/osm.json (cut_osm): the elements whose bounding box comes within
  OSM_MARGIN of the region's box (and, everywhere, those named in landmarks.LABELS: a curated label takes the map's
  first outline of its name), in the file's order. Its hash is the hash of those elements: a new extract that changes
  nothing near a region leaves it be
- other raw files a region reads whole (the tree register, ALKIS land use): their hash
- code: the files of scripts/ the region's process had loaded (recorded in its out.json, `deps`; a Python file by its
  syntax tree, so comments and docstrings rebuild nothing), and the parts of scripts/map.json that decide what is built
  (grid, anchor, map, base, rivers)
- the palette registry is append-only: a region stays valid while the registry's first n colours are those it was
  built with (palette_ok)
"""
import hashlib
import json
import os
import zipfile
from pathlib import Path

import numpy as np

import aoi
import window

BLOCK = 128  # map cells; region boxes lie on multiples of it (cores on 1024, halo 384) or on the map's edge
OSM_MARGIN = 64  # m: an element this near a region's box is in its cut
CACHE = Path("data/cache/inputs")
HERE = Path(__file__).resolve().parent
RASTERS = ["data/prep.npz", "data/lod2.npz", "data/laser.npz"]
RAW_FILES = ["data/raw/baeume_aoi.csv", "data/raw/tn_09262.zip"]
ENV = ["NO_LOD2", "NO_LASER"]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def file_sha(path, cache={}):
    """a file's content hash, kept per (size, mtime) in data/cache/inputs/files.json"""
    p = Path(path)
    if not p.exists():
        return None
    st = p.stat()
    stamp = f"{st.st_size}:{st.st_mtime_ns}"
    db = CACHE / "files.json"
    if not cache:
        cache.update(json.load(open(db)) if db.exists() else {})
    hit = cache.get(str(p))
    if hit and hit[0] == stamp:
        return hit[1]
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    cache[str(p)] = [stamp, h.hexdigest()]
    CACHE.mkdir(parents=True, exist_ok=True)
    json.dump(cache, open(db, "w"))
    return h.hexdigest()


def code_sha(path, cache={}):
    """a code file's hash: a Python file's syntax tree without its docstrings (comments, docstrings and layout do
    not rebuild anything), another file's content; kept per (size, mtime) as file_sha"""
    p = Path(path)
    if p.suffix != ".py" or not p.exists():
        return file_sha(p)
    st = p.stat()
    k = (str(p), st.st_size, st.st_mtime_ns)
    if k not in cache:
        import ast
        tree = ast.parse(p.read_text())
        for node in ast.walk(tree):
            body = getattr(node, "body", None)
            if isinstance(body, list) and body and isinstance(body[0], ast.Expr) and \
                    isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
        cache[k] = "ast:" + sha(ast.dump(tree).encode())
    return cache[k]


def _npz_blocks(path):
    """{key: [[hash per block]]} of an .npz of map-sized arrays, read once, row band by row band"""
    out = {}
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if n.endswith(".npy")):
            with z.open(name) as fh:
                shape, dtype = window._header(fh)
                s = shape[0] // aoi.MAP_D
                assert shape[0] == s * aoi.MAP_D and shape[1] == s * aoi.MAP_W, (path, name, shape)
                rowbytes = int(np.prod(shape[1:], dtype=np.int64)) * np.dtype(dtype).itemsize
                grid = []
                for r0 in range(0, aoi.MAP_D, BLOCK):
                    n = (min(r0 + BLOCK, aoi.MAP_D) - r0) * s
                    a = np.frombuffer(fh.read(n * rowbytes), dtype).reshape((n,) + tuple(shape[1:]))
                    grid.append([sha(np.ascontiguousarray(a[:, c0 * s:min(c0 + BLOCK, aoi.MAP_W) * s]).tobytes())[:24]
                                 for c0 in range(0, aoi.MAP_W, BLOCK)])
                out[name[:-4]] = grid
    return out


def raster_blocks(path, cache={}):
    """_npz_blocks, kept in data/cache/inputs/ while the file's size and mtime and the map stay as they are"""
    p = Path(path)
    if not p.exists():
        return None
    if str(p) in cache:
        return cache[str(p)]
    st = p.stat()
    stamp = [st.st_size, st.st_mtime_ns, aoi.MAP_D, aoi.MAP_W, BLOCK]
    db = CACHE / (p.name + ".blocks.json")
    if db.exists():
        d = json.load(open(db))
        if d["stamp"] == stamp:
            cache[str(p)] = d["blocks"]
            return d["blocks"]
    blocks = _npz_blocks(p)
    CACHE.mkdir(parents=True, exist_ok=True)
    json.dump(dict(stamp=stamp, blocks=blocks), open(db, "w"))
    cache[str(p)] = blocks
    return blocks


def raster_hash(path, box):
    """the hash of what a region with box (ra, rb, ca, cb, map cells) reads of an .npz"""
    blocks = raster_blocks(path)
    if blocks is None:
        return None
    ra, rb, ca, cb = box
    assert all(v % BLOCK == 0 for v in (ra, ca)) and (rb % BLOCK == 0 or rb == aoi.MAP_D) and \
        (cb % BLOCK == 0 or cb == aoi.MAP_W), f"region {box} not on the {BLOCK} m blocks"
    h = hashlib.sha256()
    for k in sorted(blocks):
        h.update(k.encode())
        for row in blocks[k][ra // BLOCK:-(-rb // BLOCK)]:
            h.update("".join(row[ca // BLOCK:-(-cb // BLOCK)]).encode())
    return h.hexdigest()


# ---------------------------------------------------------------- OSM

def _osm_boxes(els):
    """per element its bounding box in map cells (c0, r0, c1, r1), None where it has no geometry"""
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, aoi.CRS, always_xy=True)
    lon, lat, owner = [], [], []
    for k, e in enumerate(els):
        if e["type"] == "node":
            pts = [e] if "lon" in e else []
        elif e["type"] == "way":
            pts = [p for p in e.get("geometry") or [] if p]
        else:
            pts = [p for m in e.get("members", []) for p in (m.get("geometry") or ([m] if "lon" in m else [])) if p]
        for p in pts:
            lon.append(p["lon"]); lat.append(p["lat"]); owner.append(k)
    boxes = [None] * len(els)
    if not lon:
        return boxes
    x, y = tr.transform(np.array(lon), np.array(lat))
    c, r = aoi.to_grid(x, y)
    owner = np.array(owner)
    order = np.argsort(owner, kind="stable")
    owner, c, r = owner[order], c[order], r[order]
    starts = np.flatnonzero(np.r_[True, owner[1:] != owner[:-1]])
    c0, c1 = np.minimum.reduceat(c, starts), np.maximum.reduceat(c, starts)
    r0, r1 = np.minimum.reduceat(r, starts), np.maximum.reduceat(r, starts)
    for i, k in enumerate(owner[starts]):
        boxes[k] = (c0[i], r0[i], c1[i], r1[i])
    return boxes


def cut_osm(ws, rdir, src=None):
    """each region's cut of data/raw/osm.json into rdir(w)/osm.json (written only when it changed); returns {w: hash
    of its elements}"""
    import landmarks
    src = Path(src or f"{aoi.RAW}/osm.json")
    data = json.load(open(src))
    els = data.pop("elements")
    boxes = _osm_boxes(els)
    named = {f.get("name", n) for n, f in landmarks.LABELS.items()} | set(landmarks.LABELS)
    always = np.array([b is None or e.get("tags", {}).get("name") in named for e, b in zip(els, boxes)])
    bb = np.array([b if b is not None else (0, 0, 0, 0) for b in boxes], float).reshape(-1, 4)
    out = {}
    for w in ws:
        ra, rb, ca, cb = w.region(_halo())
        m = always | ((bb[:, 2] >= ca - OSM_MARGIN) & (bb[:, 0] <= cb + OSM_MARGIN)
                      & (bb[:, 3] >= ra - OSM_MARGIN) & (bb[:, 1] <= rb + OSM_MARGIN))
        sub = [els[i] for i in np.flatnonzero(m)]
        body = json.dumps(sub, separators=(",", ":"), ensure_ascii=False)
        h = sha(body.encode())
        d = rdir(w)
        d.mkdir(parents=True, exist_ok=True)
        stamp = d / "osm.sha"
        if not (d / "osm.json").exists() or not stamp.exists() or stamp.read_text() != h:
            head = json.dumps(data, separators=(",", ":"), ensure_ascii=False)[:-1]
            (d / "osm.json").write_text(head + (',' if data else '') + '"elements":' + body + "}")
            stamp.write_text(h)
        out[w] = h
    return out


def _halo():
    import region
    return region.HALO


# ---------------------------------------------------------------- a region's key

def config_part():
    c = aoi.CONFIG
    return {k: c[k] for k in ("crs", "grid", "anchor", "map", "base", "rivers")}


def region_key(w, osm_hash, deps, features=None):
    """the hash of everything region w's build reads (deps: the code files it loaded last time, scripts/-relative;
    features: the large features' decisions it looked up, features.py)"""
    import region
    box = w.region(region.HALO)
    d = dict(box=list(box), core=[w.r0, w.r1, w.c0, w.c1], config=config_part(), osm=osm_hash,
             rasters={p: raster_hash(p, box) for p in RASTERS}, raw={p: file_sha(p) for p in RAW_FILES},
             env={k: os.environ.get(k) for k in ENV}, code={f: code_sha(HERE / f) for f in sorted(deps)})
    if features is not None:
        d["features"] = features
    return sha(json.dumps(d, sort_keys=True).encode()), d


def palette_sig(n):
    """the hash of the registry's first n colours"""
    reg = json.load(open(HERE / "palette.json"))["palette"]
    if len(reg) < n:
        return None
    return sha(json.dumps(reg[:n]).encode())


def deps_of_process():
    """the files of scripts/ this process has loaded (for its out.json), and the data files of scripts/ it reads"""
    import sys
    fs = set()
    for m in list(sys.modules.values()):
        f = getattr(m, "__file__", None)
        if f and Path(f).resolve().parent == HERE:
            fs.add(Path(f).name)
    return sorted(fs | {"overrides.json"})
