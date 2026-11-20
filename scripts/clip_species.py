"""Cut the map's window out of a Germany-wide tree species map (DLR "Tree Species Germany", 2022 or 2016), at fetch time.

Usage: python -I scripts/clip_species.py <url of the cloud-optimised GeoTIFF> <out.tif> x0 y0 x1 y1
(x0 .. y1: the map's bounds in EPSG:25832). The file (~530 MB, EPSG:3035, 10 m, uint16, nodata 999, 512 x 512 tiles)
is read over HTTP ranges through GDAL's /vsicurl/: only the tiles under the window (about 1 MB), never the whole of
it. The window is the bounds in the file's own CRS plus a pixel round it, written as it is (no reprojection: the raw
data stays raw; scripts/species_map.py puts it on the map's grid), LZW. Classes (the file's readme): 0 pine, 1 spruce,
2 Douglas fir, 3 larch, 4 fir, 5 beech, 6 oak, 7 birch, 8 alder, 9 other broadleaved; 666 canopy cover loss (2022),
800 uncertain (2016), 999 no forest.
"""
import math
import sys

import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds


def main(url, out, x0, y0, x1, y1):
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="5")
    with rasterio.Env(**env), rasterio.open("/vsicurl/" + url) as src:
        b = transform_bounds("EPSG:25832", src.crs, x0, y0, x1, y1, densify_pts=21)
        w = from_bounds(*b, transform=src.transform)
        c0, r0 = max(math.floor(w.col_off) - 1, 0), max(math.floor(w.row_off) - 1, 0)
        c1 = min(math.ceil(w.col_off + w.width) + 1, src.width)
        r1 = min(math.ceil(w.row_off + w.height) + 1, src.height)
        w = Window(c0, r0, c1 - c0, r1 - r0)
        a = src.read(1, window=w)
        prof = dict(driver="GTiff", width=a.shape[1], height=a.shape[0], count=1, dtype=a.dtype, crs=src.crs,
                    transform=src.window_transform(w), nodata=src.nodata, compress="lzw")
    with rasterio.open(out, "w", **prof) as dst:
        dst.write(a, 1)
    print(f"{url}: window {w.width} x {w.height} at col {w.col_off}, row {w.row_off} -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7]))
