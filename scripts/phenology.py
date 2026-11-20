"""When each kind of tree leafs out, colours and drops its leaves, from two open sources:

- the German Weather Service's phenological network (DWD, annual reporters, wild plants), stations within 100 km of
  Passau and below 500 m (the Danube and Inn valleys and the hills round them, not the Bavarian Forest's heights), 1995-2024. Phases: 4 leaf unfolding
  begins, 31 autumn colouring (half the leaves coloured), 32 leaf fall (half fallen); 61, 63, 64 the same for the larch.
  Per species the median day and the spread between trees in one year (station dates around that year's mean).
- iNaturalist's "Leaves" annotations (breaking buds, green, coloured) on research-grade-able observations in Poland,
  Germany, Czechia, Slovakia and Lithuania, per week of the year: for what the DWD does not record (Norway maple, lindens
  and poplars have no leaf or autumn series there, ash and robinia no autumn one). Colouring: the day coloured
  observations outnumber green ones; leaf-out: the mean day of breaking buds. Both shifted by their median offset from
  the DWD dates for the species both sources have. Leaf fall: colouring plus the DWD's median gap between the two.
A phase neither source gives takes the median over the classes.

Species groups where the tree's species is unknown (all but a few hundred OSM trees: the Einzelbäume register has no
species, only ground and tree height; the conifers are told by the laser's winter scan, voxelize.py "con"). Such a
broadleaved tree takes a class drawn by its site, from open data (site_classes below):
- riparian: within 30 m of open water (data/ground.npz water, bodies of 1000 m2 and up) and at most 3 m above it --
  the floodplain forest's genera (willow, alder, poplar, ash), in equal shares (no inventory gives their mix here);
- forest: ALKIS Wald or Gehölz (alkis_tn.py) -- beech (with hornbeam) 17 and oak 12 parts (their shares of the forest
  floor in the Bundeswaldinventur 2022, Germany: Thünen-Institut, BWI 2022 brochure), the other broadleaved genera
  18 parts in equal shares (about the rest of the inventory's broadleaved share, not split further here);
- elsewhere (streets, gardens, parks): the genera's iNaturalist observation counts (verifiable) within the map's box,
  kept in scripts/tree_genera.json (fetched again when the map's box changes) -- the trees people noted in Passau
  (cherries, elms, walnuts are class 13, the deciduous trees without series of their own).
The draw is stable: a tree takes its stand's number (stands: the cells round jittered seeds every 32 m of the project
grid) with probability 0.6, else its own (a hash of its id), so neighbours tend to share a genus as in a real stand.

Autumn colours: measured on Wikimedia Commons photos of each taxon's canopy, autumn and summer (scripts/foliage_photos.json:
the method, the photos, both medians). The sunlit half of the leaf pixels; the renderer keeps its own summer greens, so
all autumn colours are scaled by how much brighter those greens are than the photos' summer canopies (one factor, so
the taxa keep their brightness relative to each other).

Lawns through the year: the median colour of city lawns per month (LAWN_LAB below, measured upstream on dated Commons
photos), smoothed with its neighbours, at the renderer's brightness in summer; per month the factor on the palette's grass green.
Summer leaves: the photos' median summer canopy, as one factor on the renderer's greens, at the lawns' exposure (so
crowns keep their brightness relative to the grass under them).

Output: web/public/data/phenology.json (per class: dates, spread, source) and, with the trees' positions
(web/public/data/trees.json), data/foliage.bin (tile_fields.py puts it into the node files): per 2 m cell the class of the tree whose crown it is in
(the crown's owner from data/crowns.npz, written by voxelize.py; elsewhere the nearest trunk within 9 m), then a byte of
that tree's index (so one tree turns as one), gzip.
"""
import gzip
import json
import math
import re
import sys
import time
import urllib.request
import zlib
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from aoi import D, RAW, W  # noqa: E402

DWD = "https://opendata.dwd.de/climate_environment/CDC"
WILD = f"{DWD}/observations_germany/phenology/annual_reporters/wild/historical"
INAT = ("https://api.inaturalist.org/v1/observations/histogram?place_id=7800,7207,8264,8267,8266&term_id=36&term_value_id={v}"
        "&taxon_id={t}&date_field=observed&interval=week_of_year&verifiable=true")
CACHE = Path(RAW) / "dwd"
YEARS = (1995, 2024)
OUT = Path(__file__).parent.parent / "web/public/data"
PHASES = ("leaf", "colour", "fall")
PHOTOS = Path(__file__).parent / "foliage_photos.json"
CROWNS = Path(__file__).parent.parent / "data/crowns.npz"  # (voxelize.py) which tree each 2 m cell's crown is
# the sunlit half of city lawns, median CIELAB per month (Jan..Dec). Measured by the upstream project
# (github.com/stared/warsaw-vibe-voxel, scripts/grass_photos.json) on 119 dated Wikimedia Commons photos of lawns in
# the parks of Warsaw and a few other lowland cities: Central European lawns, not Passau's own
LAWN_LAB = [[52.2, -1.1, 21.7], [56.5, -2.6, 24.85], [58.7, -2.35, 21.15], [57.8, -18.6, 32.1], [48.6, -16.5, 36.5],
            [63.7, -11.1, 30.2], [64.2, -16.5, 26.35], [55.15, -17.65, 32.75], [61.4, -11.75, 26.65], [54.1, -14.8, 30.3],
            [52.0, -7.7, 18.1], [45.3, -1.5, 13.2]]
HERE, NEAR_KM, MAX_ALT = (48.574, 13.466), 100, 500  # Passau; the DWD stations taken: this near and no higher (m)
UA = {"User-Agent": "passau-voxel/0.1"}
GRASS = "#86b45a"
# the crowns' summer greens (LEAVES in voxelize.py)
GREENS = ["#a3c65c", "#8db552", "#76a24a", "#618f43", "#4f7c3c", "#93bb6a", "#7da95f", "#689655", "#56834c", "#456f43"]

# class: (DWD species file, iNaturalist taxon id, genera it stands for). 0 = no tree here.
# PHOTO_CLASS: the class in foliage_photos.json measured for it
PHOTO_CLASS = {1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "7", 7: "8", 8: "9", 9: "10", 10: "11", 11: "12", 12: "13", 15: "6"}
CLASSES = {
    1: ("Spitz-Ahorn", 54763, ["Acer"]),
    2: ("Sommer-Linde", 54856, ["Tilia"]),
    3: ("Esche", 125440, ["Fraxinus"]),
    4: ("Robinie", 56088, ["Robinia", "Gleditsia"]),
    5: ("Stiel-Eiche", 1520309, ["Quercus"]),
    6: ("Rosskastanie", 84298, ["Aesculus"]),
    7: ("Rotbuche", 55801, ["Fagus", "Carpinus"]),
    8: ("Haenge-Birke", 83992, ["Betula"]),
    9: ("Eberesche", 56063, ["Sorbus"]),
    10: ("Europaeische-Laerche", 59747, ["Larix"]),
    11: ("Sal-Weide", 53453, ["Salix"]),
    12: ("Schwarz-Erle", 966205, ["Alnus"]),
    15: (None, 47566, ["Populus"]),
}
OTHER, EVERGREEN = 13, 14  # deciduous trees with no series of their own (Prunus, Malus, Ulmus, Platanus, ...); conifers
PHASE = {4: "leaf", 61: "leaf", 31: "colour", 63: "colour", 32: "fall", 64: "fall"}
CONIFERS = {"Picea", "Pinus", "Thuja", "Taxus", "Pseudotsuga", "Abies", "Juniperus", "Chamaecyparis", "Tsuga", "Cupressocyparis"}


def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print("download", url)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
            path.write_bytes(r.read())
    return path


def species_file(name):
    index = urllib.request.urlopen(urllib.request.Request(f"{WILD}/", headers=UA)).read().decode()
    first, last = sorted(re.findall(rf"PH_Jahresmelder_Wildwachsende_Pflanze_{name}_(\d+)_(\d+)_hist\.txt", index), key=lambda m: m[1])[-1]
    return f"PH_Jahresmelder_Wildwachsende_Pflanze_{name}_{first}_{last}_hist.txt"


def stations_near():
    p = fetch(f"{DWD}/help/PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt", CACHE / "stations.txt")
    keep = set()
    for line in p.read_text(encoding="latin1").splitlines()[1:]:
        f = [x.strip() for x in line.split(";")]
        if len(f) > 4 and f[2]:
            km = math.hypot((float(f[2]) - HERE[0]) * 111.2, (float(f[3]) - HERE[1]) * 111.2 * math.cos(math.radians(HERE[0])))
            if km <= NEAR_KM and float(f[4]) <= MAX_ALT:
                keep.add(int(f[0]))
    return keep


def dwd(name, near):
    p = CACHE / f"{name}.txt"
    if not p.exists():
        fetch(f"{WILD}/{species_file(name)}", p)
    rows = []
    for line in p.read_text(encoding="latin1").splitlines()[1:]:
        f = line.split(";")
        if len(f) < 8:
            continue
        st, yr, ph, doy = int(f[0]), int(f[1]), PHASE.get(int(f[4])), int(f[7])
        if st in near and YEARS[0] <= yr <= YEARS[1] and ph:
            rows.append((ph, yr, doy))
    out = {}
    for ph in PHASES:
        a = np.array([(y, d) for p_, y, d in rows if p_ == ph])
        if len(a) < 30:
            continue
        resid = np.concatenate([a[a[:, 0] == y, 1] - a[a[:, 0] == y, 1].mean() for y in np.unique(a[:, 0]) if (a[:, 0] == y).sum() >= 3])
        out[ph] = dict(day=float(np.median(a[:, 1])), sd=float(resid.std()), n=int(len(a)), source="DWD")
    return out


def inat(taxon):
    p = CACHE / f"inat_{taxon}.json"
    if not p.exists():
        h = {}
        for v, key in ((37, "bud"), (38, "green"), (39, "coloured")):
            req = urllib.request.Request(INAT.format(t=taxon, v=v), headers=UA)
            d = json.load(urllib.request.urlopen(req))["results"]["week_of_year"]
            h[key] = [d.get(str(w), 0) for w in range(1, 54)]
            time.sleep(1.1)
        p.write_text(json.dumps(h))
    h = {k: np.array(v, float) for k, v in json.loads(p.read_text()).items()}
    doy, k3 = np.arange(53) * 7 + 4.0, np.ones(3) / 3
    g, c = np.convolve(h["green"], k3, "same"), np.convolve(h["coloured"], k3, "same")
    share, out = c / np.maximum(g + c, 1e-9), {}
    for i in range(29, 52):
        if share[i] < 0.5 <= share[i + 1] and h["coloured"].sum() >= 20:
            out["colour"] = dict(day=float(doy[i] + (0.5 - share[i]) / (share[i + 1] - share[i]) * 7), n=int(h["coloured"].sum()))
            break
    if h["bud"].sum() >= 10:
        out["leaf"] = dict(day=float((h["bud"] * doy).sum() / h["bud"].sum()), n=int(h["bud"].sum()))
    return out


def phenology():
    near = stations_near()
    print(len(near), "DWD stations near Passau")
    table = {k: dict(species=name or "", genera=genera, **{**{ph: None for ph in PHASES}, **(dwd(name, near) if name else {})})
             for k, (name, _, genera) in CLASSES.items()}
    nat = {k: inat(t) for k, (_, t, _) in CLASSES.items()}
    sd = {ph: float(np.median([v[ph]["sd"] for v in table.values() if v[ph]])) for ph in PHASES}
    gap = float(np.median([v["fall"]["day"] - v["colour"]["day"] for v in table.values() if v["fall"] and v["colour"]]))
    for ph in ("leaf", "colour"):
        both = [nat[k][ph]["day"] - v[ph]["day"] for k, v in table.items() if v[ph] and ph in nat[k]]
        bias = float(np.median(both))
        print(f"iNaturalist {ph} minus DWD: median {bias:+.1f} d over {len(both)} species ({', '.join(f'{b:+.0f}' for b in both)})")
        for k, v in table.items():
            if not v[ph] and ph in nat[k]:
                v[ph] = dict(day=nat[k][ph]["day"] - bias, sd=sd[ph], n=nat[k][ph]["n"], source=f"iNaturalist, {bias:+.0f} d to the DWD scale")
    for v in table.values():
        if not v["fall"] and v["colour"]:
            v["fall"] = dict(day=v["colour"]["day"] + gap, sd=sd["fall"], n=0, source=f"colouring + {gap:.0f} d (the DWD's median gap)")
    med = {ph: dict(day=float(np.median([v[ph]["day"] for v in table.values() if v[ph]])), sd=sd[ph], n=0, source="median of the classes") for ph in PHASES}
    for v in table.values():
        v.update({ph: v[ph] or med[ph] for ph in PHASES})
    table[OTHER] = dict(species="median of the classes", genera=[], **med)
    table[EVERGREEN] = dict(species="conifers", genera=sorted(CONIFERS), leaf=None, colour=None, fall=None)
    for k, c in autumn_colours().items():
        table[k]["autumn"] = c
    for k in sorted(table):
        v = table[k]
        print(k, v["species"] or v["genera"], v.get("autumn"), {ph: (round(v[ph]["day"]), v[ph]["source"][:11]) for ph in PHASES if v[ph]})
    return table


def linear(hex_):
    c = np.array([int(hex_[i:i + 2], 16) for i in (1, 3, 5)]) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    c = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return "#" + "".join(f"{round(v * 255):02x}" for v in c)


def leaf_tint():
    photos = json.load(open(PHOTOS))
    summer = np.median([linear(photos[p]["summer_lit_hex"]) for p in PHOTO_CLASS.values()], axis=0)
    greens = np.mean([linear(h) for h in GREENS], axis=0)
    return [round(float(v), 3) for v in summer * lawns()[1] / greens]


def autumn_colours():
    photos = json.load(open(PHOTOS))
    lum = lambda c: float(c @ [0.2126, 0.7152, 0.0722])
    k_ = np.mean([lum(linear(h)) for h in GREENS]) / np.median([lum(linear(photos[p]["summer_lit_hex"])) for p in PHOTO_CLASS.values()])
    out = {k: srgb(linear(photos[p]["autumn_lit_hex"]) * k_) for k, p in PHOTO_CLASS.items()}
    out[OTHER] = srgb(np.median([linear(c) for c in out.values()], axis=0))
    return out


def lum(c):
    return float(c @ [0.2126, 0.7152, 0.0722])


def lab_to_linear(L, a, b):
    fy = (L + 16) / 116
    f = np.array([fy + a / 500, fy, fy - b / 200])
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * [0.95047, 1.0, 1.08883]
    return np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]) @ xyz


def lawns():
    lab = np.array(LAWN_LAB)
    lab = 0.25 * np.roll(lab, 1, 0) + 0.5 * lab + 0.25 * np.roll(lab, -1, 0)
    lin = np.array([lab_to_linear(*v) for v in lab])
    k = lum(linear(GRASS)) / np.mean([lum(lin[m]) for m in (5, 6, 7)])
    return lin, k


def grass_tints():
    lin, k = lawns()
    return [[round(float(v), 3) for v in lin[m] * k / linear(GRASS)] for m in range(12)]


def genus_class(genus):
    for k, (_, _, genera) in CLASSES.items():
        if genus in genera:
            return k
    return OTHER


def classify(t, drawn=None):
    """the tree's class; drawn: for a tree of unknown species, the class its site's draw gave (site_classes)"""
    genus = (t.get("sp") or "").split(" ")[0]
    if genus in CONIFERS or (t.get("con") and genus not in ("Larix", "Metasequoia")):  # (con: voxelize.py, laser scan)
        return EVERGREEN
    if not genus and drawn is not None:
        return drawn
    return genus_class(genus)


# the genera drawn from per site (see the docstring): (genus, parts)
RIPARIAN = [("Salix", 1), ("Alnus", 1), ("Populus", 1), ("Fraxinus", 1)]
FOREST_OTHER = ["Acer", "Fraxinus", "Tilia", "Betula", "Alnus", "Salix", "Populus", "Sorbus", "Prunus"]
FOREST = [("Fagus", 17), ("Quercus", 12)] + [(g_, 18 / len(FOREST_OTHER)) for g_ in FOREST_OTHER]
URBAN_GENERA = sorted({g_ for _, _, gs in CLASSES.values() for g_ in gs if g_ != "Larix"} |
                      {"Prunus", "Ulmus", "Juglans", "Malus", "Platanus"})
INAT_COUNT = ("https://api.inaturalist.org/v1/observations?taxon_name={g}&swlat={s}&swlng={w}&nelat={n}&nelng={e}"
              "&verifiable=true&per_page=0")
STAND_M, STAND_P = 32, 0.6
GENERA = Path(__file__).parent / "tree_genera.json"


def urban_shares():
    """[(genus, iNaturalist observations within the map's box)]"""
    import pyproj
    from aoi import CRS, world_bounds
    x0, y0, x1, y1 = world_bounds(0)
    tr = pyproj.Transformer.from_crs(CRS, 4326, always_xy=True)
    (w, s_), (e, n) = tr.transform(x0, y0), tr.transform(x1, y1)
    box = [round(v, 4) for v in (w, s_, e, n)]
    known = json.loads(GENERA.read_text()) if GENERA.exists() else {}
    if known.get("box") != box or sorted(known.get("observations", {})) != URBAN_GENERA:
        out = {}
        for g_ in URBAN_GENERA:
            url = INAT_COUNT.format(g=g_, w=box[0], s=box[1], e=box[2], n=box[3])
            out[g_] = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA)))["total_results"]
            time.sleep(1.1)
        known = dict(source="iNaturalist API v1, observations (verifiable) per genus within the map's box (lon/lat)",
                     fetched=time.strftime("%Y-%m-%d"), box=box, observations=out)
        GENERA.write_text(json.dumps(known, indent=1, sort_keys=True) + "\n")
    return [(g_, c) for g_, c in sorted(known["observations"].items()) if c > 0]


def site_masks():
    """(forest, riparian): [D, W] bool on the map's cells"""
    import rasterio.features
    from affine import Affine
    from scipy import ndimage
    from shapely.affinity import affine_transform
    import aoi
    z = np.load(Path(__file__).parent.parent / "data/ground.npz")
    g, water = z["g"].astype(np.float32), z["water"]
    lab, _ = ndimage.label(water)
    big = np.bincount(lab.ravel()) >= 1000
    big[0] = False
    water = big[lab]
    dist, (wr, wc) = ndimage.distance_transform_edt(~water, return_indices=True)
    riparian = (dist <= 30) & (g - g[wr, wc] <= 3)
    forest = np.zeros(g.shape, np.uint8)
    try:
        import alkis_tn
        tm = [aoi.EU[0], aoi.EU[1], aoi.EV[0], aoi.EV[1], aoi.I0 - aoi.CX * aoi.EU[0] - aoi.CY * aoi.EU[1] - aoi.C0,
              aoi.J0 - aoi.CX * aoi.EV[0] - aoi.CY * aoi.EV[1] - aoi.R0]
        shapes = [(affine_transform(p_, tm), 1) for n_, _, p_ in alkis_tn.read(aoi.world_bounds(5)) if n_ in ("Wald", "Gehölz")]
        if shapes:
            forest = rasterio.features.rasterize(shapes, out_shape=g.shape, transform=Affine.identity(), fill=0, dtype="uint8")
    except FileNotFoundError:
        print("no ALKIS land use: no forest sites")
    return forest > 0, riparian


def _u(*key):
    return (zlib.crc32(repr(key).encode()) & 0xFFFFFF) / float(1 << 24)


def site_classes(trees):
    """per tree (trees.json's, map cells): the class drawn for it by its site (see the docstring), and the site
    (0 elsewhere, 1 forest, 2 riparian)"""
    import aoi
    forest, riparian = site_masks()
    urban = urban_shares()
    print("urban genera (iNaturalist, map box):", dict(urban))
    xy = np.array([(t["x"], t["y"]) for t in trees])
    c = np.clip(xy[:, 0].astype(int), 0, forest.shape[1] - 1)
    r = np.clip(xy[:, 1].astype(int), 0, forest.shape[0] - 1)
    site = np.where(riparian[r, c], 2, np.where(forest[r, c], 1, 0))
    # stands: the nearest of jittered seeds, one per STAND_M square of the project grid
    pc, pr = xy[:, 0] + aoi.MAP_C0, xy[:, 1] + aoi.MAP_R0
    i0, j0 = np.floor(pc / STAND_M).astype(int), np.floor(pr / STAND_M).astype(int)
    best = np.full(len(trees), np.inf)
    stand = np.zeros((len(trees), 2), int)
    seed = {}
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            si, sj = i0 + di, j0 + dj
            for k in set(zip(si.tolist(), sj.tolist())) - seed.keys():
                seed[k] = ((k[0] + _u("sx", *k)) * STAND_M, (k[1] + _u("sy", *k)) * STAND_M)
            sxy = np.array([seed[k] for k in zip(si.tolist(), sj.tolist())])
            d = (sxy[:, 0] - pc) ** 2 + (sxy[:, 1] - pr) ** 2
            m = d < best
            best[m] = d[m]
            stand[m] = np.c_[si, sj][m]
    tables = {}
    for k, shares in ((0, urban), (1, FOREST), (2, RIPARIAN)):
        w = np.array([p_ for _, p_ in shares], float)
        tables[k] = ([genus_class(g_) for g_, _ in shares], np.cumsum(w) / w.sum())
    out = np.zeros(len(trees), np.uint8)
    for n_, t in enumerate(trees):
        st = int(site[n_])
        u = _u("stand", int(stand[n_, 0]), int(stand[n_, 1]), st) if _u("pick", t["id"]) < STAND_P else _u("tree", t["id"])
        cl, cum = tables[st]
        out[n_] = cl[min(int(np.searchsorted(cum, u, side="right")), len(cl) - 1)]
    return out, site


def city_median(table, cls, ph):
    # the day by which half of the city's deciduous trees have reached a phase
    days = [(table[k][ph]["day"], int((cls == k).sum())) for k in table if table[k][ph]]
    d, w = np.array(days).T
    o = np.argsort(d)
    return round(float(d[o][np.searchsorted(np.cumsum(w[o]), w.sum() / 2)]))


def main():
    table = phenology()
    every = json.load(open(OUT / "trees.json"))["trees"]
    # the trees drawn (a register point under another tree's crown has none of its own)
    drawn, site = site_classes(every)
    cls_all = np.array([classify(t, d) for t, d in zip(every, drawn)], np.uint8)
    keep = np.array([t.get("drawn") != "none" for t in every], bool)
    trees = [t for t in every if t.get("drawn") != "none"]
    cls = cls_all[keep]
    print("trees per site (elsewhere, forest, riparian):", np.bincount(site[keep], minlength=3).tolist(),
          "conifers among the forest's:", int(((cls == EVERGREEN) & (site[keep] == 1)).sum()))
    city = {ph: city_median(table, cls, ph) for ph in PHASES}
    print("city medians:", city)
    json.dump(dict(city=city, sources=["DWD Climate Data Center: phenological observations, annual reporters, wild plants (historical), stations within 100 km of Passau below 500 m, 1995-2024",
                            "iNaturalist: Leaves annotations, Poland, Germany, Czechia, Slovakia, Lithuania",
                            "autumn colours: Wikimedia Commons photos, scripts/foliage_photos.json",
                            "lawns by month: Wikimedia Commons photos of Central European city lawns (measured by the upstream project, warsaw-vibe-voxel)"],
                   classes=table, grass=grass_tints(), leaf=leaf_tint()), open(OUT / "phenology.json", "w"), indent=1, ensure_ascii=False)

    print("trees per class:", {int(k): int((cls == k).sum()) for k in np.unique(cls)})
    # away from the drawn crowns (hedges, scrub, a procedural tree's crown) the nearest trunk within 9 m; not a LiDAR
    # crown's conifer, whose needles are all in the crowns' cells below (a hedge beside it is no evergreen)
    near = np.array([not (c_ == EVERGREEN and t.get("drawn") == "lidar") for t, c_ in zip(trees, cls)])
    xy, ncls = np.array([(t["x"], t["y"]) for t in trees])[near], cls[near]
    nid = np.nonzero(near)[0]
    gx, gy = np.meshgrid(np.arange(W // 2) * 2 + 1, np.arange(D // 2) * 2 + 1)
    dist, idx = cKDTree(xy).query(np.c_[gx.ravel(), gy.ravel()], distance_upper_bound=9)
    ok = np.isfinite(dist)
    idx = np.minimum(idx, len(ncls) - 1)
    grid = np.where(ok, ncls[idx], 0).astype(np.uint8).reshape(gy.shape)
    tree = np.where(ok, (nid[idx] * 2654435761 >> 13) & 255, 0).astype(np.uint8).reshape(gy.shape)
    if CROWNS.exists():
        # where voxelize.py drew a crown, the tree whose crown it is (data/crowns.npz: index into trees.json), not
        # the nearest trunk on this 2 m grid
        own = np.load(CROWNS)["owner"]
        if own.shape == grid.shape:
            m = own >= 0
            grid[m] = cls_all[own[m]]
            tree[m] = ((own[m].astype(np.int64) * 2654435761 >> 13) & 255).astype(np.uint8)
            print("foliage cells from the crowns' owners:", int(m.sum()))
    (OUT.parent.parent.parent / "data" / "foliage.bin").write_bytes(gzip.compress(grid.tobytes() + tree.tobytes(), 9, mtime=0))
    print("foliage grid", grid.shape, "cells with a class:", int((grid > 0).sum()))


if __name__ == "__main__":
    main()
