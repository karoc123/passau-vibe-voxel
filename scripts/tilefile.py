"""The node files' container (web/public/data/tiles/{s}/{tx}_{ty}.bin, web/src/tile-data.ts decodeTile), gzip of:

  magic    b"VXT2"
  n        uint32            sections
  table    n x (tag: 4 ASCII bytes, bytes: uint32)
  data     the sections in the table's order, each padded with zeros to a multiple of 4 bytes

little-endian throughout. Sections (S = N + 2, the node and its one-cell apron; tiles.py, tile_fields.py):
  cnts  uint16[S^2]        runs per column (row-major, row = south)
  grnd  uint8 [S^2]        ground level in metres
  runs  uint16[3 * runs]   (z0, len, palette) per run
  plns  uint16[S^2]        the roof plane of each column's top face (levels 1, 2, 4, 8; not 1f)
  bldg  uint16[S^2]        the building of each cell (zones.py ids, 0: none; not 1f)
  flod  uint8 [2][N^2]    per cell (no apron), one plane each: the level at which the river reaches it, the river
                           bed (flood.py)
  fols  uint8 [2][N^2]    per cell (no apron), one plane each: foliage class and tree (phenology.py)
  spil  uint8 [2][(N/2+2)^2]  per cell of twice the node's size, apron included, one plane each: the light of lit
                           windows on the street before them, two kinds (tile_fields.py spill_map)
  room  uint16[4 * spans]  level 1 only, and only in a node with rooms (scripts/interiors.py): (column, z0, len, fill)
                           per span of voxels carved out of a building as a room -- empty in runs -- column as cnts
                           counts them (apron included), sorted by column, then z0; fill: the palette entry that stood
                           there, what the distance levels (tiles.py) and the occlusion culling count the room as
A file without the magic is the format before it (cnts grnd runs [plns], told apart by length).
"""
import gzip
import struct
from pathlib import Path

MAGIC = b"VXT2"
N = 128  # a node's cells a side (and a level-1 tile's metres; meta.json tiles.N, web/src/tile-data.ts TILE_N)


def pack(sections):
    """sections: [(tag, bytes)] -> the container's bytes (before gzip)"""
    head = MAGIC + struct.pack("<I", len(sections))
    body = b""
    for tag, data in sections:
        assert len(tag) == 4
        head += tag.encode() + struct.pack("<I", len(data))
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


ORDER = ["cnts", "grnd", "runs", "plns", "bldg", "flod", "fols", "spil", "room"]


def write(path, sections):
    """sections: {tag: bytes}, written in ORDER; mtime 0: rebuilds of unchanged nodes stay byte-identical"""
    with gzip.GzipFile(Path(path), "wb", compresslevel=9, mtime=0) as fh:
        fh.write(pack([(t, sections[t]) for t in ORDER if t in sections]))


def read(path, N):
    return unpack(gzip.decompress(Path(path).read_bytes()), N)
