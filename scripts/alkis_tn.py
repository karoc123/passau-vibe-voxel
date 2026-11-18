"""ALKIS Tatsächliche Nutzung (actual land use) of the Bavarian surveying administration, CC BY 4.0
(data/raw/tn_09262.zip, Stadt Passau, from scripts/fetch_bayern.sh): one polygon per parcel of use, covering the whole
town -- forest, grassland, arable land, park, Gehölz, Unland, car parks, cemeteries, streets, water.

Read with a small shapefile reader of its own (polygons and a dBASE table, straight from the zip), no GDAL/OGR
binding needed. The archive is downloaded data: only its .shp, .shx and .dbf members are read, as bytes.
"""
import struct
import zipfile
from pathlib import Path

import numpy as np
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.polygon import orient

from aoi import RAW

TN_ZIP = Path(RAW) / "tn_09262.zip"


def _dbf(buf):
    n, hlen, rlen = struct.unpack("<IHH", buf[4:12])
    fields, p = [], 32
    while buf[p] != 0x0D:
        name = buf[p:p + 11].split(b"\0")[0].decode("ascii", "replace")
        fields.append((name, buf[p + 16]))
        p += 32
    out = []
    for i in range(n):
        r = buf[hlen + i * rlen: hlen + (i + 1) * rlen]
        rec, q = {}, 1  # (byte 0: the deletion flag)
        for name, ln in fields:
            rec[name] = r[q:q + ln].decode("utf-8", "replace").strip()
            q += ln
        out.append(rec)
    return out


def _polygon(rec):
    """a shapefile polygon record (type 5): rings, clockwise outer and counter-clockwise holes"""
    if len(rec) < 44 or struct.unpack("<i", rec[:4])[0] != 5:
        return None
    nparts, npts = struct.unpack("<ii", rec[36:44])
    parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])) + [npts]
    xy = np.frombuffer(rec, "<f8", 2 * npts, 44 + 4 * nparts).reshape(-1, 2)
    shells, holes = [], []
    for a, b in zip(parts[:-1], parts[1:]):
        ring = xy[a:b]
        if len(ring) < 4:
            continue
        area2 = float(np.sum(ring[:-1, 0] * ring[1:, 1] - ring[1:, 0] * ring[:-1, 1]))
        (shells if area2 < 0 else holes).append(Polygon(ring))
    if not shells:
        return None
    polys = []
    for s in shells:
        hs = [h.exterior.coords for h in holes if s.contains(h.representative_point())]
        polys.append(orient(Polygon(s.exterior.coords, hs)))
    g = polys[0] if len(polys) == 1 else MultiPolygon(polys)
    return g if g.is_valid else g.buffer(0)


def read(bounds):
    """[(nutzart, bez, polygon in EPSG:25832)] of the parcels whose bounding box meets bounds (minx, miny, maxx, maxy)"""
    with zipfile.ZipFile(TN_ZIP) as z:
        names = {Path(n).suffix.lower(): n for n in z.namelist()}
        shp, shx, dbf = (z.read(names[k]) for k in (".shp", ".shx", ".dbf"))
    recs = _dbf(dbf)
    offs = np.frombuffer(shx, ">i4", count=(len(shx) - 100) // 4, offset=100).reshape(-1, 2)
    x0, y0, x1, y1 = bounds
    out = []
    for i, (o, ln) in enumerate(offs):
        p = 2 * o + 8
        body = shp[p:p + 2 * ln]
        bx0, by0, bx1, by1 = struct.unpack("<4d", body[4:36]) if len(body) >= 36 else (0, 0, -1, -1)
        if bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1:
            continue
        g = _polygon(body)
        if g is not None and not g.is_empty:
            out.append((recs[i].get("nutzart", ""), recs[i].get("bez", ""), g))
    return out


if __name__ == "__main__":
    import collections
    from aoi import world_bounds
    from shapely.geometry import box
    b = world_bounds()
    aoi_ = box(*b)
    area = collections.Counter()
    for nutz, bez, g in read(b):
        area[f"{nutz} | {bez}"] += g.intersection(aoi_).area
    for k, a in area.most_common(60):
        print(f"{a / 1e4:8.2f} ha  {k}")
    print("covered", sum(area.values()) / aoi_.area)
