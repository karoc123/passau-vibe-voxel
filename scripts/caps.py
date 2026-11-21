"""Sloped surfaces as data: the `caps` section of the level-1 nodes (tilefile.py SECTIONS; web/src/core/surface.ts
reads it; docs/plans/surface-caps.md).

A cap replaces the flat top face of one run of one column by a quad with four corner heights (1/64 m above the
volume's floor). Per column at most two: on the run that ends at the ground (grnd) and on the column's last run above
it (a bridge's deck). The section, uint16[6 * n], little-endian, planar (six arrays of n values one after the other):

  dcol  the column (row-major over S x S, S = N + 2, apron included, as cnts counts them) less the previous record's
  dz    zigzag(ztop less the previous record's ztop); ztop: the top (cells) of the run whose top face the cap replaces
  d0..d3  zigzag(corner less ztop * 64); corners 0: (x, y), 1: (x + 1, y), 2: (x + 1, y + 1), 3: (x, y + 1)

records sorted by column, then ztop; zigzag(v) = (v << 1) ^ (v >> 15) on int16. No record with all four deltas 0 (a
flat cap is no cap); no section at all in a node without caps.
"""
import numpy as np


def zigzag(v):
    v = np.asarray(v, np.int64)
    assert (v >= -32768).all() and (v <= 32767).all(), "caps: a value past int16"
    return ((v << 1) ^ (v >> 15)) & 0xFFFF


def unzig(u):
    u = np.asarray(u, np.int64)
    return (u >> 1) ^ -(u & 1)


def encode(col, ztop, q):
    """records (column, ztop, corners q[n, 4] absolute in 1/64 cell) -> the section's bytes (b"" for none)"""
    col, ztop, q = np.asarray(col, np.int64), np.asarray(ztop, np.int64), np.asarray(q, np.int64).reshape(-1, 4)
    if not len(col):
        return b""
    o = np.lexsort((ztop, col))
    col, ztop, q = col[o], ztop[o], q[o]
    dcol = np.diff(col, prepend=0)
    assert (dcol >= 0).all() and (dcol < 65536).all()
    planes = [dcol, zigzag(np.diff(ztop, prepend=0))] + [zigzag(q[:, k] - ztop * 64) for k in range(4)]
    return np.concatenate(planes).astype("<u2").tobytes()


def decode(buf):
    """the section's bytes -> (column, ztop, q[n, 4]) as encode took them"""
    a = np.frombuffer(buf, "<u2").astype(np.int64)
    n = len(a) // 6
    col = np.cumsum(a[:n])
    ztop = np.cumsum(unzig(a[n:2 * n]))
    q = np.stack([ztop * 64 + unzig(a[(2 + k) * n:(3 + k) * n]) for k in range(4)], 1)
    return col, ztop, q
