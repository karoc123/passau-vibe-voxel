"""What the open data says about one building or street, for writing its override (scripts/overrides.py): a picture of
the orthophoto (DOP20), the surface model (DOM20) and the LoD2 roofs round it with the OSM outline drawn in, and the
numbers an override's parameters come from (heights over the ground, the roof's shape and ridge direction, the
roof's colour, OSM's tags).

usage: uv run python scripts/look.py building|street ID [--out DIR] [--pad METRES]
  DIR/look.png   orthophoto | surface model (hillshade, heights coloured) | LoD2 roof heights; the OSM outline (or the
                 street's centre line) in red, a 10 m grid in white; north up, 5 px per metre
  DIR/look.json  the numbers, also printed

Reads data/raw/osm.json, data/orto.npy, data/prep.npz, data/lod2.npz (only the box round the object). Open data only:
Bayerische Vermessungsverwaltung (CC BY 4.0) and OpenStreetMap (ODbL).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

import aoi
import overrides
import window

RTYPE = {1000: "flat", 2100: "shed (skillion)", 2200: "sawtooth", 3100: "gabled", 3200: "hipped", 3300: "half-hipped",
         3400: "mansard", 3500: "pyramidal", 3600: "barrel", 3700: "pavilion", 3800: "conical", 3900: "dome",
         4000: "other"}
S = 5  # px per metre (the orthophoto's)


def _pct(a, q):
    a = a[np.isfinite(a)]
    return round(float(np.percentile(a, q)), 1) if a.size else None


def main(argv):
    if len(argv) < 2 or argv[0] not in overrides.KINDS:
        raise SystemExit(__doc__)
    kind, ident = argv[0], argv[1]
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path(f"data/look/{kind}_{ident}")
    pad = float(argv[argv.index("--pad") + 1]) if "--pad" in argv else 20.0
    otype, oid = overrides.parse_name(kind, ident.removeprefix("w"))
    data = json.load(open(f"{aoi.RAW}/osm.json"))
    e = next((x for x in data["elements"] if x["type"] == otype and x["id"] == oid), None)
    if e is None:
        raise SystemExit(f"OSM {otype} {oid} is not in data/raw/osm.json")
    tr = Transformer.from_crs(4326, aoi.CRS, always_xy=True)
    rings = [[p for p in e.get("geometry") or [] if p]] if otype == "way" else \
        [[p for p in m.get("geometry") or [] if p] for m in e.get("members", []) if m.get("geometry")]
    rings = [[tuple(float(v) for v in aoi.to_grid(*tr.transform(p["lon"], p["lat"]))) for p in r] for r in rings if r]
    pts = np.array([p for r in rings for p in r])
    c0, r0 = (int(math.floor(v - pad)) for v in pts.min(0))
    c1, r1 = (int(math.ceil(v + pad)) for v in pts.max(0))
    c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1, aoi.MAP_W), min(r1, aoi.MAP_D)
    if c1 <= c0 or r1 <= r0:
        raise SystemExit("the object is off the map")
    box = (r0, r1, c0, c1)
    orto = np.array(np.load("data/orto.npy", mmap_mode="r")[r0 * S:r1 * S, c0 * S:c1 * S])
    dsm = window.npz_region("data/prep.npz", "dsm", (r0 * 2, r1 * 2, c0 * 2, c1 * 2))
    dtm = window.npz_region("data/prep.npz", "dtm", box)
    lz = window.npz_region("data/lod2.npz", "z", box)
    rtype = window.npz_region("data/lod2.npz", "rtype", box)
    bid = window.npz_region("data/lod2.npz", "bid", box)
    gx, gy = window.npz_region("data/lod2.npz", "gx", box), window.npz_region("data/lod2.npz", "gy", box)

    # the footprint (building) or the way's corridor (street) as a mask of the box's cells
    from shapely.geometry import LineString, Polygon
    import rasterio.features
    from affine import Affine
    t = e.get("tags", {})
    if kind == "building":
        geom = Polygon(rings[0]) if len(rings) == 1 else Polygon(max(rings, key=lambda r: Polygon(r).area))
    else:
        geom = LineString(rings[0]).buffer(max(overrides.street_width(t), 2) / 2, cap_style="flat")
    m = rasterio.features.rasterize([(geom, 1)], out_shape=dtm.shape, transform=Affine.translation(c0, r0)) > 0
    ground = float(np.median(dtm[m])) if m.any() else float(np.median(dtm))
    dsm1 = dsm.reshape(dtm.shape[0], 2, dtm.shape[1], 2).max((1, 3))
    info = dict(osm=f"{otype}/{oid}", tags=t, ground_m_asl=round(ground, 1),
                box_map_cells=dict(col=[c0, c1], row=[r0, r1]), cells=int(m.sum()))
    if kind == "building":
        h = dsm1[m] - ground
        info["dom20_over_ground"] = dict(p10=_pct(h, 10), p50=_pct(h, 50), p90=_pct(h, 90), p98=_pct(h, 98),
                                         max=_pct(h, 100))
        lh = lz[m] - ground
        k = bid[m][bid[m] > 0]
        if lh[np.isfinite(lh)].size:
            main_b = int(np.bincount(k).argmax()) if k.size else 0
            rt = int(np.bincount(rtype[m][rtype[m] > 0]).argmax()) if (rtype[m] > 0).any() else 0
            # the ridge's direction: perpendicular to the steepest planes' mean gradient (axial mean, doubled angle)
            g_ = np.stack([gx[m], gy[m]], 1)
            g_ = g_[np.isfinite(g_).all(1) & (np.hypot(*g_.T) > 0.2)]
            ridge = None
            if len(g_):
                a2 = np.arctan2(g_[:, 1], g_[:, 0]) * 2
                mean = math.atan2(np.sin(a2).mean(), np.cos(a2).mean()) / 2  # gradient direction (east, south)
                ridge = round((math.degrees(mean) + 360) % 180, 0)  # the ridge runs across it: bearing from north
            info["lod2"] = dict(roof_type=RTYPE.get(rt, rt), eaves_p10=_pct(lh, 10), ridge_p98=_pct(lh, 98),
                                slope_median=_pct(np.hypot(gx[m], gy[m]), 50), ridge_bearing_deg=ridge,
                                buildings=int(len(set(k.tolist()))), main_building_cells=int((k == main_b).sum()))
        else:
            info["lod2"] = None
        # towers: what stands 4 m and more over the roof's 90th percentile, each with its centre (EPSG:25832), top,
        # and its width at every 2 m down from the top (a spire narrows fast, an onion bulges, a tower is straight)
        from scipy import ndimage
        hd = dsm - ground  # (0.5 m cells)
        m2 = np.repeat(np.repeat(m, 2, 0), 2, 1)
        p90 = np.percentile(hd[m2], 90)
        lab, n = ndimage.label(m2 & (hd > p90 + 4))
        towers = []
        for i in range(1, n + 1):
            k = lab == i
            if k.sum() < 8:
                continue
            top = float(hd[k].max())
            yy, xx = np.nonzero(k)
            prof = []
            for dz in range(0, int(top - p90), 2):
                kk = m2 & (hd >= top - dz) & ndimage.binary_dilation(k, iterations=12)
                prof.append([round(top - dz, 1), round(2 * math.sqrt(kk.sum() * 0.25 / math.pi), 1)])
            ex, ny = aoi.to_world(c0 + (xx.mean() + 0.5) / 2, r0 + (yy.mean() + 0.5) / 2)
            # (the orthophoto leans a tall tower's top away from the centre of the image: its colour is a hint)
            oc = orto[np.minimum((yy * 2.5 + 1).astype(int), orto.shape[0] - 1), np.minimum((xx * 2.5 + 1).astype(int), orto.shape[1] - 1)]
            towers.append(dict(centre_epsg25832=[round(float(ex), 1), round(float(ny), 1)], top_over_ground=round(top, 1),
                               width_at_height=prof, ortho_hex="#%02x%02x%02x" % tuple(int(v) for v in np.median(oc, 0))))
        info["dom20_towers"] = towers
        ortho_cells = orto.reshape(dtm.shape[0], S, dtm.shape[1], S, 3).mean((1, 3))[m]
        info["ortho_roof_rgb_median"] = [int(v) for v in np.median(ortho_cells, 0)]
        info["ortho_roof_hex"] = "#%02x%02x%02x" % tuple(info["ortho_roof_rgb_median"])
    else:
        info["way_width_drawn_m"] = overrides.street_width(t)
        info["length_m"] = round(LineString(rings[0]).length, 1)
        info["ground_range_m"] = [_pct(dtm[m], 0), _pct(dtm[m], 100)]
    info["focus"] = f"?focus={'bld' if kind == 'building' else 'street'}:{ident}"

    # the picture: three panels at 5 px per metre
    H_, W_ = orto.shape[:2]

    def hill(z, scale):
        zz = np.nan_to_num(z, nan=np.nanmin(z) if np.isfinite(z).any() else 0)
        dy, dx = np.gradient(zz, 1.0 / scale)
        shade = np.clip(0.6 + 0.4 * (-dx - dy) / np.sqrt(1 + dx * dx + dy * dy), 0, 1)
        lo, hi = np.nanpercentile(zz, 2), np.nanpercentile(zz, 99.5)
        v = np.clip((zz - lo) / max(hi - lo, 1), 0, 1)
        rgb = np.stack([v, 0.3 + 0.5 * (1 - abs(v - 0.5) * 2), 1 - v], -1) * shade[..., None]
        rgb[~np.isfinite(z)] = 0.1
        im = Image.fromarray((rgb * 255).astype(np.uint8))
        return im.resize((W_, H_), Image.NEAREST)

    panels = [Image.fromarray(orto), hill(dsm, 2), hill(lz, 1)]
    for im in panels:
        d = ImageDraw.Draw(im)
        for x in range(int(math.ceil(c0 / 10)) * 10, c1, 10):
            d.line([((x - c0) * S, 0), ((x - c0) * S, H_)], fill=(255, 255, 255), width=1)
        for y in range(int(math.ceil(r0 / 10)) * 10, r1, 10):
            d.line([(0, (y - r0) * S), (W_, (y - r0) * S)], fill=(255, 255, 255), width=1)
        for r in rings:
            d.line([((x - c0) * S, (y - r0) * S) for x, y in r], fill=(255, 40, 40), width=2)
    full = Image.new("RGB", (W_ * 3 + 20, H_), (0, 0, 0))
    for k, im in enumerate(panels):
        full.paste(im, (k * (W_ + 10), 0))
    out.mkdir(parents=True, exist_ok=True)
    full.save(out / "look.png")
    (out / "look.json").write_text(json.dumps(info, indent=1, ensure_ascii=False))
    print(json.dumps(info, indent=1, ensure_ascii=False))
    print(f"picture: {out / 'look.png'} (orthophoto | surface model | LoD2; grid lines every 10 m, map cells "
          f"{c0}..{c1} east, {r0}..{r1} south)")


if __name__ == "__main__":
    main(sys.argv[1:])
