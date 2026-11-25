"""Every label on the map and how far away it shows.

The curated landmarks (landmarks.LABELS, EXTRA_LABELS, the building overrides' labels), the further places of PLACES
below, plus the named parks, gardens, marinas and harbours of 2.5 ha or more that none of them names. `far` is the
camera distance (m) up to which a label shows; the viewer adds its English name or kind closer in, then its facts and
website. Every label carries a `cat` (CATS: one of a few categories, for a map's icons), from its kind unless it
names its own.
"""
import re

import numpy as np
from scipy import ndimage
from shapely.geometry import Point

import landmarks
from aoi import W, D

DEFAULT_FAR = 5000  # m, for a curated label that gives no `far` of its own

# Further landmarks, put on the map here in the whole-map pass (regions.py) rather than in landmarks.py: a change here
# rebuilds only that pass (voxelize.py reuses every region), not the regions. The things a visitor looks for from afar,
# picked from OSM (data/raw/osm.json; places.json, the search's, lists the same): name -> facts as landmarks.LABELS
# (en, kind, year, alt, far, site; cat to override the one CATS gives the kind), at (EPSG:25832 x, y: the OSM
# outline's centre or node), r (m, default 6: the label stands on the highest voxel within r of `at`, a roof or a
# spire). Off the map: left out. Order = priority on screen within one `far`.
PLACES = {
    # the Altstadt and the Innstadt
    "Peschl-Terrasse": dict(kind="beer terrace over the Danube", alt="Peschl Brauerei", at=(828991, 5389911), r=12,
                            far=3000),
    "Zentraler Omnibusbahnhof": dict(en="Central bus station", kind="bus station", alt="ZOB Busbahnhof",
                                     at=(828663, 5389538), r=20, far=3000),
    "Stadtgalerie": dict(kind="shopping centre", at=(828645, 5389654), r=40, far=3000),
    "Stadtturm": dict(kind="tower block", alt="Hochhaus", at=(828697, 5389514), r=12, far=3000),
    "Votivkirche": dict(kind="church", at=(828824, 5389669), r=12, far=3000),
    "Stadttheater Passau": dict(en="Town theatre", kind="theatre", at=(829319, 5389700), r=10, far=1500),
    "Museum Moderner Kunst": dict(en="Museum of Modern Art", kind="museum", at=(829887, 5389829), r=8, far=1500),
    "RömerMuseum Kastell Boiotro": dict(en="Roman museum", kind="museum", alt="Römermuseum", at=(829128, 5389261),
                                        r=10, far=1500),
    "Schiffsanlegestelle": dict(en="Boat landing", kind="Danube boat landing",
                                alt="Schiffanlegestelle Wurm+Noe Rathaus", at=(829239, 5389972), far=1500),
    "Löwenbrauerei": dict(en="Löwenbräu brewery", kind="brewery", alt="Bayerische Löwenbrauerei Stockbauer",
                          at=(828557, 5389342), r=15, far=3000),
    "Klinikum Passau – Hellge-Klinik": dict(en="Passau hospital (Hellge clinic)", kind="hospital",
                                            alt="Krankenhaus Klinikum", at=(828055, 5389180), r=30, far=5000),
    "Sankt Anton": dict(kind="church", alt="St. Anton", at=(827710, 5389093), r=12, far=3000),
    "Christi Himmelfahrt": dict(kind="church", at=(827310, 5389328), r=12, far=3000),
    # Ilzstadt, Hals and up the Ilz
    "St. Salvator": dict(kind="church", alt="Salvatorkirche", at=(829895, 5390065), r=12, far=3000),
    "St. Bartholomäus": dict(kind="church", at=(830061, 5390157), r=12, far=3000),
    "Achatiuskirche": dict(kind="church", at=(829164, 5391066), r=10, far=3000),
    "Kraftwerk Hals": dict(en="Hals power station", kind="Ilz power station", at=(829018, 5391457), r=10, far=3000),
    "Halser Ilzschleifen": dict(en="Ilz loops at Hals", kind="river bathing spot", at=(828804, 5391487), r=3, far=1500),
    "Burg Reschenstein": dict(en="Reschenstein castle ruin", kind="castle ruin", at=(828467, 5392181), r=10, far=3000),
    "Triftsperre": dict(en="Log-driving weir", kind="weir on the Ilz", alt="Trifttunnel", at=(828451, 5392317), r=10,
                        far=3000),
    # west of the station: Hacklberg, Haidenhof, Auerbach
    "Schloss Freudenhain": dict(kind="palace", alt="Gymnasium Freudenhain", at=(828100, 5390256), r=20, far=3000),
    "St. Konrad": dict(kind="church", at=(827493, 5390248), r=12, far=3000),
    "Glockengießerei Perner": dict(en="Perner bell foundry", kind="bell foundry", at=(827375, 5389945), r=15, far=1500),
    "Winterhafen Racklau": dict(en="Racklau winter harbour", kind="harbour", alt="Hafen Racklau", at=(826563, 5389590),
                                far=3000),
    "St. Josef": dict(kind="church", alt="Auerbach", at=(825900, 5389150), r=12, far=3000),
    "Skatepark Passau": dict(kind="skatepark", at=(825624, 5389614), r=3, far=1500),
    # up the Danube: the Kachlet, Heining, Neustift, Schalding
    "Schleuse Kachlet": dict(en="Kachlet locks", kind="Danube locks", alt="Schleusen Kachlet", at=(825183, 5390126),
                             r=3, far=5000),
    "Kirche St. Korona": dict(kind="church", at=(825704, 5392439), r=10, far=3000),
    "Auferstehung Christi": dict(kind="church", alt="Neustift", at=(824144, 5389325), r=12, far=3000),
    "Babalu Funpark": dict(kind="indoor playground", at=(823747, 5390822), r=20, far=1500),
    "SV Schalding-Heining": dict(kind="football ground", alt="Stadion Reischlhof Sportplatz", at=(822482, 5390910),
                                 r=3, far=3000),
    "St. Michael, Schalding": dict(kind="church", alt="Schalding", at=(821707, 5391776), r=12, far=3000),
    "Hafen Passau": dict(en="Port of Passau", kind="Danube port", alt="bayernhafen Schalding", at=(823050, 5391559),
                         r=3, far=5000),
}

# what a label is, for a map's icons: the first category one of whose words starts a word of its kind; else "sight"
CATS = [
    ("church", ("cathedral", "church", "abbey", "chapel")),
    ("castle", ("fortress", "castle", "palace")),
    ("bridge", ("bridge", "footbridge")),
    ("tower", ("tower",)),
    ("water", ("dam", "lock", "weir", "harbour", "port", "marina", "confluence", "boat", "bathing")),
    ("industry", ("power", "brewery", "foundry")),
    ("transport", ("station",)),
    ("district", ("district",)),
    ("sport", ("football", "stadium", "skate", "sport", "swimming", "playground")),
    ("park", ("park", "garden")),
    ("education", ("university", "school")),
    ("health", ("hospital", "clinic")),
    ("shopping", ("shopping",)),
    ("culture", ("theatre", "museum")),
    ("civic", ("town hall",)),
]


def cat_of(kind):
    k = (kind or "").lower()
    return next((c for c, words in CATS if any(re.search(rf"\b{w}", k) for w in words)), "sight")


def places(top_at):
    """the labels of PLACES that stand on the map, in map cells"""
    from aoi import MAP_D, MAP_W, MC0, MR0, is_built, to_grid
    out = []
    for n, f in PLACES.items():
        c, r = (int(v) for v in to_grid(*f["at"]))
        c, r = c + MC0, r + MR0
        if not is_built(r, c):
            continue
        k = f.get("r", 6)
        z = max(top_at(rr, cc) for rr in range(max(r - k, 0), min(r + k + 1, MAP_D))
                for cc in range(max(c - k, 0), min(c + k + 1, MAP_W)) if (rr - r) ** 2 + (cc - c) ** 2 <= k * k)
        out.append(landmarks.label(n, {a: v for a, v in f.items() if a != "r"}, c, r, z))
    return out


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
        l["cat"] = l.get("cat") or cat_of(l.get("kind"))
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
    from aoi import BOXES, built_shape
    frame = box(0, 0, W, D) if BOXES is None else built_shape()
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
    curated += places(top_at)
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
