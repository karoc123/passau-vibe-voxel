"""Roof planes from the Bavarian LoD2 building models, rasterized on the voxel grid.

Source: Bayerische Vermessungsverwaltung, 3D-Gebäudemodelle LoD2 (CityGML 1.0, CC BY 4.0, www.geodaten.bayern.de),
2 km tiles in EPSG:25832 + DHHN2016 heights (the DGM1's datum), fetched by scripts/fetch_bayern.sh into data/raw/lod2.
The surface model DOM20 is matched from aerial images: on a pitched roof it is a noisy staircase of 1 m samples, every
dormer, chimney and matching error a step. The LoD2 roofs are planes fitted to the airborne laser scan per building
(ridge, eaves, hips, flat parts): voxelize.py takes their heights where they agree with the surface model.

Output data/lod2.npz (grid D x W, cell (r, c) sampled at its centre):
  z      roof height a.s.l. (m), the highest roof plane over the cell, NaN where there is none
  slope  that plane's rise per metre (0 flat, 1 = 45 degrees)
  bid    the LoD2 building's index (0: none), for per-building statistics
  rtype  the building's roofType code (1000 flat, 2100 shed, 3100 gable, 3200 hip, ...; 0 none)
  cen    the cell's centre lies inside a roof polygon (the building's footprint as the cadastre has it; z, slope and
         bid also cover cells a polygon only touches, a cell wider all round)
"""
import glob
import math
import sys
import xml.etree.ElementTree as ET

import numpy as np
import rasterio.features
from affine import Affine
from shapely.geometry import Polygon

from aoi import D, RAW, W, to_grid

GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/1.0}"


def ring(el):
    pl = el.find(f".//{GML}posList")
    if pl is not None:
        v = np.array(pl.text.split(), float)
    else:
        v = np.array([float(x) for p in el.iter(f"{GML}pos") for x in p.text.split()])
    v = v.reshape(-1, 3)
    c, r = to_grid(v[:, 0], v[:, 1])
    return np.c_[c, r, v[:, 2]]


def roof_polys(path):
    """(building index, roofType, [rings in grid coords + z]) for every roof polygon of every building in a tile."""
    bi = 0
    for ev, el in ET.iterparse(path, events=("end",)):
        if el.tag != f"{BLDG}Building":
            continue
        bi += 1
        rt = el.find(f"{BLDG}roofType")
        rtype = int(rt.text) if rt is not None and rt.text and rt.text.isdigit() else 0
        for rs in el.iter(f"{BLDG}RoofSurface"):
            for poly in rs.iter(f"{GML}Polygon"):
                ext = poly.find(f"{GML}exterior")
                if ext is None:
                    continue
                yield bi, rtype, ring(ext), [ring(i) for i in poly.findall(f"{GML}interior")]
        el.clear()


def main():
    z = np.full((D, W), np.nan, np.float32)
    slope = np.zeros((D, W), np.float32)
    bid = np.zeros((D, W), np.int32)
    rtype = np.zeros((D, W), np.int16)
    cen_m = np.zeros((D, W), bool)
    base = 0
    n_poly = 0
    for path in sorted(glob.glob(f"{RAW}/lod2/*.gml")):
        nb = 0
        for bi, rt, ext, holes in roof_polys(path):
            nb = max(nb, bi)
            if ext[:, 0].max() < 0 or ext[:, 0].min() > W or ext[:, 1].max() < 0 or ext[:, 1].min() > D:
                continue
            # the plane (Newell's normal): z = z0 - (nx (c - c0) + ny (r - r0)) / nz
            p, q = ext, np.roll(ext, -1, 0)
            n = np.array([((p[:, 1] - q[:, 1]) * (p[:, 2] + q[:, 2])).sum(),
                          ((p[:, 2] - q[:, 2]) * (p[:, 0] + q[:, 0])).sum(),
                          ((p[:, 0] - q[:, 0]) * (p[:, 1] + q[:, 1])).sum()])
            if np.linalg.norm(n) == 0 or abs(n[2]) < 0.15 * np.linalg.norm(n):
                continue  # vertical pieces (a step in the roof, a dormer's cheek)
            o = ext.mean(0)
            geom = Polygon(ext[:, :2], [h[:, :2] for h in holes])
            if not geom.is_valid:
                geom = geom.buffer(0)
            if geom.is_empty:
                continue
            minx, miny, maxx, maxy = geom.bounds
            c0, r0 = max(int(math.floor(minx)), 0), max(int(math.floor(miny)), 0)
            c1, r1 = min(int(math.ceil(maxx)), W), min(int(math.ceil(maxy)), D)
            if c0 >= c1 or r0 >= r1:
                continue
            m = rasterio.features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0),
                                            transform=Affine.translation(c0, r0), dtype=np.uint8)
            # cells whose centre the polygon misses but touches (a roof's edge, a narrow strip) are filled below
            # only where no other plane covers them
            mt = rasterio.features.rasterize([(geom, 2)], out_shape=(r1 - r0, c1 - c0),
                                             transform=Affine.translation(c0, r0), all_touched=True, dtype=np.uint8)
            rr, cc = np.nonzero(mt)
            cen = m[rr, cc] > 0
            rr, cc = rr + r0, cc + c0
            zz = o[2] - (n[0] * (cc + 0.5 - o[0]) + n[1] * (rr + 0.5 - o[1])) / n[2]
            zz = np.clip(zz, ext[:, 2].min(), ext[:, 2].max())  # touched cells: no extrapolation past the plane
            s = math.hypot(n[0], n[1]) / abs(n[2])
            # centre cells: the highest plane wins; touched-only cells: only where nothing else is
            cur = z[rr, cc]
            weak = bid[rr, cc] < 0
            k = np.isnan(cur) | np.where(cen, weak | (zz > cur), weak & (zz > cur))
            z[rr[k], cc[k]] = zz[k]
            slope[rr[k], cc[k]] = s
            bid[rr[k], cc[k]] = np.where(cen[k], base + bi, -(base + bi))
            rtype[rr[k], cc[k]] = rt
            cen_m[rr[cen], cc[cen]] = True
            n_poly += 1
        base += nb + 1
        print(path, "buildings", nb, file=sys.stderr)
    bid = np.abs(bid)
    print("roof polygons", n_poly, "cells", int(np.isfinite(z).sum()), file=sys.stderr)
    np.savez_compressed("data/lod2.npz", z=z, slope=slope, bid=bid, rtype=rtype, cen=cen_m)


if __name__ == "__main__":
    main()
