"""The node files' container (web/public/data/tiles/{s}/{tx}_{ty}.bin, web/src/tile-data.ts decodeTile), gzip of:

  magic    b"VXT2"
  n        uint32            sections
  table    n x (tag: 4 ASCII bytes, bytes: uint32)
  data     the sections in the table's order, each padded with zeros to a multiple of 4 bytes

little-endian throughout. The sections are SECTIONS below (the registry; web/src/core/tile-sections.ts mirrors it,
web/tools/tile-roundtrip.mjs checks the two agree; docs/adr/0004-tile-sections.md). write() puts them in the registry's
order and keeps any tag it does not know, after them, sorted: a step can add a section before the registry names it
and a later read-modify-write (tile_fields.py) does not drop it; decodeTile hands such sections over raw (extra).
A file without the magic is the format before it (cnts grnd runs [plns], told apart by length).
"""
import gzip
import struct
from pathlib import Path
from typing import NamedTuple

MAGIC = b"VXT2"
N = 128  # a node's cells a side (and a level-1 tile's metres; meta.json tiles.N, web/src/tile-data.ts TILE_N)


def pack(sections):
    """sections: [(tag, bytes)] -> the container's bytes (before gzip)"""
    head = MAGIC + struct.pack("<I", len(sections))
    body = b""
    for tag, data in sections:
        assert len(tag.encode("ascii")) == 4, tag
        head += tag.encode("ascii") + struct.pack("<I", len(data))
        body += data + b"\0" * (-len(data) % 4)
    return head + body


def unpack(buf, N):
    """the container's (or an old file's) bytes -> {tag: bytes}"""
    if buf[:4] == MAGIC:
        n = struct.unpack_from("<I", buf, 4)[0]
        at, out = 8 + 8 * n, {}
        for k in range(n):
            tag = buf[8 + 8 * k:12 + 8 * k].decode()
            ln = struct.unpack_from("<I", buf, 12 + 8 * k)[0]
            out[tag] = buf[at:at + ln]
            at += ln + (-ln % 4)
        return out
    import numpy as np
    n2 = (N + 2) ** 2
    nr = int(np.frombuffer(buf, np.uint16, n2).sum())
    out = {"cnts": buf[:n2 * 2], "grnd": buf[n2 * 2:n2 * 3], "runs": buf[n2 * 3:n2 * 3 + nr * 6]}
    if len(buf) >= n2 * 5 + nr * 6:
        out["plns"] = buf[n2 * 3 + nr * 6:n2 * 5 + nr * 6]
    return out


class Section(NamedTuple):
    tag: str  # 4 ASCII bytes
    levels: str  # the levels whose nodes have it
    layout: str  # S = N + 2: the node and its one-cell apron (tiles.py, tile_fields.py)
    owner: str  # the step that writes it
    reserved: bool = False  # named, not written or read yet (decodeTile hands it over raw, as extra)


# The registry, in the order write() puts the sections in (append only: a new tag goes last, a tag is never reused).
SECTIONS = (
    Section("cnts", "1 2 4 8 1f", "uint16[S^2]: runs per column (row-major, row = south)", "tiles.py"),
    Section("grnd", "1 2 4 8 1f", "uint8[S^2]: ground level in metres", "tiles.py"),
    Section("runs", "1 2 4 8 1f", "uint16[3 * runs]: (z0, len, palette) per run, bottom up per column", "tiles.py"),
    Section("plns", "1 2 4 8", "uint16[S^2]: the roof plane of each column's top face", "tiles.py, tiles_lod.py"),
    Section("bldg", "1 2 4 8", "uint16[S^2]: the building of each cell (zones.py ids, 0: none)", "tile_fields.py"),
    Section("flod", "1 2 4 8", "uint8[2][N^2], no apron, planar: the level at which the river reaches each cell, "
            "the river bed", "tile_fields.py (flood.py)"),
    Section("fols", "1 2 4 8", "uint8[2][N^2], no apron, planar: foliage class and tree", "tile_fields.py (phenology.py)"),
    Section("spil", "1 2 4 8", "uint8[2][(N/2+2)^2], cells of 2 m, apron included, planar: the light of lit windows on "
            "the street before them, two kinds", "tile_fields.py spill_map"),
    Section("room", "1 (nodes with rooms)", "uint16[4 * spans]: (column, z0, len, fill) per span of voxels carved out of "
            "a building as a room -- empty in runs -- column as cnts counts them (apron included), sorted by column, "
            "then z0; fill: the palette entry that stood there, what the distance levels and the occlusion culling "
            "count the room as", "interiors.py (tiles.room_section)"),
    Section("brik", "1 (reserved)", "RESERVED, not written or read yet: sub-metre bricks, a sparse k^3 refinement of "
            "some 1 m cells (the 1 m voxel stays their representative; docs/adr/0001-world-layers.md)",
            "future (bricks)", reserved=True),
    Section("caps", "1 (nodes with sloped ground)", "uint16[6 * n], planar: per record the column (apron included, as "
            "cnts counts them) less the previous record's, zigzag(the top of the run it caps, less the previous "
            "record's), zigzag(each of its 4 corner heights in 1/64 m less that top * 64); sorted by column, then the "
            "run's top; at most two a column (the ground's run, the column's last run: a deck) -- the sloped surface "
            "drawn and stood on (caps.py; web/src/core/surface.ts)", "tile_fields.py (caps.py)"),
)
ORDER = [s.tag for s in SECTIONS]


def write(path, sections):
    """sections: {tag: bytes}, the registry's in ORDER, then any other tag sorted (kept, not dropped); mtime 0:
    rebuilds of unchanged nodes stay byte-identical"""
    tags = [t for t in ORDER if t in sections] + sorted(t for t in sections if t not in ORDER)
    with gzip.GzipFile(Path(path), "wb", compresslevel=9, mtime=0) as fh:
        fh.write(pack([(t, sections[t]) for t in tags]))


def read(path, N):
    return unpack(gzip.decompress(Path(path).read_bytes()), N)
