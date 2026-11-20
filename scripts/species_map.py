"""The forests' dominant tree species from remote sensing, on the region's 1 m grid: DLR "Tree Species Germany" 2022
and 2016 (DLR Earth Observation Center, Wegler et al., CC BY 4.0; Sentinel-2/-1 classifications at 10 m, forest pixels
only), cut to the map at fetch time by scripts/clip_species.py into data/raw/treespecies_2022.tif and
treespecies_2016.tif (EPSG:3035, as the files have them).

grid(): both onto the region's cells (aoi.to_world: whole metres of EPSG:25832, north-up), nearest neighbour at each
cell's centre with an exact transform (tolerance 0: the same class for a cell in whichever region it is built). The
2022 map's class where it has one; where it marks canopy cover loss (666, the bark beetle's spruce of 2018-2022, while
the laser of Feb 2021 and the register of 2024 often still have the tree) or no forest (999), the 2016 map's class
(the species before the loss), unless that is uncertain (800) or no forest too. 255 where neither has a class. None
without the files (the trees' kinds then come from OSM and the laser alone, as without this module).

per_crown(): a crown's majority class over its cells, and the share of its cells in that class.

Classes: 0 pine, 1 spruce, 2 Douglas fir, 3 larch, 4 fir (evergreen conifers but larch), 5 beech, 6 oak, 7 birch,
8 alder, 9 other broadleaved.
"""
from pathlib import Path

import numpy as np

import aoi

FILES = {y: Path(aoi.RAW) / f"treespecies_{y}.tif" for y in (2022, 2016)}
GENUS = {0: "Pinus", 1: "Picea", 2: "Pseudotsuga", 3: "Larix", 4: "Abies", 5: "Fagus", 6: "Quercus", 7: "Betula",
         8: "Alnus", 9: None}
EVERGREEN = (0, 1, 2, 4)
LARCH = 3
BROADLEAF = (5, 6, 7, 8, 9)
OTHER = 9
NONE = 255
# trees.json "sp_rs" for the map's "other broadleaved" class: neither beech, oak, birch nor alder (phenology.py)
OTHER_BROADLEAF = "other broadleaved"


def _on_grid(path):
    import rasterio
    from affine import Affine
    from rasterio.warp import Resampling, reproject
    x0, y0 = aoi.to_world(0, 0)
    dst = np.full((aoi.D, aoi.W), 999, np.uint16)
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, 1), dst, dst_transform=Affine(1, 0, float(x0), 0, -1, float(y0)), dst_crs=aoi.CRS,
                  dst_nodata=999, resampling=Resampling.nearest, tolerance=0)
    return dst


def grid():
    """[D, W] uint8 class (0-9, NONE) on the region's cells, or None without the files"""
    have = {y: p for y, p in FILES.items() if p.exists()}
    if not have:
        return None
    out = np.full((aoi.D, aoi.W), NONE, np.uint8)
    for y in sorted(have, reverse=True):  # 2022 first; 2016 where it has no class
        a = _on_grid(have[y])
        m = (out == NONE) & (a <= 9)
        out[m] = a[m]
    return out


def per_crown(cls, k, n):
    """cls: the class of each crown cell, k: its crown (0 .. n-1). -> (the crown's majority class, NONE where none of
    its cells has one; the share of the crown's cells in it)"""
    cls, k = np.asarray(cls), np.asarray(k)
    m = cls <= 9
    cnt = np.bincount(k[m] * 10 + cls[m].astype(np.int64), minlength=n * 10).reshape(n, 10)
    tot = np.bincount(k, minlength=n)
    best = cnt.argmax(1)
    nb = cnt.max(1)
    return np.where(nb > 0, best, NONE).astype(np.uint8), nb / np.maximum(tot, 1)


if __name__ == "__main__":
    g = grid()
    if g is None:
        print("no", *FILES.values())
    else:
        v, c = np.unique(g, return_counts=True)
        print("classes on the grid", g.shape, {(GENUS.get(int(a), "none") or "other"): int(b) for a, b in zip(v, c)})
