"""Every label on the map and how far away it shows.

The curated landmarks (landmarks.LABELS, EXTRA_LABELS, the building overrides' labels) plus the named parks, gardens, marinas
and harbours of 2.5 ha or more that none of them names. `far` is the camera distance (m) up to which a label shows;
the viewer adds its English name or kind closer in, then its facts and website.
"""
import numpy as np
from scipy import ndimage
from shapely.geometry import Point

import landmarks
from aoi import W, D

DEFAULT_FAR = 5000  # m, for a curated label that gives no `far` of its own


def site_of(tags):
    url = tags.get("website") or tags.get("contact:website")
    if not url and tags.get("contact:facebook"):
        fb = tags["contact:facebook"]
        url = fb if fb.startswith("http") else f"https://www.facebook.com/{fb}"
    return url


def roof_height(labels, osm, top_at):
    """a curated label anchored at the top stands at the highest point of its whole outline, in the finished voxels
    (the set pieces of passau.py can stand over what the surface model gave)"""
    from rasterio.features import rasterize
    from affine import Affine
    tops = {f.get("name", n): n for n, f in landmarks.LABELS.items() if f.get("anchor") == "top"}
    for l in labels:
        n = tops.get(l["name"])
        geoms = [geom for _, _, t, geom in osm.areas if n and t.get("name") == n]
        if not geoms:
            continue
        gm = max(geoms, key=lambda q: q.area)
        c0, r0, c1, r1 = (int(v) for v in gm.bounds)
        c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1, W - 1), min(r1, D - 1)
        if r1 < r0 or c1 < c0:  # (the name's largest outline lies off the map: a namesake of the label's elsewhere)
            continue
        m = rasterize([(gm, 1)], out_shape=(r1 - r0 + 1, c1 - c0 + 1), transform=Affine.translation(c0, r0)).astype(bool)
        l["z"] = max(l["z"], max(top_at(r0 + r, c0 + c) for r, c in zip(*np.nonzero(m))))


def finish(labels):
    for l in labels:
        l["far"] = l.get("far") or DEFAULT_FAR
    labels.sort(key=lambda l: -l["far"])  # (stable: the curated order within one distance)
    kept = []
    for l in labels:
        if not l.get("auto") or all((l["x"] - k["x"]) ** 2 + (l["y"] - k["y"]) ** 2 > 15 ** 2 for k in kept):
            kept.append(l)
    labels[:] = kept
    for l in labels:
        l.pop("auto", None)
        for k in [k for k, v in l.items() if v is None]:
            del l[k]
    return labels


GREEN = {("leisure", "park"): "park", ("leisure", "garden"): "garden", ("leisure", "marina"): "marina",
         ("water", "harbour"): "harbour"}


def greens(osm, labels, top_at):
    """Named parks, gardens, marinas and harbours over 2.5 ha on the map that no label names or stands in. An outline
    cut by the map edge comes as an open line."""
    from shapely.geometry import Polygon, box
    frame = box(0, 0, W, D)
    shapes = [(t, g) for _, _, t, g in osm.areas] + [(t, Polygon(g.coords)) for _, t, g in osm.lines if len(g.coords) >= 3]
    names = {l["name"] for l in labels}
    out = []
    for t, g in shapes:
        kind = next((k for (key, v), k in GREEN.items() if t.get(key) == v), None)
        if not kind or not t.get("name") or t["name"] in names:
            continue
        g = g.buffer(0).intersection(frame)
        if g.area < 25000 or any(l.get("kind") in ("park", "garden", "marina", "harbour", "zoo") and g.contains(Point(l["x"], l["y"])) for l in labels + out):
            continue
        p = g.representative_point()
        out.append(dict(name=t["name"], en=t.get("name:en"), kind=kind, site=site_of(t), auto=True, far=900,
                        x=int(p.x), y=int(p.y), z=top_at(int(p.y), int(p.x))))
        names.add(t["name"])
    return out


def assemble(curated, osm, top_at):
    curated = list(curated)
    roof_height(curated, osm, top_at)
    return finish(curated + greens(osm, curated, top_at))


def radii(labels, g, abs_top):
    """Footprint radius: the viewer hides a label only when something *else* is in the way."""
    for l in labels:
        r, c = int(l["y"]), int(l["x"])
        gg = int(g[min(max(r, 0), D - 1), min(max(c, 0), W - 1)])
        l["g"] = gg
        thr = gg + max(6, (l["z"] - gg) * 0.4)
        r0, r1, c0, c1 = max(r - 220, 0), min(r + 221, D), max(c - 220, 0), min(c + 221, W)
        lab_, _ = ndimage.label(abs_top[r0:r1, c0:c1] >= thr)
        k = lab_[r - r0, c - c0] if (0 <= r - r0 < lab_.shape[0] and 0 <= c - c0 < lab_.shape[1]) else 0
        if k:
            rr_, cc_ = np.nonzero(lab_ == k)
            l["R"] = round(float(np.hypot(rr_ + r0 - r, cc_ + c0 - c).max()), 1)
        else:
            l["R"] = 0.0
