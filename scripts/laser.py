"""The airborne LiDAR point clouds (Laserdaten, Bayerische Vermessungsverwaltung, CC BY 4.0; scripts/fetch_bayern.sh)
reduced to per-cell vegetation statistics on the AOI grid (scripts/aoi.py), for the trees in scripts/voxelize.py.

The scan is from February 2021, leaf-off, ~11 points/m2 with up to 5 returns per pulse; classes 2 ground, 6
building, 20 vegetation (7 noise, 23 other). What it adds to the image-matched surface model (DOM20, June 2024):
- the canopy's own height, measured, not matched in the photos: DOM20 over trees is off by > 2 m in a third of the
  cells (frayed rims, crowns smeared into the gaps);
- what lies under the canopy: the lowest returns in a crown are its lowest branches, the crown's base -- biased low
  by the season (bare twigs and the trunk itself reflect where in summer the leaves would hide them);
- in winter a broadleaf crown is mostly air: half the pulses pass its twigs and reach the ground. A conifer keeps
  its needles and stops them (spruce, pine, fir, yew, thuja): the share of first returns caught in the canopy tells
  the two apart.
DOM20 stays the authority on whether a tree stands (felled or planted since 2021).

Output data/laser.npz, all (D, W) on the 1 m grid, heights above the DGM1 terrain (data/prep.npz) in decimetres:
  n_pulse  uint16  first returns in the cell (the pulses)
  n_canopy uint16  of them, the ones caught by vegetation 3 m or more above the ground
  n_single uint16  of those, the pulses with that one return only (stopped in the crown, nothing behind)
  n_ground uint16  ground returns (any return number)
  int_canopy uint16 the canopy first returns' summed intensity / 16
  veg_n    uint16  vegetation returns 1.5 m or more above the ground (any return number)
  veg_top  int16   the highest vegetation return (0 where none)
  veg_p10  int16   10th percentile of those returns (the crown's underside where the cell is in a crown)
  veg_p50  int16   their median
  n_ret    uint16  returns of any class (none: water, or no data)
"""
import glob

import laspy
import numpy as np

from aoi import CX, CY, D, I0, J0, RAW, W

KEYS = ("n_pulse", "n_canopy", "n_single", "n_ground", "int_canopy", "veg_n", "veg_top", "veg_p10", "veg_p50", "n_ret")


def percentile_per_cell(idx, h, q, n_cells):
    """q-quantile of h per cell index (lower nearest rank), cells without points 0."""
    o = np.lexsort((h, idx))
    idx, h = idx[o], h[o]
    cnt = np.bincount(idx, minlength=n_cells)
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    have = cnt > 0
    out = np.zeros(n_cells, h.dtype)
    out[have] = h[start[have] + (q * (cnt[have] - 1)).astype(np.int64)]
    return out


def main():
    dtm = np.asarray(np.load("data/prep.npz")["dtm"], np.float32)
    assert dtm.shape == (D, W)
    out = {k: np.zeros(D * W, np.int16 if k.startswith("veg_") and k != "veg_n" else np.uint16) for k in KEYS}
    files = sorted(glob.glob(f"{RAW}/laser/*.laz"))
    assert files, "no LAZ tiles in data/raw/laser (scripts/fetch_bayern.sh)"
    for p in files:
        las = laspy.read(p)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z, np.float32)
        cls = np.asarray(las.classification)
        rn = np.asarray(las.return_number)
        nr = np.asarray(las.number_of_returns)
        it = np.asarray(las.intensity, np.float64)
        c = np.floor(I0 + (x - CX)).astype(np.int64)
        r = np.floor(J0 - (y - CY)).astype(np.int64)
        ok = (c >= 0) & (c < W) & (r >= 0) & (r < D) & (cls != 7)
        c, r, z, cls, rn, nr, it = c[ok], r[ok], z[ok], cls[ok], rn[ok], nr[ok], it[ok]
        del x, y, las
        idx = r * W + c
        h = z - dtm[r, c]
        veg = cls == 20
        out["n_ret"] += np.minimum(np.bincount(idx, minlength=D * W), 65535).astype(np.uint16)
        first = rn == 1
        out["n_pulse"] += np.bincount(idx[first], minlength=D * W).astype(np.uint16)
        can = first & veg & (h >= 3)
        out["n_canopy"] += np.bincount(idx[can], minlength=D * W).astype(np.uint16)
        out["n_single"] += np.bincount(idx[can & (nr == 1)], minlength=D * W).astype(np.uint16)
        out["n_ground"] += np.bincount(idx[cls == 2], minlength=D * W).astype(np.uint16)
        out["int_canopy"] += np.minimum(np.bincount(idx[can], weights=it[can], minlength=D * W) / 16, 65535).astype(np.uint16)
        v = veg & (h >= 1.5)
        vi, vh = idx[v], np.round(np.clip(h[v], 0, 3000) * 10).astype(np.int16)
        out["veg_n"] += np.bincount(vi, minlength=D * W).astype(np.uint16)
        top = np.zeros(D * W, np.int16)
        np.maximum.at(top, vi, vh)
        out["veg_top"] = np.maximum(out["veg_top"], top)
        # tiles share no cells (1 km sheets on whole metres, the grid on whole metres): a cell's percentiles come
        # from one sheet
        for k, q in (("veg_p10", 0.1), ("veg_p50", 0.5)):
            pc = percentile_per_cell(vi, vh, q, D * W)
            out[k] = np.where(pc > 0, pc, out[k])
        print(p, int(ok.sum()), "points,", int(v.sum()), "vegetation returns above 1.5 m")
    np.savez_compressed("data/laser.npz", **{k: a.reshape(D, W) for k, a in out.items()})
    print("cells with vegetation returns:", int((out["veg_n"] > 0).sum()), "without any return:", int((out["n_ret"] == 0).sum()))


if __name__ == "__main__":
    main()
