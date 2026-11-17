"""Curated details layered on top of the data-driven voxels: the labels and camera presets, per-building overrides
(overrides.json) and Passau's set pieces (passau.py)."""
import json
import math
from pathlib import Path

import numpy as np
from shapely.geometry import Point
from scipy import ndimage

# OSM name -> what a label shows; order = label priority (decluttering keeps earlier ones).
# Facts, all optional except kind: en (the English name, shown instead of kind), kind (what it is), height (m),
# year (built or opened), rebuilt, by (architect), building (under construction), alt (other names for search),
# far (the camera distance in m up to which the label shows; default labels.DEFAULT_FAR), site (its website).
# anchor "top": highest voxel in the footprint (towers, spires); default: top voxel at the centroid.
LABELS = {
    "Dom St. Stephan": dict(en="St Stephen's Cathedral", kind="cathedral", year=1688, anchor="top"),
    "Veste Niederhaus": dict(kind="castle", year=1250),
    "Rathausturm": dict(name="Altes Rathaus", en="Old Town Hall", kind="town hall", year=1892, anchor="top"),
    "Neue Residenz": dict(kind="bishop's palace", year=1730),
    "Pfarrkirche Sankt Paul": dict(name="St. Paul", kind="church", year=1678, anchor="top"),
    "St. Michael": dict(kind="church", year=1677, anchor="top"),
    "Kloster Niedernburg": dict(kind="abbey"),
    "Schaiblingsturm": dict(kind="tower", year=1250, anchor="top"),
    "Sankt Gertraud": dict(kind="church", anchor="top"),
    "Sankt Severin": dict(kind="church", anchor="top"),
    "Nikolakloster": dict(en="University of Passau", kind="university"),
}
# places without a single OSM polygon, at EPSG:25832 x, y
EXTRA_LABELS = {
    "Dreiflüsseeck": dict(en="Three Rivers Corner", kind="confluence of Danube, Inn and Ilz", at=(830170, 5389742)),
    "Veste Oberhaus": dict(kind="fortress", year=1219, at=(829736, 5390183)),
}


def label(osm_name, facts, x, y, z):
    keep = {k: v for k, v in facts.items() if k not in ("anchor", "at", "name")}
    return dict(name=facts.get("name", osm_name), **keep, x=x, y=y, z=z)


# material names for overrides.json -> the viewer's material ids (web/src/voxelMaterial.ts MAT)
MAT_IDS = {"solid": 0, "wall": 1, "glass": 2, "metal": 6, "floodlit": 7, "grass": 8, "roof": 12, "concrete": 13,
           "bronze_grid": 15, "sign": 16, "sign_band": 18, "ribbon": 19, "classic": 20, "window": 21, "tenement": 22}
# the historic core: the Altstadt peninsula and the Innstadt, in grid cells of the first trial cut (traced on the
# orthophoto preview; aoi.DX shifts them to the current cut). Their houses are plastered in many colours under tiled
# roofs, windows a storey apart -- not the newer town's blocks
HISTORIC_CORE = [[(365, 540), (865, 520), (1130, 575), (1480, 710), (1365, 800), (960, 800), (670, 790), (540, 865), (365, 730)],
                 [(730, 1035), (1200, 1055), (1200, 1150), (770, 1180), (615, 1135)]]


def historic_core():
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    from aoi import DX
    return unary_union([Polygon([(x + DX, y) for x, y in p]) for p in HISTORIC_CORE])


OVERRIDES = json.load(open(Path(__file__).with_name("overrides.json")))["buildings"]


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def override_for(f):
    """overrides.json entry for a feature: by its own id, its parent outline's id, or its (parent's) name."""
    keys = [str(f["id"])]
    if f.get("parent"):
        keys.append(str(f["parent"]["id"]))
    keys.append(_name(f) or "")
    for k in keys:
        o = OVERRIDES.get(k)
        if o and (f["maxh"] or 0) >= o.get("min_part_height", -1):
            return o
    return None


def _style(pal, spec):
    return pal(_hex(spec["colour"]), MAT_IDS[spec.get("material", "wall")])



def wall_override(f, pal):
    o = override_for(f)
    return _style(pal, o["wall"]) if o and "wall" in o else None


def apply_zones(vol, g, feats, pal, bmask, note):
    """Facade zones and crown bands from overrides.json, painted onto the voxels of the building's footprint."""
    by_outline = {}
    for f in feats:
        o = override_for(f)
        if o and ("zones" in o or "crown" in o):
            root = f.get("parent") or f
            by_outline.setdefault(root["id"], (o, []))[1].append(f)
    for oid, (o, fs) in by_outline.items():
        rr = np.concatenate([f["rr"] for f in fs])
        cc = np.concatenate([f["cc"] for f in fs])
        keep = bmask[rr, cc]
        rr, cc = rr[keep], cc[keep]
        if len(rr) == 0:
            continue
        # long axis of the footprint; "west" end = smaller grid column
        pts = np.stack([cc, rr], 1).astype(float)
        mu = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - mu, full_matrices=False)
        ax = vt[0] if vt[0][0] >= 0 else -vt[0]
        t = (pts - mu) @ ax
        t = (t - t.min()) / max(np.ptp(t), 1e-6)
        zone_of = np.full(len(rr), -1)
        for k, z in enumerate(o.get("zones", [])):
            tt = t if z.get("origin", "west") in ("west", "north") else 1 - t
            m = (tt >= z["from"]) & (tt <= z["to"]) & (zone_of < 0)
            zone_of[m] = k
            idx = _style(pal, z["wall"])
            for r, c in zip(rr[m], cc[m]):
                col = vol[:, r, c]
                nz = np.nonzero(col)[0]
                nz = nz[nz >= g[r, c]]
                if len(nz) > 1:
                    col[nz[:-1]] = idx  # keep the roof voxel
        cr = o.get("crown")
        if cr:
            m = t <= cr.get("tip", 1.0)
            fp = np.zeros(vol.shape[1:], bool)
            fp[rr, cc] = True
            edge_fp = fp & ~ndimage.binary_erosion(fp)  # facade cells only
            band, sign = _style(pal, cr), pal(_hex(cr.get("sign_colour", cr["colour"])), MAT_IDS["sign"])
            for r, c in set(zip(rr[m], cc[m])):
                if not edge_fp[r, c]:
                    continue
                nz = np.nonzero(vol[:, r, c])[0]
                top = nz.max()
                for k in range(0, cr["height"]):
                    vol[top - k, r, c] = sign if (k == 0 and (r + c) % 2 == 0) else band
        if "roof" in o:
            ridx = _style(pal, o["roof"])
            for r, c in zip(rr, cc):
                vol[np.nonzero(vol[:, r, c])[0].max(), r, c] = ridx
        note(f"override zones: {o.get('name', oid)}: {len(rr)} cells, zones "
             f"{[int((zone_of == k).sum()) for k in range(len(o.get('zones', [])))]}")


def override_labels(feats, g, top_at):
    out = []
    for f in feats:
        o = OVERRIDES.get(str(f["id"]))
        if o and "label" in o and not f["part"] and len(f["rr"]):
            r, c = int(np.median(f["rr"])), int(np.median(f["cc"]))
            out.append(label(o["label"]["name"], o["label"], c, r, top_at(r, c)))
    return out


def _name(f):
    return f["tags"].get("name") or (f.get("parent") or {}).get("tags", {}).get("name")



def roof_override(f, pal):
    o = override_for(f)
    return _style(pal, o["roof"]) if o and "roof" in o else None


def small_tree(vol, g, r, c, h, leaves, trunk, height=None):
    """A young street tree, for a known tree the surface model shows no crown of: a clear trunk to ~4 m and a narrow,
    airy crown on top."""
    H = int(height or 7 + h % 3)
    z0 = int(g[r, c])
    tr = max(3, int(H * 0.42))
    vol[z0:z0 + tr, r, c] = trunk
    leaf = leaves[1 + (h >> 8) % 4]
    leaf2 = leaves[(1 + (h >> 8) % 4 + 2) % len(leaves)]
    ch = H - tr  # crown height
    for k in range(ch):
        f = (k + 0.5) / ch
        rad = 0.6 + 1.3 * math.sin(math.pi * min(1.0, f * 1.1))  # spindle, widest just below the middle
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                d = (dr * dr + dc * dc) ** 0.5
                if d > rad:
                    continue
                if d > 0.5 and ((h >> ((k * 5 + dr * 3 + dc + 20) % 28)) & 7) == 0:
                    continue  # airy gaps
                zz, rr, cc = z0 + tr + k, r + dr, c + dc
                if 0 <= rr < vol.shape[1] and 0 <= cc < vol.shape[2] and zz < vol.shape[0] and vol[zz, rr, cc] == 0:
                    vol[zz, rr, cc] = leaf if (dr + dc + k) % 3 else leaf2
    vol[z0 + tr:z0 + H - 1, r, c] = trunk  # leader through the crown


def details(vol, g, topi, feats, pal, osm, cells_of, note):
    """The curated set pieces, then the labels and the camera presets."""
    import passau
    passau.build(vol, g, pal, note)

    def top_at(r, c):
        col = np.nonzero(vol[:, r, c])[0]
        return int(col[-1]) + 1 if len(col) else int(g[r, c])

    found = {}
    for oid, typ, t, geom in osm.areas:
        n = t.get("name")
        if n not in LABELS or n in found:
            continue
        facts = LABELS[n]
        if facts.get("anchor") == "top":
            rr, cc = cells_of(geom)
            if len(rr) == 0:
                continue
            k = np.argmax(topi[rr, cc] + g[rr, cc])
            r, c = int(rr[k]), int(cc[k])
        else:
            p = geom.representative_point() if not geom.contains(geom.centroid) else geom.centroid
            r, c = int(p.y), int(p.x)
        if not (0 <= r < vol.shape[1] and 0 <= c < vol.shape[2]):
            continue
        found[n] = label(n, facts, c, r, top_at(r, c))
    labels = [found[n] for n in LABELS if n in found] + override_labels(feats, g, top_at)
    from aoi import to_grid
    for n, facts in EXTRA_LABELS.items():
        c, r = (int(v) for v in to_grid(*facts["at"]))
        labels.append(label(n, facts, c, r, top_at(r, c)))
    note("labels:", [l["name"] for l in labels])
    return labels, make_views(found, g)


def make_views(found, g):
    """Camera presets in three.js coords (x = col, y = up, z = row), derived from landmark positions."""
    def add(t, off):
        return [t[0] + off[0], t[1] + off[1], t[2] + off[2]]

    views = {}
    H_, W_ = g.shape
    dom = found.get("Dom St. Stephan")
    dom = [dom["x"] + 0.5, 0.0, dom["y"] + 0.5] if dom else [W_ / 2, 0, H_ / 2]
    gd = float(g[int(dom[2]), int(dom[0])])
    t = [dom[0], gd + 15, dom[2]]
    views["overview"] = dict(label="Overview", target=t, pos=add(t, (-250, 520, 760)))
    views["dom"] = dict(label="Dom", target=[dom[0], gd + 30, dom[2]], pos=add([dom[0], gd + 30, dom[2]], (-170, 110, 200)))
    from aoi import DX
    o = [1085.5 + DX, 0, 317.5]  # Veste Oberhaus, grid (traced on the ortho)
    go = float(g[317, 1085 + DX])
    views["oberhaus"] = dict(label="Veste Oberhaus", target=[o[0], go + 10, o[2]], pos=add([o[0], go + 10, o[2]], (160, 130, 330)))
    views["fromoberhaus"] = dict(label="View from Oberhaus", target=[dom[0] + 150, gd + 10, dom[2]], pos=[o[0] - 30, go + 60, o[2] + 60])
    eck = [1565.0 + DX, float(g[735, 1500 + DX]) + 5, 730.0]
    views["eck"] = dict(label="Dreiflüsseeck", target=eck, pos=add(eck, (380, 230, 60)))
    mid = [W_ * 0.5, float(np.median(g)) + 10, H_ * 0.5]
    views["city"] = dict(label="Whole map", target=mid, pos=add(mid, (0, 2500, 1300)))
    return views


def edge_windows(vol, g, geom, win, rows, bay, w=2, margin=2.5, min_len=6, depth=1, skip=()):
    """Windows on every straight outer edge of a footprint, at any angle: as many bays (`bay` m apart) as fit
    between `margin` m from the ends, centred; rows (z above ground, height) the same on every edge. Each window
    cell walks in from outside to the first wall voxel at its height; that voxel (and depth-1 behind) is cleared and
    the next one set to glass. Edges listed by index in `skip` are left alone."""
    n = 0
    geom = geom.simplify(1.2)  # OSM outlines carry every pilaster step: one straight run per facade
    xs, ys = geom.exterior.coords.xy
    pts = list(zip(xs, ys))
    for k in range(len(pts) - 1):
        if k in skip:
            continue
        (x0, y0), (x1, y1) = pts[k], pts[k + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        if L < min_len:
            continue
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        nx, ny = -uy, ux
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        if not geom.contains(Point(mx + nx * 2, my + ny * 2)):
            nx, ny = -nx, -ny  # n points into the building
        nb = int((L - 2 * margin) // bay) + 1
        if nb < 1:
            continue
        span = (nb - 1) * bay
        for i in range(nb):
            tc = L / 2 - span / 2 + i * bay
            for t in np.arange(tc - w / 2 + 0.25, tc + w / 2, 0.5):
                bx, by = x0 + ux * t, y0 + uy * t
                r_, c_ = int(by + ny), int(bx + nx)
                gz = int(g[r_, c_])
                for zr, hh in rows:
                    for zz in range(hh):
                        z = gz + zr + zz
                        hit = None
                        for o in np.arange(-3, 4, 0.5):
                            r, c = int(by + ny * o), int(bx + nx * o)
                            if vol[z, r, c]:
                                hit = o; break
                        if hit is None:
                            continue
                        for d in range(depth):
                            vol[z, int(by + ny * (hit + d)), int(bx + nx * (hit + d))] = 0
                        vol[z, int(by + ny * (hit + depth)), int(bx + nx * (hit + depth))] = win
            n += 1
    return n
