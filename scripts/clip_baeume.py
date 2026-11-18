"""Cut the Bavarian single-tree layer (Einzelbäume 3D, one GeoPackage per district) to the AOI, once, at fetch time.

Usage: python -I scripts/clip_baeume.py <district.gpkg> <out.csv> x0 y0 x1 y1
The GeoPackage (data/raw/baeume_dl/, ~370 MB) is read with sqlite3 only, read-only; its tables are one per km of
northing ("5389_trees": POINT geom in EPSG:25832, dgmhoehe = ground, baumhoehe = tree height). The geometry blobs
are parsed by hand (GeoPackage header + little/big-endian WKB point), nothing in the file is executed. Output: a small
CSV x,y,ground,height (m, 0.1 m), sorted, so the pipeline needs only that.
"""
import csv
import re
import sqlite3
import struct
import sys


def point(blob):
    if blob[:2] != b"GP":
        return None
    flags = blob[3]
    env = (0, 32, 48, 48, 64)[(flags >> 1) & 7]
    w = blob[8 + env:]
    bo = "<" if w[0] == 1 else ">"
    if struct.unpack(bo + "I", w[1:5])[0] % 1000 != 1:  # a point (2D, Z or M variants)
        return None
    return struct.unpack(bo + "dd", w[5:21])


def main(src, out, x0, y0, x1, y1):
    con = sqlite3.connect(f"file:{src}?mode=ro&immutable=1", uri=True)
    names = [n for (n,) in con.execute("select table_name from gpkg_contents where data_type = 'features'")]
    rows = []
    for name in names:
        m = re.fullmatch(r"(\d+)_trees", name)
        if not m or not (y0 // 1000 <= int(m.group(1)) <= y1 // 1000):
            continue
        for geom, gnd, h in con.execute(f'select geom, dgmhoehe, baumhoehe from "{name}"'):
            p = point(geom) if isinstance(geom, bytes) else None
            if p and x0 <= p[0] < x1 and y0 <= p[1] < y1 and h is not None:
                rows.append((round(p[0], 1), round(p[1], 1), round(float(gnd or 0), 1), round(float(h), 1)))
    rows.sort()
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(("x", "y", "ground", "height"))
        w.writerows(rows)
    print(len(rows), "trees in the AOI ->", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7]))
