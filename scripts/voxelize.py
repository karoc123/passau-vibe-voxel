"""Fuse the Bavarian surface and terrain models (DOM20 / DGM1), the LoD2 building roofs, the DOP20 orthophoto and current
OSM into a 1 m voxel volume of Passau. ("LiDAR" and "DSM" in the comments below mean the surface model: Bavaria's DOM20
is matched from aerial images, the DGM1 terrain under it is laser-scanned.)

Output (web/public/data/): tiles/ (scripts/tiles.py), meta.json (palette, lamps, labels, views),
traffic.json; data/trees.json, data/qa_roadmask.bin.gz (not served: the viewer reads neither), data/ground.npz for flood.py and terrain.py.
Volume axes: vol[z, row, col]; row grows south, col grows east, z up.

Region by region (scripts/region.py): `voxelize.py` (the driver, scripts/regions.py) builds the map as one region or
as several (--regions NXxNY, --region-size METRES), each in a process of its own running this file with VOXEL_REGION
(the region: its core and a halo of region.HALO metres) set, and puts the cores together. Below, D, W and every array
are the region's; a region writes its core: the tiles of its core, its rows and columns of the map-sized rasters and
what lies in it of the lists (data/cache/regions/, regions.py stitches them).
"""
import colorsys
import hashlib
import json
import math
import os
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import rasterio.features
import webcolors
from affine import Affine
from scipy import ndimage
from shapely.geometry import LineString, Point, shape
from shapely.ops import substring
from shapely.strtree import STRtree

from aoi import BASE, C0, CX, CY, D, MC0, MR0, R0, W
from osm import OSM
import landmarks
import overrides
import region
from region import boxmean, in_core
from ways import cells as _way_cells, layer_of, parse_len, underground

if __name__ == "__main__" and not os.environ.get("VOXEL_REGION"):  # the driver: region by region (scripts/regions.py)
    import regions
    regions.main(sys.argv[1:])
    raise SystemExit(0)

OUT = Path("web/public/data")
DBG = Path("data/debug")
RDIR = Path(os.environ.get("VOXEL_OUT", "data/cache/regions/whole"))  # this region's own outputs (regions.py)
OUT.mkdir(parents=True, exist_ok=True)
DBG.mkdir(parents=True, exist_ok=True)
RDIR.mkdir(parents=True, exist_ok=True)
report = {"notes": []}
RESULT = {}  # what this region hands to regions.py besides its rasters (lists, counts): data/cache/regions/*/out.json
# the large features (spanning region.FMAX or more), decided whole (features.py): VOXEL_FEATURES, the feature pass, counts
# what decides them over the region (its core alone) and stops; a build looks up the decisions (VOXEL_FEATURE_TABLE)
FEATURES_MODE = bool(os.environ.get("VOXEL_FEATURES"))
FEATURE_TABLE = json.load(open(os.environ["VOXEL_FEATURE_TABLE"])) if os.environ.get("VOXEL_FEATURE_TABLE") else None
FEATURE_STATS, FEATURE_USED = {}, {}
CORE_SL = region.core_slices()


_T0 = __import__("time").time()


def note(*a):
    s = " ".join(str(x) for x in a)
    print(f"[{__import__('time').time() - _T0:6.0f} s]", s)
    report["notes"].append(s)


_TS = [_T0]


def own_peak_mb():
    """this process's own peak RSS (VmHWM: reset by exec, unlike ru_maxrss, which starts at what the parent held when
    it forked -- 2.9 GB after regions.py cut the OSM)"""
    import resource
    try:
        with open("/proc/self/status") as fh:
            return next(int(x.split()[1]) for x in fh if x.startswith("VmHWM:")) / 1024
    except (OSError, StopIteration):
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def stage(name):
    """the build's timing (not a note: the report stays as it was): the seconds since the last stage, the RSS now and
    its peak so far, printed and kept in out.json `timing` (regions.py: data/debug/timings.json)"""
    import time
    t = time.time()
    dt, _TS[0] = t - _TS[0], t
    peak = own_peak_mb()
    with open("/proc/self/statm") as fh:
        now = int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2 ** 20
    RESULT.setdefault("timing", []).append([name, round(dt, 2), round(now), round(peak)])
    RESULT["peak_mb"] = round(peak)  # (regions.py: stats.json, what the scheduler expects of the next build)
    print(f"[stage] {name}: {dt:.1f} s, RSS {now:.0f} MB, peak {peak:.0f} MB", flush=True)


# ---------------------------------------------------------------- materials / palette
M_SOLID, M_WALL, M_GLASS, M_LEAF, M_WATER, M_LAMP, M_METAL, M_FLOODLIT, M_GRASS, M_MARK, M_SOIL, M_CAR, M_ROOF, M_CONCRETE, M_CLOCK, M_BRONZE, M_SIGN = range(17)
M_WOOD = 23  # a tree's trunk and branches


class Palette:
    """The palette's ids from a registry (scripts/palette.json): an entry keeps its id from build to build and in every
    region, whatever order colours are met in. A colour the registry lacks gets the next id for this run and is listed
    (self.new); regions.py adds the new ones to the registry, sorted, and builds again the regions that met them."""
    REGISTRY = Path(__file__).with_name("palette.json")

    def __init__(self):
        self.entries = [tuple(e) for e in json.load(open(self.REGISTRY))["palette"]]
        self.index = {e: i for i, e in enumerate(self.entries)}
        self.new = []

    def __call__(self, rgb, mat=M_SOLID, q=4):
        if isinstance(rgb, str):
            rgb = hex_rgb(rgb)
        r, g, b = (min(255, int(round(v / q)) * q) for v in rgb)
        key = (r, g, b, mat)
        if key not in self.index:
            self.index[key] = len(self.entries)
            self.entries.append(key)
            self.new.append(key)
        return self.index[key]


def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


COLOUR_ALIASES = {"grey": "gray", "lightgrey": "lightgray", "darkgrey": "darkgray", "cream": "#f1e9d2",
                  "sand": "#d8c79f", "beige": "#ddd2b8", "brick": "#a5553f", "terracotta": "#c0623f",
                  "glass": "#9fb5c2", "concrete": "#b8b5ae", "gold": "#cfae5c", "bronze": "#8c6c47",
                  "copper": "#5f9c87", "ochre": "#cc9a4a", "salmon": "#e19a85", "pink": "#e6b3b3",
                  "white": "#efede6", "black": "#3a3a3d", "red": "#b5513f", "brown": "#7e5a43",
                  "yellow": "#e3c86a", "green": "#6e9a5e", "blue": "#6c8cad", "orange": "#d98b4e",
                  "silver": "#c3c6c9", "gray": "#9a9a9a", "darkgray": "#6e6f72", "lightgray": "#cfcfcc",
                  # a facade tagged by a colour word is a painted plaster, not the CSS colour: purple (#800080)
                  # came out a magenta block in the station quarter
                  "purple": "#9a7aa6", "violet": "#ab93c4", "magenta": "#b9789f", "fuchsia": "#b9789f",
                  "lime": "#a9c46a", "teal": "#5f9a97", "navy": "#4f6488", "maroon": "#8a4a44", "olive": "#8f8d5a"}


def parse_colour(s):
    if not s:
        return None
    s = s.split(";")[0].strip().lower().replace(" ", "")
    s = COLOUR_ALIASES.get(s, s)
    s = COLOUR_ALIASES.get(s, s)
    try:
        rgb = hex_rgb(s) if re.fullmatch(r"#?[0-9a-f]{6}|#?[0-9a-f]{3}", s) else hex_rgb(webcolors.name_to_hex(s))
    except ValueError:
        return None
    # building paint is never neon: a kiosk tagged "red" was #ff0000, a roof "lime" #00ff00 -- cap the saturation at
    # 0.62 (a deep brick red, a strong but real green) and keep hue and lightness
    h_, l_, s_ = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    if s_ > 0.62 and 0.12 < l_ < 0.9:
        rgb = tuple(round(v * 255) for v in colorsys.hls_to_rgb(h_, l_, 0.62))
    return rgb


def soften(rgb, amt=0.12):
    """MagicaVoxel-ish grading: pull slightly toward warm light grey, keep hue."""
    return tuple(v * (1 - amt) + w * amt for v, w in zip(rgb, (226, 220, 208)))


def stable_hash(*a):
    return int(hashlib.md5("/".join(map(str, a)).encode()).hexdigest()[:8], 16)


def cell_hash(r, c, *a):
    """stable_hash of a cell by its project grid row and column (aoi.R0, C0: the same cell in every region)"""
    return stable_hash(int(r) + R0, int(c) + C0, *a)


pal = Palette()
C = {  # ground & misc palette (MagicaVoxel-like pastel)
    "paving": pal("#c6c2b8"), "paving2": pal("#b5b4af"), "asphalt": pal("#5f636b"), "asphalt_l": pal("#6e7178"),
    "sett": pal("#8f8981"), "road_paving": pal("#a49f97"), "tartan": pal("#b3604c"), "court": pal("#4f8db3"), "concrete": pal("#bdbab2"), "cycle": pal("#8a5a52"), "gravel": pal("#d8ccb5"),
    "grass": pal("#86b45a", M_GRASS), "grass2": pal("#79a852", M_GRASS), "garden": pal("#73a34e", M_GRASS),
    "scrub": pal("#5f8f45", M_LEAF), "flower": pal("#d98fb3", M_GRASS), "flower2": pal("#e8c25e", M_GRASS),
    "dirt": pal("#a58a66"), "dirt2": pal("#8e7455"), "fresh": pal("#93865a", M_GRASS),
    "stubble": pal("#c4b27e"), "stubble2": pal("#b9a26c"),  # a field mown or harvested: straw, not paving
    "ballast": pal("#8a8178"), "rail": pal("#55575d", M_METAL), "trambed": pal("#a9a59c"),
    "platform": pal("#b7b1a6"), "water": pal("#68654f", M_WATER), "mark": pal("#f1efe8", M_MARK),
    "bare": pal("#a8977c", M_SOIL),  # lawns before their grass arrives (tiles.py: grass is its own file)
    "soil": pal("#7a5c45", M_SOIL), "lamp": pal("#ffe2a8", M_LAMP),
    # wood (voxelMaterial.ts MAT.WOOD): trunks and the limbs in a broadleaf crown, the thinner branches out to its
    # edge a paler grey-brown; drawn through the leaves around them (mesher.worker.ts), bare in winter
    "trunk": pal("#6b4f3a", M_WOOD), "twig": pal("#746860", M_WOOD),
    "pole": pal("#3a3e42", M_METAL), "steps": pal("#a8a296"), "hatch": pal("#d9c860", M_MARK),
    "fence": pal("#dfe3e6", M_METAL), "crane": pal("#e7b23c", M_METAL), "crane_d": pal("#3d4249", M_METAL),
    "shelter": pal("#a9c3cf", M_GLASS), "deck": pal("#a7a49d", M_CONCRETE), "pier": pal("#99958d", M_CONCRETE), "parking": pal("#6a6d73"),
    "track": pal("#b8875a"), "kerb": pal("#cfc7b8"), "granite_d": pal("#55595c"), "woodfloor": pal("#6b5847"), "jet": pal("#dff1f7", 17),
    "benchkerb": pal("#dcd9d1", M_CONCRETE), "pline": pal("#eeede6", M_MARK),  # a pitch's white lines
    "shore": pal("#9d9585"),  # a river bank's rip-rap and gravel: grey-brown stones, darker than any paving
}
WOOD_IDS = [C["trunk"], C["twig"]]
# masonry of retaining walls and quays: rough granite and limestone blocks, a few tones voxel by voxel
STONE = [pal(c) for c in ["#8f897e", "#9b9488", "#857f75", "#a39b8d", "#938a7c"]]
PERENNIALS = [pal(c, M_LEAF) for c in ["#8e6fae", "#a690c4", "#6f9a4f", "#8aa27a", "#5f8a49", "#7c9c5a", "#c98fb0"]]
LEAVES = [pal(c, M_LEAF) for c in ["#a3c65c", "#8db552", "#76a24a", "#618f43", "#4f7c3c",
                                    "#93bb6a", "#7da95f", "#689655", "#56834c", "#456f43"]]
WALL_DEFAULTS = ["#d8cfc0", "#cbbfa8", "#e2d6bf", "#c4bbad", "#d9c7a7", "#cdc6ba", "#e6ddcc", "#bdb09b",
                 "#d3c3b0", "#c9c9c2"]

stage("imports")
# ---------------------------------------------------------------- rasters
for _p, _by in (("data/prep.npz", "scripts/prep.py"), ("data/lod2.npz", "scripts/lod2.py")):
    if not Path(_p).exists() and not (_p == "data/lod2.npz" and os.environ.get("NO_LOD2")):
        raise SystemExit(f"{_p} missing: run {_by} first" + (" (or set NO_LOD2=1 for roofs, outlines and buildings from "
                                                             "the surface model and OSM alone)" if "lod2" in _p else ""))
if not os.environ.get("NO_LOD2") and "cen" not in np.load("data/lod2.npz").files:
    raise SystemExit("data/lod2.npz has no footprints (`cen`): rerun scripts/lod2.py")
if "cellcol" not in np.load("data/prep.npz").files:
    raise SystemExit("data/prep.npz has no cell colours (`cellcol`): rerun scripts/prep.py")
z = region.load_npz("data/prep.npz")  # (the region's rows and columns)
dsm, dtm = z["dsm"], z["dtm"]
cellcol = z["cellcol"].astype(np.float32)  # (each cell's colour: the median of its 5 x 5 ortho pixels, prep.py)
del z
LOD2 = region.load_npz("data/lod2.npz") if Path("data/lod2.npz").exists() else None
d4 = dsm.reshape(D, 2, W, 2)
dsm_max = d4.max((1, 3))
dsm_mean = d4.mean((1, 3))
dtm_s = boxmean(dtm, 3)
SLAB = 3  # (aoi.BASE: the lowest terrain less SLAB)
assert dtm.min() >= BASE + SLAB - 1, f"terrain {dtm.min():.1f} m under aoi.BASE + {SLAB}: lower aoi.BASE"


nd_max = dsm_max - dtm
nd_mean = dsm_mean - dtm


def wall_clean(dsm):
    """The DSM is interpolated across vertical walls: a sample on a tower's edge reads 69, 95, 115 m between a 150 m
    roof and a 21 m podium. Taken as the cell's max, each became a 1 m column of partial height glued to
    the facade, ending mid-air (dark streaks down the towers). A sample on a step of 10 m or more (7x7), 3 m or more
    from both levels around it and steep goes to the nearer level."""
    # the two levels from 3.5 m around: a wall the DSM ramps across in 3-4 samples (12, 25, 36, 43 m
    # between a 4 m podium and a 50 m roof) snapped sample by sample to its ramp neighbours stayed a ramp
    lo = ndimage.minimum_filter(dsm, 7)
    hi = ndimage.maximum_filter(dsm, 7)
    mixed = (hi - lo >= 10) & (dsm - lo >= 3) & (hi - dsm >= 3)
    # and steep: 3 m or more to a 4-neighbour (6 m per metre; a pitched roof rises under 2) -- a ramp along a straight
    # wall repeats row after row, so similar neighbours along the wall do not make it a surface
    pad = np.pad(dsm, 1, mode="edge")
    steep = np.zeros(dsm.shape, bool)
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        steep |= np.abs(pad[1 + dr:1 + dr + dsm.shape[0], 1 + dc:1 + dc + dsm.shape[1]] - dsm) >= 3
    mixed &= steep
    # below a broad upper level only: spires, lanterns and stepped crowns (church towers, a hotel's crown)
    # were cut down to flat boxes; a wall edge has a roof beside it
    # (the upper level must survive a 6.5 m opening: a roof does, a spire's tip or a tower's stepped crown does not)
    mixed &= ndimage.maximum_filter(ndimage.grey_opening(dsm, size=(13, 13)), 7) >= hi - 3
    up = mixed & (dsm - lo >= hi - dsm)
    # a cell (2x2 samples) takes its highest: one sample snapped up pushed the wall out a cell, a sawtooth along every
    # wall top. Up only where at least two of the cell's samples go up
    n_up = up.reshape(dsm.shape[0] // 2, 2, dsm.shape[1] // 2, 2).sum((1, 3))
    up &= np.repeat(np.repeat(n_up >= 2, 2, 0), 2, 1)
    out = np.where(mixed, np.where(up, hi, lo), dsm)
    note("DSM wall-edge samples snapped to roof or street:", int(mixed.sum()))
    return out


nd_max_b = wall_clean(dsm).reshape(D, 2, W, 2).max((1, 3)) - dtm  # building tops
rgbsum = cellcol.sum(-1) + 1
exg = (2 * cellcol[..., 1] - cellcol[..., 0] - cellcol[..., 2]) / rgbsum
lum = cellcol @ np.array([0.299, 0.587, 0.114], np.float32)

osm = OSM()
note("OSM timestamp", osm.timestamp, "areas", len(osm.areas), "lines", len(osm.lines), "nodes", len(osm.nodes))


def cells_of(geom, all_touched=False, fallback=True):
    """ways.cells on the region's grid; a geometry holding no cell's centre takes the cells it touches"""
    return _way_cells(geom, D, W, all_touched, fallback)


def decided(geom, decide, shape_=None, fid=None):
    """[(piece of geom, decide(rows, cols))]: a feature's decision from the cells of its outline (or of shape_), once
    for the whole of it. One spanning region.FMAX metres or more: with its id (fid, "<w|r><OSM id>:<kind of
    features.KINDS>"), from the feature pass's counts over its whole outline (features.py; in the pass itself: its
    counts over the region, nothing drawn); without, or not in the table, block by block (region.feature_parts: each
    block's piece of it from its cells near the block)"""
    if fid is not None and region.spans(geom):
        if FEATURES_MODE:
            import features
            r_, c_ = cells_of(geom, fallback=False)
            kind = fid.split(":")[1]
            FEATURE_STATS[fid] = [kind, features.counts(kind, r_, c_, exg, lum, nd_mean)]
            return []
        if FEATURE_TABLE is not None and fid in FEATURE_TABLE:
            FEATURE_USED[fid] = FEATURE_TABLE[fid]
            return [(geom, FEATURE_TABLE[fid])]
    rr, cc = cells_of(shape_ if shape_ is not None else geom)
    out = []
    for blk, (sr, sc) in region.feature_parts(geom, rr, cc):
        if blk is None:
            return [(geom, decide(sr, sc))]
        from shapely.geometry import box as _box
        piece = geom.intersection(_box(blk[1], blk[0], blk[3], blk[2]))
        if not piece.is_empty:
            out.append((piece, decide(sr, sc)))
    return out


def burn(target, shapes, all_touched=False):
    shapes = [(s, int(v)) for s, v in shapes if s is not None and not s.is_empty]
    if not shapes:
        return
    m = rasterio.features.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=0,
                                    all_touched=all_touched, dtype=np.uint16)
    target[m > 0] = m[m > 0]


# the ground: the terrain model rounded to whole metres, lifted where it dropped under a structure that carries a road
# (scripts/ground.py: the passes in their order, GROUND_PASSES; the two of phase "decks" run with the bridges' decks)
import ground  # noqa: E402
from aoi import river_level as _river_level  # noqa: E402
from shapely.ops import unary_union as _uu  # noqa: E402
SAG_SRC = np.full((D, W), np.nan, np.float32)  # the surface the sag lift took the ground to (data/surface.npz gsrc)
OPEN_CUT = set()  # the layer -1 ways open to the sky (ground.open_cut)
GCTX = ground.Ctx(D=D, W=W, BASE=BASE, dtm=dtm, dtm_s=dtm_s, d4=d4, osm=osm, note=note, cells_of=cells_of, burn=burn,
                  river_level=_river_level, src=SAG_SRC, open_cut=OPEN_CUT, counts={}, changed={},
                  n_ground=region.load_npz("data/laser.npz", ["n_ground"])["n_ground"]
                  if Path("data/laser.npz").exists() and not os.environ.get("NO_LASER") else None)
g = ground.run(GCTX, "terrain")  # ground occupies z in [0, g)

stage("rasters, cell colours, OSM")
# ---------------------------------------------------------------- ground classes
gcol = np.full((D, W), C["paving"], np.uint16)
is_road = np.zeros((D, W), bool)
LANDUSE = {"grass": "grass", "meadow": "grass", "village_green": "grass", "flowerbed": "flower", "construction": "dirt",
           "railway": "ballast", "brownfield": "dirt", "greenfield": "grass", "orchard": "grass", "vineyard": "grass",
           "allotments": "garden"}
LEISURE = {"park": "grass2", "garden": "garden", "pitch": "grass", "playground": "gravel", "dog_park": "gravel"}
SURF = {"asphalt": "asphalt", "paving_stones": "paving", "sett": "sett", "cobblestone": "sett", "concrete": "concrete",
        "concrete:plates": "concrete", "gravel": "gravel", "fine_gravel": "gravel", "compacted": "gravel",
        "grass": "grass", "ground": "dirt", "dirt": "dirt", "unhewn_cobblestone": "sett", "paved": "paving",
        "wood": "track", "metal": "rail", "rubber": "cycle", "tartan": "cycle", "artificial_turf": "grass"}


def _pitch_key(shape):
    """a pitch's or a track's colour as the ortho sees it: red tartan, a blue court, green turf, white (an air hall) or
    a grey or black hard court"""
    rr_, cc_ = cells_of(shape)
    if len(rr_) < 10:
        return None
    r_, g_, b_ = np.median(cellcol[rr_, cc_], axis=0)
    return "tartan" if r_ > g_ + 18 and r_ > b_ + 25 else "court" if b_ > r_ + 25 else \
        "grass" if (2 * g_ - r_ - b_) / (r_ + g_ + b_ + 1) > 0.03 else "paving" if r_ + g_ + b_ > 560 else "asphalt_l"


containers, soft, hard = [], [], []
pitch_lines = []


def _lawn(rr_, cc_):  # a lawn the ortho sees paved over (a pavement widened since) is paving
    return "paving2" if len(rr_) >= 30 and np.median(exg[rr_, cc_]) < 0 and np.median(lum[rr_, cc_]) > 120 else "grass"


def _car_park(rr_, cc_):  # an untagged car park the ortho sees pale is paved (a new square's end, mapped as 9000 m2 of
    # parking, is the new square's paving with a few cars)
    return "paving2" if len(rr_) >= 20 and np.percentile(lum[rr_, cc_], 60) > 150 else "parking"


for oid, typ, t, geom in osm.areas:
    if underground(t) or "building" in t or "building:part" in t:
        continue
    if t.get("place") == "square" or t.get("highway") == "pedestrian" or t.get("landuse") in ("commercial", "retail", "residential"):
        containers.append((geom, C[SURF.get(t.get("surface"), "paving")]))
    if t.get("landuse") in LANDUSE:
        key = LANDUSE[t["landuse"]]
        if key == "grass":
            # (sorted by the whole outline's area below, pieces and all)
            soft.extend((p_, C[k_], geom.area) for p_, k_ in decided(geom, _lawn, fid=f"{typ[0]}{oid}:lawn"))
        else:
            soft.append((geom, C[key]))
    if t.get("leisure") in ("pitch", "track"):  # its colour as the ortho sees it: red tartan, green turf or a grey court; the
        # surface tags disagree with it (a green turf pitch tagged tartan, red courts untagged)
        inner = geom.buffer(-1) if geom.area > 60 else geom
        key = _pitch_key(geom if inner.is_empty else inner)
        if key:
            soft.append((geom, C[key]))
            if t.get("leisure") == "pitch" and geom.area >= 150 and key != "paving":
                pitch_lines.append(geom.difference(geom.buffer(-1)))  # its white outline
            continue
    if t.get("leisure") in LEISURE:
        soft.append((geom, C[SURF.get(t.get("surface"), LEISURE[t["leisure"]])]))
    if t.get("natural") in ("scrub", "heath", "grassland"):
        soft.append((geom, C["scrub" if t["natural"] == "scrub" else "grass"]))
    if t.get("natural") in ("wood",) or t.get("landuse") == "forest":
        soft.append((geom, C["garden"]))
    if "construction:leisure" in t or "construction:landuse" in t:
        soft.append((geom, C["fresh"]))
    if t.get("amenity") == "parking" and t.get("parking") not in ("underground", "multi-storey", "rooftop"):
        if "surface" not in t:
            hard.extend((p_, C[k_]) for p_, k_ in decided(geom, _car_park, fid=f"{typ[0]}{oid}:car_park"))
        else:
            hard.append((geom, C[SURF.get(t.get("surface"), "parking")]))
# a running track mapped as a line (its lanes; the area round it is the whole oval, the infield's turf): a band 6 m wide
# in the colour the ortho sees along it -- the stadium's black lanes were lost in the oval's lawn
for oid, t, line in osm.lines:
    if t.get("leisure") == "track" and not underground(t) and line.length >= 40:
        band = line.buffer(3, cap_style="flat")
        key = _pitch_key(band.buffer(-1))
        if key:
            soft.append((band, C["asphalt" if key == "asphalt_l" else key]))
# cells some map feature paints on purpose (a square, a car park, a path, a carriageway, a platform): what is left in
# the default paving is open land OSM says nothing about (see "natural ground" below)
explicit = np.zeros((D, W), np.uint8)
burn(explicit, [(g_, 1) for _, _, t_, g_ in osm.areas if not underground(t_) and "building" not in t_ and (
    t_.get("place") == "square" or t_.get("highway") == "pedestrian" or "surface" in t_ or t_.get("amenity") == "parking")])
containers.sort(key=lambda s: -s[0].area)
soft.sort(key=lambda s: -(s[2] if len(s) > 2 else s[0].area))
soft = [s[:2] for s in soft]
burn(gcol, containers)
burn(gcol, soft)
burn(gcol, hard)
burn(gcol, [(l_, C["pline"]) for l_ in pitch_lines if not l_.is_empty])
# a lawn island inside a car park (the stadium's) is drawn over it, not under
_hard_u = _uu([h_ for h_, _ in hard]) if hard else None
burn(gcol, [(g_, c_) for g_, c_ in soft if c_ in (C["grass"], C["grass2"]) and _hard_u is not None and g_.area < 20000
            and _hard_u.contains(g_.representative_point())])
# a construction site is bare earth only where the ortho sees it so (plots fenced for a building site that
# fenced plots were lawn and trees then)
_con = np.zeros((D, W), np.uint16)
burn(_con, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("landuse") == "construction" and not underground(t_)])
_cm = (_con > 0) & (gcol == C["dirt"])
_cg = ndimage.median_filter(((exg > 0.04) | (lum < 70)).astype(np.uint8), 9) > 0  # (a crown's shadow on the lawn is lawn)
_cp = ndimage.median_filter(((exg <= 0.04) & (lum >= 70) & (cellcol[..., 0] < cellcol[..., 2] + 12)).astype(np.uint8), 9) > 0
gcol[_cm & _cg] = C["grass"]
gcol[_cm & ~_cg & _cp] = C["paving2"]  # grey hardstanding, not earth
# ALKIS Tatsächliche Nutzung (scripts/alkis_tn.py): the cadastre's land use, parcel by parcel over the whole map. Where
# OSM says nothing it chooses the class of the open land below ("natural ground"), in place of guessing it from the
# ortho's colour alone: forest, grassland, arable land, park, copse, waste land, car park, cemetery. It doesn't draw
# anything: its parcel lines are the cadastre's, not the river bank's or the lawn's edge
TN = dict(forest=1, copse=2, grassland=3, arable=4, park=5, waste=6, parking=7, cemetery=8)
TN_KEY = {("Wald", ""): "forest", ("Gehölz", ""): "copse", ("Landwirtschaft", "Grünland"): "grassland",
          ("Landwirtschaft", "Ackerland"): "arable", ("Landwirtschaft", "Obst- und Nussplantage"): "arable",
          ("Sport-, Freizeit- und Erholungsfläche", "Park"): "park",
          ("Sport-, Freizeit- und Erholungsfläche", "Grünanlage"): "park",
          ("Sport-, Freizeit- und Erholungsfläche", "Garten"): "park",
          ("Sport-, Freizeit- und Erholungsfläche", "Kleingarten"): "park",
          ("Sport-, Freizeit- und Erholungsfläche", "Erholungsfläche"): "park",
          ("Unland/Vegetationslose Fläche", ""): "waste", ("Platz", "Parkplatz"): "parking", ("Friedhof", ""): "cemetery"}
tn = np.zeros((D, W), np.uint16)
try:
    import alkis_tn
    from shapely.affinity import affine_transform
    from aoi import EU, EV, I0, J0, world_bounds
    _tm = [EU[0], EU[1], EV[0], EV[1], I0 - CX * EU[0] - CY * EU[1] - C0, J0 - CX * EV[0] - CY * EV[1] - R0]  # (to the region's cells)
    _tn = [(affine_transform(g_, _tm), TN[TN_KEY[(n_, b_)]]) for n_, b_, g_ in alkis_tn.read(world_bounds(5))
           if (n_, b_) in TN_KEY]
    burn(tn, _tn)
    note("ALKIS land use cells:", {k: int((tn == v).sum()) for k, v in TN.items()})
except FileNotFoundError:
    note("no ALKIS land use (data/raw/tn_09262.zip, tn_09275.zip): open land by the ortho alone")
# farmland as the ortho sees it in July: green crops and leys, brown ploughland, pale straw where it is mown or
# harvested. Left to the open-land rules it came out as lawn with pale paving blobs (a car park in the middle of a
# hay field) wherever the stubble was pale. Arable land and orchards in the cadastre that OSM leaves out too
_fm = (tn == TN["arable"]).astype(np.uint8)
burn(_fm, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("landuse") == "farmland" and not underground(t_)])
_fm = (_fm > 0) & (gcol == C["paving"])
if _fm.any():
    _fex, _flum = ndimage.median_filter(exg, 5), ndimage.median_filter(lum, 5)
    _frb = ndimage.median_filter(cellcol[..., 0].astype(np.float32) - cellcol[..., 2], 5)
    _fk = np.where(_fex > 0.03, C["grass"], np.where((_frb > 14) & (_flum < 150), C["dirt"],
                   np.where(_flum < 165, C["stubble2"], C["stubble"])))
    gcol[_fm] = _fk[_fm]
    note("farmland cells by the ortho (crop / ploughed / straw):",
         [int((_fm & (_fk == C[k])).sum()) for k in ("grass", "dirt")], int((_fm & np.isin(_fk, [C["stubble"], C["stubble2"]])).sum()))
parking_mask = np.zeros((D, W), np.uint16)
burn(parking_mask, [(geom, 1) for geom, _ in hard])

# ortho says grass where OSM is silent (cross-check, only on default paving cells, low & green)
ortho_grass = (gcol == C["paving"]) & (exg > 0.09) & (nd_mean < 0.8)
ortho_grass = ndimage.binary_opening(ortho_grass, iterations=1)
gcol[ortho_grass] = C["grass"]
note("ortho-detected grass cells (OSM silent):", int(ortho_grass.sum()))
# under a crown the ortho sees only the crown: ground OSM says nothing about (default paving) under green canopy, away
# from streets, is soil and leaf litter, not pale paving (the wooded slopes under Oberhaus and Mariahilf)
_canopy = ndimage.median_filter(((exg > 0.02) & (nd_mean > 2.5)).astype(np.uint8), 5) > 0
_floor = (gcol == C["paving"]) & ndimage.binary_erosion(_canopy, iterations=2)
_floor = ndimage.binary_opening(_floor, iterations=2)
gcol[_floor] = C["garden"]
note("ground under canopy drawn as soil (OSM silent):", int(_floor.sum()))

from ways import HW, ROADS, unlit, way_width  # noqa: E402  (the widths ways are drawn at: shared with overrides.py)

def on_bridge(t):
    return t.get("bridge") not in (None, "no") or t.get("man_made") == "bridge"


foot_shapes, road_shapes, bridge_shapes, cycle_shapes, road_lines = [], [], [], [], []  # bridge ways are painted on the deck, not on the river below
bridge_rails = []  # (line, colour) the rails of tracks on bridges, drawn on the deck like those on the ground
bridge_lines = []  # (line, half width, layer) of every way on a bridge: the deck's height profile is taken along them
bridge_roads = []  # (line, width) of carriageways on bridges, for the inferred deck lamps
bridge_road_polys = []  # the carriageways on bridges, where one is drawn on the ground (a ramp's embankment)
lit_ground_ways = []  # the ways on the ground but those lit=no: a street lamp by one may stand under a bridge
# ways unlit unless tagged lit=yes: a field track under the Alte Poststraße's bridge over the A 3 (no lit tag) ran
# 4 m from one of its lamps, nearer than the bridge way, and the lamp stood on the ground under the deck
UNLIT = ("track",)
bridge_ways = []  # (OSM id, tags, line, half width) of every way on a bridge: where its piers stand (bridge_piers)
_paved = [(g_, t_["surface"]) for _, _, t_, g_ in osm.areas
          if t_.get("surface") in SURF and ("area:highway" in t_ or (t_.get("highway") and t_.get("area") == "yes"))]
_ptree = STRtree([g_ for g_, _ in _paved])
n_inherit = 0


def area_surface(line):
    """the surface of the paved square or courtyard a road without its own runs through (a palace's driveway)"""
    for i in _ptree.query(line):
        g_, s_ = _paved[i]
        if line.intersection(g_).length > 0.6 * line.length:
            return s_
    return None


# where a building stands (OSM's outlines): the surface model over it is a roof, never a deck. Not LoD2's footprints
# (LoD2 models the Poststeg and other footbridges as buildings), nor roofs on posts or a footbridge's own stair tower
_bld0 = np.zeros((D, W), np.uint8)
burn(_bld0, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("building") not in (None, "no", "roof", "carport", "canopy",
                                                                                   "staircase", "bridge")
             and not underground(t_)])
_bld0 = _bld0 > 0


def snap_footbridge(line):
    """A footbridge is 2-3 m wide, and its OSM way can lie a few metres beside it (the Poststeg over the station's
    tracks: 3-4 m west): the deck test then finds open air under most of the way and no bridge is built. The way moves
    sideways, by the least of up to 6 m, to where the surface model stands 2 m or more over the ground along 85% of
    it; a way with half of it over a deck already, or one that finds no such place, stays. A building's roof is no deck:
    the sidewalk of the ramp up to the Schanzlbrücke (its deck an embankment in the terrain model, so open air by this
    test) was moved 2.5 m onto the Schanzlturm's wall and its deck climbed the facade."""
    def cover(l_):
        P_ = np.array([l_.interpolate(v_).coords[0] for v_ in np.linspace(0, l_.length, max(2, int(l_.length) + 1))])
        r_, c_ = P_[:, 1].astype(int), P_[:, 0].astype(int)
        ok_ = (r_ >= 0) & (r_ < D) & (c_ >= 0) & (c_ < W)
        r_, c_ = r_[ok_], c_[ok_]
        return float(((nd_mean[r_, c_] > 2) & (exg[r_, c_] < 0.05) & ~_bld0[r_, c_]).mean()) if ok_.sum() >= 2 else 1.0
    if cover(line) >= 0.5:  # only a way clearly off its deck (and never onto a tree's crown: green in the ortho)
        return line, 0.0
    for off in sorted(np.arange(-6, 6.1, 0.5), key=abs):
        if off == 0:
            continue
        l_ = line.offset_curve(off)
        if l_.geom_type == "LineString" and not l_.is_empty and cover(l_) >= 0.85:
            return l_, float(off)
    return line, 0.0


for oid, t, line in osm.lines:
    hw = t.get("highway")
    if hw == "construction":
        hw = t.get("construction")
    if not hw or underground(t) or hw in ("corridor", "elevator", "proposed"):
        continue
    base = hw.replace("_link", "")
    w = way_width(t)
    if w <= 0:
        continue
    poly = line.buffer(w / 2, cap_style="flat" if base in ROADS else "round")
    if on_bridge(t) and not (hw in ROADS or base in ROADS) and line.length >= 15 and not region.spans(line):
        line, _off = snap_footbridge(line)
        if _off:
            poly = line.buffer(w / 2, cap_style="round")
            note(f"footbridge {t.get('name') or oid} moved {_off:+.1f} m onto its deck in the surface model")
    if on_bridge(t):
        key = SURF.get(t.get("surface"), "asphalt") if (hw in ROADS or base in ROADS) else ("cycle" if hw == "cycleway" else SURF.get(t.get("surface"), "paving"))
        bridge_shapes.append((poly, C[key], int(layer_of(t) or 1)))
        bridge_lines.append((line, w / 2, int(layer_of(t) or 1), C[key]))
        bridge_ways.append((oid, t, line, w / 2))
        if hw in ROADS or base in ROADS:
            bridge_road_polys.append(poly)
        # (not a footbridge tagged living_street for service vans only; nor a bridge whose road is dark, ways.unlit,
        # as traffic.py leaves it no street lamps: the A 3's Donaubrücke Schalding, lit=no, had one every 32 m)
        if (hw in ROADS or base in ROADS) and line.length > 60 and t.get("motor_vehicle") not in ("no", "private") \
                and not unlit(t):
            bridge_roads.append((line, w, oid))
        continue
    if t.get("lit") == "yes" or (t.get("lit") != "no" and hw not in UNLIT):
        lit_ground_ways.append(poly)
    if hw in ROADS or base in ROADS:
        _s = t.get("surface") or (area_surface(line) if base in ("service", "living_street") else None)
        n_inherit += _s is not None and "surface" not in t
        # a carriageway of paving stones in the sidewalks' colour vanished into them:
        # granite carriageways a darker grey
        _k = "road_paving" if SURF.get(_s) == "paving" else SURF.get(_s, "asphalt")
        if base in ("trunk", "primary", "secondary", "tertiary", "unclassified", "residential"):
            road_lines.append((oid, line, C[_k]))
        road_shapes.append((poly, C[_k]))
    elif hw == "cycleway":  # one red the whole way, whatever its stretches are tagged (asphalt, paving stones): drawn last
        cycle_shapes.append((poly, C["cycle"]))
    elif hw == "steps":
        foot_shapes.append((poly, C["steps"]))
    elif hw in ("path", "track", "bridleway") and t.get("surface") is None:
        # an untagged path or track is no paved walk: through the woods and meadows (under Oberhaus) it was a pale
        # paving ribbon zigzagging up the hill. Earth where the ortho sees green (crowns over it, a meadow's track)
        # or brown along it, gravel where it is pale
        def _way(rr_, cc_):
            green_ = len(rr_) and (np.median(exg[rr_, cc_]) > 0.03 or np.median(nd_mean[rr_, cc_]) > 2.5)
            pale_ = len(rr_) and np.median(lum[rr_, cc_]) > 150
            return "dirt" if green_ else "paving" if pale_ else "gravel"
        foot_shapes.extend((p_, C[k_]) for p_, k_ in decided(poly, _way, fid=f"w{oid}:way"))
    elif hw in ("footway", "path", "pedestrian", "platform", "track", "bridleway"):
        foot_shapes.append((poly, C[SURF.get(t.get("surface"), "paving")]))
note(f"roads taking their square's surface: {n_inherit}")
if FEATURES_MODE:  # the feature pass: the large features' counts over the core, and done (regions.feature_pass)
    import region_inputs
    json.dump(dict(stats=FEATURE_STATS, deps=region_inputs.deps_of_process(), peak_mb=round(own_peak_mb())),
              open(RDIR / "fstats.json", "w"))
    print("done")
    raise SystemExit(0)
burn(gcol, foot_shapes + cycle_shapes)
burn(explicit, [(s_, 1) for s_, _ in foot_shapes + cycle_shapes + road_shapes])
road_mask = np.zeros((D, W), np.uint16)
burn(road_mask, [(s, 1) for s, _ in road_shapes])
burn(gcol, road_shapes)
_sw = [(s_, C["kerb"] if k_ == "kerb" else C[SURF.get(k_, "paving")]) for s_, k_ in overrides.sidewalks(osm.lines, note)]
burn(gcol, _sw)  # (the street overrides' sidewalks and kerbs, scripts/overrides/street)
burn(explicit, [(s_, 1) for s_, _ in _sw])

AH = {"footway": "paving", "pedestrian": "paving", "cycleway": "cycle", "traffic_island": "kerb", "steps": "steps",
      "emergency": "asphalt_l", "yes": "paving", "platform": "platform", "busway": "asphalt", "parking": "parking",
      "junction": "asphalt", "bus_bay": "asphalt", "bus": "asphalt", "crossing": "asphalt", "tram": "asphalt", "taxi_stop": "asphalt",
      "passing_place": "asphalt", "shoulder": "asphalt", "prohibited": "asphalt_l", "parking_lane": "parking"}
area_hw = []
for oid, typ, t, geom in osm.areas_with("area:highway"):
    if underground(t) or t.get("landuse") == "grass":  # (a lawn mapped as a pedestrian area: the castle gardens')
        continue
    v = t["area:highway"]
    if v == "yes" and t.get("junction"):  # a junction's square of carriageway (a roundabout's)
        v = "junction"
    key = SURF.get(t.get("surface")) if v in ("footway", "pedestrian", "yes") else None
    key = key or AH.get(v) or ("asphalt" if v in HW or v.replace("_link", "") in ROADS else "paving")
    area_hw.append((geom, C[key]))
    if key in ("asphalt", "asphalt_l"):
        burn(road_mask, [(geom, 1)])
area_hw.sort(key=lambda s: -s[0].area)
burn(gcol, area_hw)
burn(explicit, [(s_, 1) for s_, _ in area_hw])
burn(gcol, [(line.buffer(1.0, cap_style="flat"), own) for _, line, own in road_lines])  # no area drawn over a carriageway cuts it
_cyc = np.zeros((D, W), np.uint16)  # a footway area drawn over a cycleway beside it does not cut it
burn(_cyc, [(sh, 1) for sh, _ in cycle_shapes])
gcol[(_cyc > 0) & (road_mask == 0)] = C["cycle"]
is_road = road_mask > 0
_ped = [C[k] for k in ("paving", "paving2", "kerb", "steps", "platform", "gravel", "grass", "dirt")]  # (a cycle crossing's red is road)


SANITY = {}  # per stage, per road: metres of its centreline in the core painted as pavement (regions.py adds them up)


def carriageway_sanity(surface, stage):
    """every carriageway's centreline in its own colour: the build stops if a road has 6 m or more of it painted as
    pavement (a junction square, an area drawn over it, a pit filled over a road ramp). Counted in the core: over
    several regions regions.py adds up each road's metres"""
    bad, cnt = [], {}
    for oid, line, own in road_lines:
        pts = [line.interpolate(d) for d in np.arange(0, line.length, 1.0)]
        rc = [(int(p.y), int(p.x)) for p in pts if 0 <= p.y < D and 0 <= p.x < W and in_core(int(p.y), int(p.x))]
        off = sum(surface(r, c) in _ped and surface(r, c) != own for r, c in rc)
        if off:
            cnt[str(oid)] = cnt.get(str(oid), 0) + int(off)
        if off >= 6:
            bad.append((int(off), oid, (rc[0][0] + R0, rc[0][1] + C0)))
    SANITY[stage] = cnt
    bad.sort(reverse=True)
    note(f"carriageway sanity ({stage}): {len(bad)} roads with 6+ m of their centreline painted as pavement: {bad[:8]}")
    if bad:
        raise SystemExit("carriageways painted as pavement; see the sanity line above")


carriageway_sanity(lambda r, c: gcol[r, c], "ground colours")

# rails & trams (only open-air)
rail_beds, rails = [], []
for oid, t, line in osm.lines_with("railway"):
    if underground(t) or t["railway"] not in ("rail", "tram", "light_rail", "subway"):
        continue
    if t["railway"] == "subway":
        continue
    tram = t["railway"] == "tram"
    if on_bridge(t):
        bridge_shapes.append((line.buffer(1.4 if tram else 1.9, cap_style="flat"), C["trambed" if tram else "ballast"], int(layer_of(t) or 1)))
        bridge_lines.append((line, 1.4 if tram else 1.9, int(layer_of(t) or 1), C["trambed" if tram else "ballast"]))
        bridge_ways.append((oid, t, line, 1.4 if tram else 1.9))
        for off in (-0.72, 0.72):
            try:
                bridge_rails.append((line.offset_curve(off), C["rail"]))
            except Exception:
                pass
        continue
    rail_beds.append((line.buffer(1.4 if tram else 1.9, cap_style="flat"), C["trambed" if tram else "ballast"]))
    for off in (-0.72, 0.72):
        try:
            rails.append((line.offset_curve(off), C["rail"]))
        except Exception:
            pass
burn(gcol, rail_beds)
burn(explicit, [(s_, 1) for s_, _ in rail_beds])
_pf = np.zeros((D, W), np.uint16)  # a platform mapped over the carriageway beside it stops at the road
burn(_pf, [(geom, 1) for oid, typ, t, geom in osm.areas_with("railway", ("platform",)) if not underground(t)])
gcol[(_pf > 0) & (road_mask == 0)] = C["platform"]
explicit[_pf > 0] = 1
burn(gcol, rails, all_touched=True)

# water
water = [(geom, C["granite_d"] if t.get("fountain") == "splash_pad" else C["water"]) for oid, typ, t, geom in osm.areas
         if (t.get("amenity") == "fountain" or t.get("natural") == "water" or t.get("water")) and not underground(t)]
burn(gcol, water)
# Passau: the Danube's and the Ilz's OSM multipolygons are cut by the map edge and do not close. The rivers from the
# terrain model instead: flat cells (under 0.3 m of relief in 5 m) within 0.8 m of the rivers' level (aoi.RIVER_LEVEL,
# the median of the terrain under the water OSM does give, the Inn's), in bodies of 2000 cells or more.
# Then the rivers (and ponds): one flat surface per water body -- the DTM over water steps in 1 m terraces that show as
# lines across the river; it drops ~0.3 m across the map, so one level per stretch is truthful: a body's median
# ground. Both per block of 64 m, from the window of 192 m round it (region.py: the same in every region): a body is
# its cells within the window, its size and its level are counted there
from aoi import RIVER_LEVEL, RIVER_STRETCHES, river_level
# (per stretch where scripts/map.json gives them: a 30 km map spans the rivers' fall; float32 as dtm, so one level
# everywhere subtracts exactly as the scalar did)
RIVER_LV = river_level(np.arange(D)[:, None], np.arange(W)[None, :])
_lv64 = np.broadcast_to(RIVER_LV, (D, W))
RIVER_LV = np.asarray(RIVER_LV, np.float32) if RIVER_STRETCHES else RIVER_LV
_w0 = gcol == C["water"]
_near_lv = np.abs(dtm - RIVER_LV) < 0.8
_flat = (ndimage.maximum_filter(dtm, 5) - ndimage.minimum_filter(dtm, 5) < 0.3) & _near_lv
# the pools: stretches whose levels differ by WEIR_STEP or more are apart (a weir between them), so a body is cut where
# one meets the next -- at the Kachlet the weir's openings are water under the plant's deck, and a body across them
# took a median between the two reaches: 64 m blocks of water at 295 and 299 m standing over the tailwater (292 m).
# Stretches of one river's fall (under WEIR_STEP apart) stay one body, as before. The boxes step along a weir 20 m at
# a time, across it: within POOL_EDGE of a pool's water (OSM's, or flat terrain at its stretch's level) a cell of
# another pool takes that pool if its terrain is nearer that pool's level (the nearest such water cell's) than its
# own stretch's -- the DGM over the water is the surface on either side and ramps across the weir, so the cut runs
# along the weir's middle, not the boxes' staircase. Only the pool's water counts, not its box: a box's edge along a
# bank (no water of that pool beyond it) cuts nothing, and the bank's cells, nearer the upper level by their DGM,
# stay their river's (the loop below the Hals weir: terraces at 298-301 m up the bank over the 296 m river)
WEIR_STEP, POOL_EDGE = 2.0, 32  # m
_lvs = sorted({lv_ for _, lv_ in RIVER_STRETCHES} | {RIVER_LEVEL})
_pool0 = _pool = np.cumsum([0] + [b_ - a_ >= WEIR_STEP for a_, b_ in zip(_lvs, _lvs[1:])])[np.searchsorted(_lvs, _lv64)]
if _pool.min() < _pool.max():
    _best, _bestd = _pool.copy(), np.abs(dtm - _lv64).astype(np.float32)
    _pw = _w0 | _flat
    for p_ in np.unique(_pool):
        _pm = (_pool == p_) & _pw
        if not _pm.any():
            continue
        _d, (_i, _j) = ndimage.distance_transform_edt(~_pm, return_indices=True)
        _dl = np.abs(dtm - _lv64[_i, _j]).astype(np.float32)
        _take = (_d <= POOL_EDGE) & (_dl < _bestd)
        _best[_take], _bestd[_take] = p_, _dl[_take]
    _pool = _best
    del _best, _bestd, _pw, _pm, _d, _i, _j, _dl, _take
_wat = np.zeros((D, W), bool)
_wlev = np.full((D, W), -1, np.int32)
# water at a level of its own (scripts/overrides/water: a lock chamber full or empty): no part of any river body, so
# the bodies' medians are taken without it, and its own level after
_locks = overrides.water_levels(osm.areas, cells_of, BASE)
_lockm = np.zeros((D, W), bool)
_locklev = np.zeros((D, W), np.int32)
for _, _lr, _lc, _lg, _, _ in _locks:
    _lockm[_lr, _lc] = True
    _locklev[_lr, _lc] = _lg
# and the river water by a lock gate's outer side (the approaches) stands at its stretch's level: the DGM over an
# approach is interpolated from the walls round it (no ground returns in the water), and the upper approach's median
# came out a metre over the reach in front of the Kachlet's north chamber. A body that reaches within 3.5 m of a gate
# takes the stretch level there (the top water voxel as the overrides' levels: floor(level - base + 0.5) - 1)
_gatelv = np.full((D, W), -1, np.int32)
for _, _gl in overrides.gate_lines(osm.lines):
    _gr, _gc = cells_of(_gl.buffer(3.5), all_touched=True)
    _gatelv[_gr, _gc] = np.floor(np.broadcast_to(RIVER_LV, (D, W))[_gr, _gc] - BASE + 0.5).astype(np.int32)
_gatelv[_lockm] = -1


def _bodies(ww, pool, pool0):
    """the water bodies of a window (ndimage.label), cut where the pools meet. Water that took another pool than its
    stretch's (pool vs pool0) keeps it only where it joins that pool's own water in the window: else it would stand
    apart, a body too small to be flattened, and is back in its stretch's pool"""
    ps = np.unique(pool[ww])
    if len(ps) <= 1:
        return ndimage.label(ww)
    pool = pool.copy()
    for p_ in ps:
        l_, _ = ndimage.label(ww & (pool == p_))
        stray = (l_ > 0) & ~np.isin(l_, l_[(pool0 == p_) & (l_ > 0)])
        pool[stray] = pool0[stray]
    ps = np.unique(pool[ww])
    if len(ps) <= 1:
        return ndimage.label(ww)
    bl, bn = np.zeros(ww.shape, np.int32), 0
    for p_ in ps:
        l_, n_ = ndimage.label(ww & (pool == p_))
        bl[l_ > 0] = l_[l_ > 0] + bn
        bn += n_
    return bl, bn


for _b in region.blocks(64):
    _w = region._grow(_b, 64)
    _ws = (slice(_w[0], _w[1]), slice(_w[2], _w[3]))
    _bs = (slice(_b[0] - _w[0], _b[1] - _w[0]), slice(_b[2] - _w[2], _b[3] - _w[2]))
    _fl, _fn = ndimage.label(_flat[_ws])
    _big = (np.bincount(_fl.ravel()) >= 2000)[_fl] & (_fl > 0)
    _big = ndimage.binary_dilation(_big, iterations=3) & _near_lv[_ws]
    _ww = (_w0[_ws] | _big) & ~_lockm[_ws]
    _wat[_b[0]:_b[1], _b[2]:_b[3]] = _ww[_bs]
    _bl, _bn = _bodies(_ww, _pool[_ws], _pool0[_ws])
    _ids = np.unique(_bl[_bs][_bl[_bs] > 0])
    _ids = _ids[np.bincount(_bl.ravel())[_ids] >= 400]
    if len(_ids):
        _lut = np.full(_bn + 1, -1, np.int32)
        _gw, _glw = g[_ws], _gatelv[_ws]
        for i_ in _ids:
            _m = _bl == i_
            _gt = _glw[_m & (_glw >= 0)]
            _lut[i_] = int(np.median(_gt)) if len(_gt) else int(np.median(_gw[_m]))
        _wlev[_b[0]:_b[1], _b[2]:_b[3]] = _lut[_bl[_bs]]
note(f"rivers from the terrain model: level {RIVER_LEVEL:.1f} m{' (and per stretch)' if RIVER_STRETCHES else ''}, {int((_wat & ~_w0).sum())} cells added to OSM's {int(_w0.sum())}")
gcol[_wat | _lockm] = C["water"]
# the image-matched DOM20 stands a metre or two of noise over open water, and the Danube is green in the ortho:
# it grew a lawn. No surface under 4 m over the water (bridge decks and ships stay) -- but under a bridge way, a low
# deck stays too: the Gaißabrücke (OSM way 24857080, project col -4741, row -1612) stands 3.2 m over the Gaißa, and
# its 25 m over the water had been calmed away (no deck: the road broke off at both banks)
_calm_keep = np.zeros((D, W), np.uint8)
burn(_calm_keep, [(p_, 1) for p_, _, _ in bridge_shapes])
_calm = (gcol == C["water"]) & (nd_max < 4) & (_calm_keep == 0)
for _a in (nd_max, nd_mean, nd_max_b):
    _a[_calm] = 0
exg[_calm] = -1
_fw = (_wlev >= 0) & (gcol == C["water"])
g[_fw] = _wlev[_fw]
note("water cells flattened to their body's level:", int(_fw.sum()))
if _locks:
    g[_lockm] = _locklev[_lockm]
    note("water overrides (own level): (way, cells, water top m a.s.l.)",
         [(o_, len(r_), g_ + BASE) for o_, r_, _, g_, _, _ in _locks])
splash_pads = [(int(typ == "relation"), oid, geom) for oid, typ, t, geom in osm.areas if t.get("fountain") == "splash_pad" and not underground(t)]

# zebra crossings + lane markings on asphalt
asph = np.isin(gcol, [C["asphalt"], C["asphalt_l"], C["parking"], C["road_paving"]])
n_cross = 0
for oid, t, line in osm.lines:
    if not (t.get("footway") == "crossing" or t.get("cycleway") == "crossing" or
            (t.get("highway") in ("footway", "cycleway", "path") and "crossing" in t)):
        continue
    if t.get("crossing") in ("unmarked", "no") or underground(t):
        continue
    cyc = t.get("highway") == "cycleway" or t.get("cycleway") == "crossing"
    rr, cc = cells_of(line.buffer(1.5 if cyc else 2.2, cap_style="flat"))
    if len(rr) == 0:
        continue
    n_cross += 1
    for r, c in zip(rr, cc):
        if not asph[r, c] and gcol[r, c] not in (C["asphalt"], C["trambed"]):
            continue
        tpos = line.project(Point(c + 0.5, r + 0.5))
        if cyc:
            gcol[r, c] = C["cycle"]
        elif int(tpos) % 2 == 0:
            gcol[r, c] = C["mark"]
note("zebra crossings:", n_cross)

lane_lines = []
for oid, t, line in osm.lines:
    hw = t.get("highway")
    if hw not in ("primary", "secondary", "trunk", "primary_link", "secondary_link") or underground(t):
        continue
    lanes = int(parse_len(t.get("lanes")) or (2 if hw in ("primary", "secondary", "tertiary") else 1))
    if lanes < 2:
        continue
    width = parse_len(t.get("width")) or lanes * 3.1
    lw = width / lanes
    oneway = t.get("oneway") in ("yes", "-1")
    for k in range(1, lanes):
        off = -width / 2 + k * lw
        try:
            ln = line.offset_curve(off) if abs(off) > 0.2 else line
        except Exception:
            continue
        if ln.is_empty or ln.length < 4:
            continue
        solid = (not oneway) and abs(off) < 0.6
        if solid:
            lane_lines.append(ln)
            continue
        # (an offset of a line that folds back on itself comes out in pieces: a MultiLineString)
        for part in getattr(ln, "geoms", [ln]):
            L = part.length
            for s in np.arange(1.0, L - 1, 9.0):
                lane_lines.append(substring(part, s, min(s + 3, L)))
_deg, _hw = {}, {}
for oid, t, line in osm.lines:
    b = (t.get("highway") or "").replace("_link", "")
    if b not in HW or b not in ROADS or underground(t) or on_bridge(t):
        continue
    xy = [tuple(np.round(p, 1)) for p in line.coords]
    for k, p in enumerate(xy):
        _deg[p] = _deg.get(p, 0) + (k > 0) + (k < len(xy) - 1)
        # (the carriageway's own width: an 8-lane approach is 25 m wide, and lane dashes ran on into its junction)
        _wd = parse_len(t.get("width")) or (parse_len(t.get("lanes")) or 0) * 3.1
        _hw[p] = max(_hw.get(p, 0), HW[b] / 2, _wd / 2)
_junc = [Point(p).buffer(_hw[p] + 4) for p, d in _deg.items() if d >= 3]
_junc += [geom for oid, typ, t, geom in osm.areas_with("area:highway") if t.get("junction") and not underground(t)]
lm = np.zeros((D, W), np.uint16)
burn(lm, [(l, 1) for l in lane_lines], all_touched=False)
_jm = np.zeros((D, W), np.uint16)
burn(_jm, [(j, 1) for j in _junc])
lm_mask = (lm > 0) & (_jm == 0) & np.isin(gcol, [C["asphalt"]])
gcol[lm_mask] = C["mark"]
note("lane marking cells:", int(lm_mask.sum()))

stage("ground classes, roads, water")
# ---------------------------------------------------------------- buildings
feats = []
for oid, typ, t, geom in osm.areas:
    part = t.get("building:part") not in (None, "no")
    bld = t.get("building") not in (None, "no") and not part
    if not (part or bld) or t.get("building") == "construction" or t.get("location") == "underground":
        continue
    if layer_of(t) < 0 and not part:
        continue
    h = parse_len(t.get("height"))
    lv = parse_len(t.get("building:levels"))
    if h is None and lv is not None:
        h = lv * 3.2 + (parse_len(t.get("roof:height")) or (parse_len(t.get("roof:levels")) or 0) * 2.8)
    mh = parse_len(t.get("min_height"))
    if mh is None and t.get("building:min_level"):
        mh = parse_len(t["building:min_level"], 0) * 3.2
    if t.get("building") in ("roof", "carport") and mh is None:
        mh = 2.5
    rr, cc = cells_of(geom)
    if len(rr) == 0:
        continue
    feats.append(dict(id=oid, typ=typ, tags=t, geom=geom, part=part, rr=rr, cc=cc, maxh=h, minh=mh or 0.0,
                      area=geom.area))
note("building features:", len(feats), "parts:", sum(f["part"] for f in feats))


def lod2_only_buildings():
    """Buildings LoD2 has and OSM does not (sheds, garages, back houses, a school's wing: ~380 of them, 19,000 cells
    the surface model stands 3 m and more over): a building of LoD2's footprint where OSM has no building on 80 % of it,
    the surface model agrees with its roof (medians within 3 m) and OSM maps no construction site over it (a block
    being pulled down since the flight) and no bridge through it; not a strip under 4 m wide (a wall, a deck)."""
    if LOD2 is None or "cen" not in LOD2:
        return []
    z_ = LOD2
    lb = np.where(z_["cen"], z_["bid"], 0)
    lz_ = z_["z"] - dtm
    have = np.zeros((D, W), bool)
    for f in feats:
        have[f["rr"], f["cc"]] = True
    have |= ndimage.binary_dilation(have, iterations=1)  # (an outline a cell short of its LoD2 footprint)
    site = np.zeros((D, W), np.uint8)
    burn(site, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("landuse") == "construction" or "demolished:building" in t_
                or t_.get("building") == "construction"])
    # nor a bridge: LoD2 models the Poststeg's deck as a building (its OSM way 4 m beside it)
    burn(site, [(l_.buffer(8), 1) for _, t_, l_ in osm.lines if on_bridge(t_)])
    out = []
    for i, sl_ in enumerate(ndimage.find_objects(lb), 1):
        if sl_ is None:
            continue
        m = lb[sl_] == i
        n = int(m.sum())
        if n < 20 or have[sl_][m].mean() > 0.2 or site[sl_][m].mean() > 0.3:
            continue
        hz, hd = float(np.nanmedian(lz_[sl_][m])), float(np.median(nd_max_b[sl_][m]))
        if hz < 2.5 or abs(hz - hd) > 3:
            continue
        if ndimage.distance_transform_edt(np.pad(m, 1)).max() < 2.5:
            continue  # a strip 4 m wide or less: a wall (the fortresses' curtain walls), a deck -- not a house
        rr, cc = np.nonzero(m)
        rr, cc = rr + sl_[0].start, cc + sl_[1].start
        polys = [shape(s) for s, v in rasterio.features.shapes(m.astype(np.uint8), mask=m,
                 transform=Affine.translation(sl_[1].start, sl_[0].start)) if v]
        geom = max(polys, key=lambda p: p.area)
        out.append(dict(id=-i, typ="lod2", tags={"building": "yes"}, geom=geom, part=False, rr=rr, cc=cc, maxh=None,
                        minh=0.0, area=float(n)))
    note(f"buildings from LoD2 alone (none in OSM): {len(out)}, {sum(len(f['rr']) for f in out)} cells")
    return out


feats += lod2_only_buildings()

outlines = [f for f in feats if not f["part"]]
parts = [f for f in feats if f["part"]]
otree = STRtree([f["geom"] for f in outlines])
for p in parts:  # parts inherit colours/material/name from their outline
    rp = p["geom"].representative_point()
    # inside several outlines (a block relation, the same outline mapped twice): the smallest -- never the spatial
    # index's order, which changes with the map
    hits = sorted((outlines[i] for i in otree.query(rp, predicate="within")), key=lambda o: (round(o["area"], 1), -o["id"]))
    for o in hits:
        o["has_parts"] = True
    if hits:
        p["parent"] = hits[0]
for p in parts:
    if "parent" not in p:
        cands = [outlines[i] for i in otree.query(p["geom"], predicate="intersects")]
        if cands:
            p["parent"] = max(cands, key=lambda o: (round(o["geom"].intersection(p["geom"]).area, 1), -o["id"]))
            p["parent"]["has_parts"] = True
for o in outlines:
    # outline with parts not rendered (OSM simple-3D convention) if parts cover most of it
    if o.get("has_parts"):
        covered = sum(p["geom"].intersection(o["geom"]).area for p in parts if p.get("parent") is o)
        o["render"] = covered < 0.6 * o["area"]
    else:
        o["render"] = True
for p in parts:
    p["render"] = True
render = [f for f in feats if f["render"]]


def align_to_lod2(outlines, parts):
    """OSM's outlines are traced from imagery and stand up to 4 m off the surface model in places (the Dom's 3 m to
    the north-west; over the town ~1 m east on average): the voxels missed a strip of every such building on one side
    and stood a sliver of wall in the street on the other. The LoD2 footprints (scripts/lod2.py: the cadastre's, the
    surface model's position) are the reference; OSM keeps the tags.
    Per outline: the LoD2 buildings it covers (a third of one, or it covers a third of the outline's cells), and the
    whole-metre shift up to 4 m that fits the outline best onto them (by the share of cells in common; it must gain
    4 points over staying and end at 0.6 or more). The outline and its parts move by it. Then the cells: an LoD2
    footprint's cells no building has go to the nearest outline (or its nearest part) within 4 m that covers that
    LoD2 building; an outline's cells outside every LoD2 footprint where the surface model stands under 2.5 m (a
    sliver of street) go, when the outline has LoD2 buildings at all. Outlines LoD2 does not know (built since) stay."""
    if LOD2 is None:
        return
    z_ = LOD2
    if "cen" not in z_:
        note("data/lod2.npz has no footprints (rerun scripts/lod2.py): OSM outlines left where they are")
        return
    lb = np.where(z_["cen"], z_["bid"], 0)
    lcount = np.bincount(lb.ravel())
    kids = {}
    for p in parts:
        if p.get("parent") is not None:
            kids.setdefault(id(p["parent"]), []).append(p)
    shifts, matched = [], {}
    for o in outlines:
        rr, cc = o["rr"], o["cc"]
        if len(rr) < 12 or o["tags"].get("building") in ("roof", "carport", "canopy"):
            continue
        ids, n = np.unique(lb[rr, cc], return_counts=True)
        k = (ids > 0) & ((n >= 0.33 * lcount[ids]) | (n >= 0.33 * len(rr)))
        if not k.any():
            continue
        ids = ids[k]
        matched[id(o)] = set(ids.tolist())
        P = 4
        r0, c0 = rr.min() - P, cc.min() - P
        r1, c1 = rr.max() + P + 1, cc.max() + P + 1
        if r0 < 0 or c0 < 0 or r1 > D or c1 > W:
            continue
        L_ = np.isin(lb[r0:r1, c0:c1], ids)
        m_ = np.zeros(L_.shape, bool)
        m_[rr - r0, cc - c0] = True
        nL, nm = int(L_.sum()), len(rr)
        best, iou0 = None, None
        for dy in range(-P, P + 1):
            for dx in range(-P, P + 1):
                inter = int((np.roll(m_, (dy, dx), (0, 1)) & L_).sum())
                iou = inter / (nL + nm - inter)
                if dx == 0 and dy == 0:
                    iou0 = iou
                score = iou - 0.004 * math.hypot(dx, dy)  # (of equal fits the smaller shift)
                if best is None or score > best[0]:
                    best = (score, iou, dx, dy)
        _, iou, dx, dy = best
        if (dx or dy) and iou >= 0.6 and iou - iou0 >= 0.04:
            shifts.append((o, dx, dy))
    from shapely.affinity import translate
    n_moved = 0
    for o, dx, dy in shifts:
        for f in [o] + kids.get(id(o), []):
            ok = (f["rr"] + dy >= 0) & (f["rr"] + dy < D) & (f["cc"] + dx >= 0) & (f["cc"] + dx < W)
            f["rr"], f["cc"] = f["rr"][ok] + dy, f["cc"][ok] + dx
            f["geom"] = translate(f["geom"], dx, dy)
            n_moved += len(f["rr"])
    sh = np.array([(dx, dy) for _, dx, dy in shifts]) if shifts else np.zeros((0, 2))
    note(f"OSM outlines moved onto their LoD2 footprints: {len(shifts)} of {len(matched)} matched "
         f"(mean shift {sh.mean(0).round(2).tolist() if len(sh) else 0} m east/south)")
    # the cells: owner of every building cell (outlines by size, small last; then rendered parts)
    owner = np.zeros((D, W), np.int32)
    allf = sorted(outlines, key=lambda f: -f["area"]) + [p for p in parts if p.get("parent") is not None]
    for i_, f in enumerate(allf, 1):
        owner[f["rr"], f["cc"]] = i_
    root = lambda f: f if not f["part"] else f["parent"]
    # add: LoD2 footprint cells no feature has, to the nearest feature whose outline matched that LoD2 building
    free = (lb > 0) & (owner == 0)
    d_, (ir, ic) = ndimage.distance_transform_edt(owner == 0, return_indices=True)
    rr_, cc_ = np.nonzero(free & (d_ <= 4))
    add = {}
    for r, c in zip(rr_, cc_):
        f = allf[owner[ir[r, c], ic[r, c]] - 1]
        if not f["render"]:
            continue  # (an outline drawn through its parts only)
        if lb[r, c] in matched.get(id(root(f)), ()):
            add.setdefault(id(f), (f, []))[1].append((r, c))
    n_add = 0
    for f, cells in add.values():
        a_ = np.array(cells)
        f["rr"], f["cc"] = np.r_[f["rr"], a_[:, 0]], np.r_[f["cc"], a_[:, 1]]
        n_add += len(a_)
    # drop: cells off every LoD2 footprint, low in the surface model, of matched outlines
    far = lb == 0
    low = nd_max_b < 2.5
    n_drop = 0
    for f in allf:
        if id(root(f)) not in matched:
            continue
        k = far[f["rr"], f["cc"]] & low[f["rr"], f["cc"]]
        if k.any() and k.mean() < 0.5:
            f["rr"], f["cc"] = f["rr"][~k], f["cc"][~k]
            n_drop += int(k.sum())
    note(f"building cells from the LoD2 footprints: {n_add} added, {n_drop} dropped (no building there)")


align_to_lod2(outlines, parts)


def close_slots():
    """A slot 1 m wide between two buildings that the surface model sees roofed (3 m and more up, not green): two OSM
    outlines that do not quite meet (the Veste Niederhaus' main block and its east wing: a dark gap down the whole
    facade). It goes to the building next to it with the higher roof. Not over a mapped way (a passage, steps)."""
    own = np.zeros((D, W), np.int32)
    fs = [f for f in render]
    for i_, f in enumerate(fs, 1):
        own[f["rr"], f["cc"]] = i_
    bm = own > 0
    # a 1 m gap with two different buildings on its two sides (a 2 m one is as likely an alley the map lacks)
    closed = np.zeros((D, W), bool)
    for ax in (0, 1):
        a_, b_ = region.shift(own, 1, ax), region.shift(own, -1, ax)
        closed |= (a_ > 0) & (b_ > 0) & (a_ != b_)
    ways = np.zeros((D, W), np.uint8)
    burn(ways, [(l_.buffer(1.5), 1) for _, t_, l_ in osm.lines if t_.get("highway")])
    slot = closed & ~bm & (nd_max_b >= 3) & (exg < 0.06) & (ways == 0)
    if not slot.any():
        return
    hi = np.where(bm, nd_max_b, -1.0)
    best = np.zeros((D, W), np.int32)
    bh = np.full((D, W), -1.0)
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        o_ = region.shift2(own, (dr, dc))
        h_ = region.shift2(hi, (dr, dc))
        k_ = slot & (o_ > 0) & (h_ > bh)
        best[k_], bh[k_] = o_[k_], h_[k_]
    rr_, cc_ = np.nonzero(slot & (best > 0))
    add = {}
    for r, c in zip(rr_, cc_):
        add.setdefault(best[r, c], []).append((r, c))
    for i_, cells in add.items():
        f = fs[i_ - 1]
        a_ = np.array(cells)
        f["rr"], f["cc"] = np.r_[f["rr"], a_[:, 0]], np.r_[f["cc"], a_[:, 1]]
    note("slots between buildings closed (roofed in the surface model):", len(rr_), "cells")


close_slots()



def tag(f, k):
    v = f["tags"].get(k)
    if v is None and f.get("parent") is not None:
        v = f["parent"]["tags"].get(k)
    return v


bmask = np.zeros((D, W), bool)
for f in render:
    bmask[f["rr"], f["cc"]] = True

# feature-level source decision (the surface model vs current OSM)
top = np.where(bmask, nd_max_b, 0.0).astype(np.float32)
src_osm = []
for f in render:
    if f["maxh"] is None:
        continue
    v = nd_max_b[f["rr"], f["cc"]]
    med, p90 = float(np.median(v)), float(np.percentile(v, 90))
    f["dsm_med"] = med
    if f["maxh"] - p90 > 8:
        small = f["area"] < 80 and p90 > 0.7 * f["maxh"]  # needle on top of a tall building
        rh = parse_len(f["tags"].get("roof:height")) or 0
        pointed = f["tags"].get("roof:shape") in ("pyramidal", "conical", "onion", "spire", "dome") and rh >= 3
        if pointed and len(f["rr"]) >= 9 and p90 > 0.6 * (f["maxh"] - rh):
            # a tower's pointed roof the LiDAR missed (a church's bell towers: 61 m of tower, a 15 m pyramid): it
            # rises from the eaves to its peak by distance from the part's edge -- not the whole footprint at 76 m
            rr_, cc_ = f["rr"], f["cc"]
            m_ = np.zeros((rr_.max() - rr_.min() + 3, cc_.max() - cc_.min() + 3), bool)
            m_[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1] = True
            dep = ndimage.distance_transform_edt(m_)[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1]
            roof_ = (f["maxh"] - rh) + rh * (dep - 1) / max(dep.max() - 1, 1)
            top[rr_, cc_] = np.maximum(top[rr_, cc_], roof_)
            src_osm.append((f["id"], tag(f, "name"), round(p90, 1), f["maxh"], "pointed roof"))
        elif small or p90 < 0.35 * f["maxh"]:  # else: nothing tall there in the surface model -> built after the flight
            # spire/needle under-sampled by LiDAR, or built after the flight
            top[f["rr"], f["cc"]] = np.maximum(top[f["rr"], f["cc"]], f["maxh"])
            src_osm.append((f["id"], tag(f, "name"), round(p90, 1), f["maxh"], "spire" if small else "new"))
for s in src_osm:
    note("OSM height used (LiDAR lower):", s)
# OSM buildings absent in LiDAR without height info
for f in render:
    if f["maxh"] is None and np.median(nd_max[f["rr"], f["cc"]]) < 1.5:
        top[f["rr"], f["cc"]] = 3.2 * (parse_len(tag(f, "building:levels")) or 1)
        note("no LiDAR + no height -> levels:", f["id"], tag(f, "name"))

# tree canopy over low roofs: clip to OSM height
cell_maxh = np.full((D, W), np.nan, np.float32)
for f in sorted(render, key=lambda f: f["maxh"] or 0):
    if f["maxh"] is not None:
        cell_maxh[f["rr"], f["cc"]] = np.fmax(cell_maxh[f["rr"], f["cc"]], f["maxh"])
# a crown that is not green (a copper beech over a low house) is still rough: the DSM's spread over 3 m is ~4 m in a
# crown, under 1 m on a roof. Only over a small low house standing among crowns (a ring round it, away from other
# buildings, tall and green or rough) whose raised cells are mostly rough: a mistagged tower is smooth on top
_m = boxmean(dsm, 6)
rough = np.sqrt(np.maximum(boxmean(dsm * dsm, 6) - _m * _m, 0)).reshape(D, 2, W, 2).max((1, 3))
under_tree = np.zeros((D, W), bool)
for f in render:
    if f["part"] or f.get("has_parts") or f["maxh"] is None or f["maxh"] > 8 or f["area"] >= 400:
        continue
    r0, r1, c0, c1 = max(f["rr"].min() - 5, 0), min(f["rr"].max() + 6, D), max(f["cc"].min() - 5, 0), min(f["cc"].max() + 6, W)
    own = np.zeros((r1 - r0, c1 - c0), bool)
    own[f["rr"] - r0, f["cc"] - c0] = True
    ring = ndimage.binary_dilation(own, iterations=4) & ~ndimage.binary_dilation(bmask[r0:r1, c0:c1] & ~own, iterations=3) & ~own
    crown = (nd_max[r0:r1, c0:c1] > f["maxh"] + 3) & ((exg[r0:r1, c0:c1] > 0.06) | (rough[r0:r1, c0:c1] > 2.5))
    raised = nd_max[f["rr"], f["cc"]] > f["maxh"] + 3
    if ring.sum() > 10 and crown[ring].mean() > 0.25 and raised.any() and (rough[f["rr"], f["cc"]][raised] > 2.5).mean() > 0.6:
        under_tree[f["rr"], f["cc"]] = True
over = bmask & ((exg > 0.06) | under_tree) & np.isfinite(cell_maxh) & (top > cell_maxh + 3)
top[over] = cell_maxh[over]
note("roof cells under tree canopy clipped:", int(over.sum()), "of them rough, not green:", int((over & ~(exg > 0.06)).sum()))

# bottoms (overhangs: roofs/carports/stacked parts with no part below)
bot_rel = np.full((D, W), 1e9, np.float32)
# outlines drawn only through their parts count too: a part starting at 19 m with no part mapped under it (a tower
# over its podium, a ministry's top floors) stands on its outline's walls, it does not hover over the street
for f in feats:
    if f["render"] or f.get("has_parts"):
        bot_rel[f["rr"], f["cc"]] = np.minimum(bot_rel[f["rr"], f["cc"]], f["minh"])
bot_rel[~bmask] = 0
bot_rel[bot_rel < 2.5] = 0

top_dsm = top.copy()  # the surface model's roofs (with OSM's spires and the clipped crowns), before any smoothing
# de-noise low roofs (LiDAR clutter) in building interiors; keep towers/spires untouched
interior = ndimage.binary_erosion(bmask, iterations=1)
top_med = ndimage.median_filter(top, size=3)
smooth_roof = interior & (top < 45) & (np.abs(top_med - top) < 4)
top = np.where(smooth_roof, top_med, top)


def flatten_roofs(top):
    """Flat roofs flat: per building part, if most of the roof lies within 1.5 m of its median, snap every cell within
    2.5 m to it, and snap blobs above or below it smaller than 15 cells (LiDAR speckle on the roof, a 1 m slot down a
    wall where the edge returns came low). Rooftop structures bigger than that, pitched roofs and towers stay.
    The levels are absolute (above sea level), not heights over the ground: a flat roof over a sloping street is
    level, where a constant height over the ground tilted it with the terrain -- every 1 m contour of the street ran
    across the roof as a step (the shopping centres and blocks on the hillsides)."""
    n_f = n_c = 0
    for f in sorted(render, key=lambda f: -len(f["rr"])):  # parents first, their parts after
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 30 or ((f.get("minh") or 0) >= 2.5 and np.median(bot_rel[rr, cc]) >= 2.5):
            continue  # parts on stilts (canopies, cantilevers): snapping their top under their bottom left fragments
            # (a part on its podium -- a curved wing from 8 m -- stands on something: its roof is snapped too)
        if float(np.median(top[rr, cc])) < 3:
            continue
        gr = dtm[rr, cc] - BASE  # the ground under each cell: heights below are over BASE, written back over the ground
        v = top[rr, cc] + gr
        med = float(np.median(v))
        if np.mean(np.abs(v - med) <= 1.5) < 0.6:
            # several roof levels (one OSM outline over a whole theatre or palace): snap each column to its 5x5
            # neighbourhood's median within 2.5 m, so every terrace is flat and the real setbacks stay
            if len(rr) >= 200:
                r0, c0 = rr.min(), cc.min()
                box = np.zeros((rr.max() - r0 + 3, cc.max() - c0 + 3), np.float32)
                inside = np.zeros(box.shape, bool)
                box[rr - r0 + 1, cc - c0 + 1] = v
                inside[rr - r0 + 1, cc - c0 + 1] = True
                # outside the outline: the nearest inside height (zeros there pulled the median down at every edge,
                # notching the roofline)
                _, (ir, ic) = ndimage.distance_transform_edt(~inside, return_indices=True)
                lm = ndimage.median_filter(box[ir, ic], 5)[rr - r0 + 1, cc - c0 + 1]
                k = (np.abs(v - lm) <= 2.5) & (lm - gr > 3)
                n_c += int((k & (v != lm)).sum())
                top[rr[k], cc[k]] = lm[k] - gr[k]
                # then the roof's own levels: peaks of its height histogram (1 m bins, 6 % of the roof or 40 cells);
                # cells within 1.5 m of a level go to it -- 1 m terraces of LiDAR noise between them (lumpy
                # podium roofs) were drawn as steps
                v2 = top[rr, cc] + gr
                hist = np.bincount(np.clip(np.round(v2).astype(int), 0, 400), minlength=402)
                lev = [h for h in range(1, 401) if hist[h] >= max(40, 0.06 * len(v2)) and hist[h] >= hist[h - 1] and hist[h] >= hist[h + 1]]
                if lev:
                    # levels closer than 2.5 m are one level with noise (two neighbouring 1 m bins): the larger stays
                    lev = sorted(lev, key=lambda h: -hist[h])
                    keep_ = []
                    for h in lev:
                        if all(abs(h - k_) >= 2.5 for k_ in keep_):
                            keep_.append(h)
                    lev = np.array(sorted(keep_), np.float32)
                    j = np.argmin(np.abs(v2[:, None] - lev[None]), axis=1)
                    k2 = np.abs(v2 - lev[j]) <= 1.5
                    n_c += int((k2 & (v2 != lev[j])).sum())
                    top[rr[k2], cc[k2]] = lev[j][k2] - gr[k2]
                n_f += 1
            continue
        r0, c0 = rr.min(), cc.min()
        off = np.zeros((rr.max() - r0 + 1, cc.max() - c0 + 1), bool)
        off[rr - r0, cc - c0] = np.abs(v - med) > 2.5
        lab, n = ndimage.label(off)
        if n:
            size = ndimage.sum(off, lab, range(1, n + 1))
            keep = np.concatenate([[False], size >= 15])  # big blobs: real structures
            snap = ~keep[lab[rr - r0, cc - c0]]
        else:
            snap = np.ones(len(rr), bool)
        n_c += int((snap & (v != med)).sum())
        top[rr[snap], cc[snap]] = med - gr[snap]
        n_f += 1
    note(f"flat roofs: {n_f} parts, {n_c} cells snapped")


flatten_roofs(top)


_DIST_GRAD = None


def _fit_grad(rr, cc, k, slope_m):
    """The plane of a roof fitted as eave + k x distance to the open side (core_roofs, dsm_pitched_roofs): rising k per
    metre away from the nearest wall; flat where it is capped at the ridge (slope_m False)."""
    global _DIST_GRAD
    if _DIST_GRAD is None:
        _d = ndimage.distance_transform_edt(bmask).astype(np.float32)
        _DIST_GRAD = np.gradient(boxmean(_d, 3))
    gy_, gx_ = _DIST_GRAD[0][rr, cc], _DIST_GRAD[1][rr, cc]
    n_ = np.hypot(gx_, gy_)
    ok = slope_m & (n_ > 0.3)
    ROOF_GX[rr, cc] = np.where(ok, k * gx_ / np.maximum(n_, 1e-6), np.where(slope_m, np.nan, 0))
    ROOF_GY[rr, cc] = np.where(ok, k * gy_ / np.maximum(n_, 1e-6), np.where(slope_m, np.nan, 0))


def core_roofs(top):
    """The historic core's tiled roofs as the ortho shows them: clean slopes from the street and the courtyard up to a
    ridge. The 1 m LiDAR made them noisy terraces (every dormer, chimney and sample). Per house in the historic core
    whose roof is pitched (3 m or more between its eaves and its top): height = eave + slope x distance to the nearest
    open cell (street or courtyard; through party walls, as a terrace of houses is roofed), fitted to the LiDAR on the
    cells within 8 m of the open side, capped at the house's ridge (95th percentile)."""
    core = np.zeros((D, W), bool)
    core[cells_of(CORE_GEOM)] = True
    dist = ndimage.distance_transform_edt(bmask)
    n_h = 0
    for f in render:
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 20 or not core[rr, cc].mean() > 0.5 or (f.get("minh") or 0) > 2:
            continue
        v, d = top[rr, cc].astype(float), dist[rr, cc]
        if np.percentile(v, 95) - np.percentile(v, 10) < 3:
            continue
        m = (d <= 8) & (v > 3)
        if m.sum() < 8:
            continue
        for _ in range(3):  # least squares, dropping dormers and chimneys (2 m+ off the slope) each round
            A = np.c_[np.ones(m.sum()), d[m]]
            (e, k), *_ = np.linalg.lstsq(A, v[m], rcond=None)
            m &= np.abs(v - (e + k * d)) < 2
            if m.sum() < 8:
                break
        if not (0.4 <= k <= 2.5) or m.sum() < 8:
            continue
        ridge = np.percentile(v, 95)
        top[rr, cc] = np.minimum(e + k * d, ridge)
        _fit_grad(rr, cc, k, e + k * d < ridge)
        n_h += 1
    note("historic core: pitched roofs fitted:", n_h)


REVERTED = []  # buildings left to the surface model (data/debug/lod2_reverted.json)
LOD2_USE = np.zeros((D, W), bool)  # the cells whose roof LoD2 gives
# the roof plane under each cell where it is known exactly (LoD2's plane, or a fitted pitched roof's slope): its rise per
# metre east and south. The viewer lit a pitched roof by a plane estimated from the 1 m voxel steps, and a slope rounded
# to whole metres reads as noise there -- every roof a mottle of light and dark voxels. Shipped per column (plane_codes)
ROOF_GX = np.full((D, W), np.nan, np.float32)
ROOF_GY = np.full((D, W), np.nan, np.float32)


def lod2_roofs(top):
    """The roofs of the LoD2 building models (scripts/lod2.py: planes fitted to the laser scan per building -- ridges,
    hips, eaves, flat decks) wherever they agree with the surface model. The DOM20 is matched from aerial images: on a
    pitched roof every 1 m sample is a step of its own, so the old town's roofs were grey terraces and blobs; the
    planes give each a clean slope up to a straight ridge. Per cell: the LoD2 roof within 3.5 m of the surface model;
    or off it in a patch of under 30 cells (a chimney, an aerial, a crown over the roof up to 6 m above it; a notch
    where the samples fell down a wall). A tower or a spire LoD2 lacks (a big patch above it, OSM's heights) and a
    building LoD2 does not know keep the surface model.
    Returns the cells of pitched roofs (a slope of 0.3 or more) taken from LoD2."""
    if LOD2 is None:
        note("no data/lod2.npz (scripts/lod2.py): roofs from the surface model only")
        return np.zeros((D, W), bool)
    z_ = LOD2
    lz, sl = z_["z"] - dtm, z_["slope"]
    if "gx" not in z_:
        raise SystemExit("data/lod2.npz has no plane gradients (`gx`, `gy`): rerun scripts/lod2.py")
    lgx, lgy = z_["gx"], z_["gy"]
    have = np.isfinite(lz)
    # an OSM outline a cell or two wider than the LoD2 building (along a wall, a misregistered corner): its roof's
    # nearest cell
    d_, (ir, ic) = ndimage.distance_transform_edt(~have, return_indices=True)
    fill = bmask & ~have & (d_ <= 2)
    lz = np.where(fill, lz[ir, ic], lz)
    sl = np.where(fill, sl[ir, ic], sl)
    lgx, lgy = np.where(fill, lgx[ir, ic], lgx), np.where(fill, lgy[ir, ic], lgy)
    cand = bmask & np.isfinite(lz) & (lz > 2) & ~(top_dsm > nd_max_b + 1)  # (not where OSM's heights raised it)
    dlt = top_dsm - lz
    use = cand & (np.abs(dlt) <= 3.5)
    # (a small tower or turret over the roof -- 6 m and more, or a part OSM maps taller -- is no chimney)
    tower = np.nan_to_num(cell_maxh) > lz + 4
    for off, cap in ((cand & (dlt > 3.5) & (dlt <= 6) & ~tower, 30), (cand & (dlt < -3.5), 30)):
        lab, n = ndimage.label(off)
        if n:
            use |= off & np.r_[False, ndimage.sum(off, lab, range(1, n + 1)) < cap][lab]
    # a building the two disagree on over half its roof (rebuilt since one of them, a courtyard roofed over): all of it
    # from the surface model -- patches of planes among the stepped samples read as rubble
    n_rev = 0
    for f in render:
        u_ = use[f["rr"], f["cc"]]
        if 0 < u_.mean() < 0.5:
            use[f["rr"], f["cc"]] = False
            n_rev += 1
            REVERTED.append(dict(id=f["id"], name=tag(f, "name"), r=int(f["rr"].mean()), c=int(f["cc"].mean()),
                                 n=len(f["rr"]), lod2=round(float(u_.mean()), 2)))
    top[use] = lz[use]
    LOD2_USE[...] = use
    ROOF_GX[use], ROOF_GY[use] = lgx[use], lgy[use]
    pitched = use & (sl >= 0.3)
    json.dump(REVERTED, open(RDIR / "lod2_reverted.json", "w"), indent=0)
    note("LoD2 roofs taken:", int(use.sum()), "of", int(bmask.sum()), "building cells; pitched:", int(pitched.sum()),
         "; buildings left to the surface model:", n_rev)
    return pitched


def dsm_pitched_roofs(top):
    """A pitched roof LoD2 does not give (a building it lacks or disagrees on: rebuilt, a castle's wing, a tower's
    house) stayed the surface model's: a noisy staircase of 1 m samples, every dormer and matching error a step. As
    core_roofs does for the old town: per building whose roof is not LoD2's and is pitched (3 m or more between its
    eaves and its top), eave + slope x distance to the nearest open cell, fitted to the surface model (least squares,
    dropping dormers and chimneys 2 m off), capped at its ridge (95th percentile) -- where the fit is a roof: a slope of
    0.3 to 1.5 and 60 % of the building within 1.5 m of it (a tower on a flat block, terraces of a stepped one are no
    such roof). Returns the cells fitted."""
    dist = ndimage.distance_transform_edt(bmask)
    out = np.zeros((D, W), bool)
    n_h = 0
    for f in render:
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 30 or (f.get("minh") or 0) > 2 or LOD2_USE[rr, cc].mean() > 0.2:
            continue
        k_ = ~LOD2_USE[rr, cc]
        rr, cc = rr[k_], cc[k_]
        v, d = top[rr, cc].astype(float), dist[rr, cc]
        if np.percentile(v, 95) - np.percentile(v, 10) < 3:
            continue
        m = (d <= 8) & (v > 3)
        if m.sum() < 12:
            continue
        for _ in range(3):
            A = np.c_[np.ones(m.sum()), d[m]]
            (e, k), *_ = np.linalg.lstsq(A, v[m], rcond=None)
            m &= np.abs(v - (e + k * d)) < 2
            if m.sum() < 12:
                break
        if not (0.3 <= k <= 1.5) or m.sum() < 12:
            continue
        ridge = np.percentile(v, 95)
        model = np.minimum(e + k * d, ridge)
        if np.mean(np.abs(v - model) <= 1.5) < 0.6:
            continue
        # (a chimney, a dormer or a turret 2 m and more over the slope in a patch of 6 cells and more stays)
        up = v - model > 2
        if up.any():
            box = np.zeros((rr.max() - rr.min() + 1, cc.max() - cc.min() + 1), bool)
            box[rr[up] - rr.min(), cc[up] - cc.min()] = True
            lab, n = ndimage.label(box)
            big = np.r_[False, ndimage.sum(box, lab, range(1, n + 1)) >= 6]
            up &= big[lab[rr - rr.min(), cc - cc.min()]]
        top[rr, cc] = np.where(up, v, model)
        _fit_grad(rr, cc, k, (e + k * d < ridge) & ~up)
        ROOF_GX[rr[up], cc[up]] = ROOF_GY[rr[up], cc[up]] = np.nan
        out[rr, cc] = True
        n_h += 1
    note("pitched roofs fitted to the surface model where LoD2 gives none:", n_h, "buildings,", int(out.sum()), "cells")
    return out


CORE_GEOM = landmarks.historic_core()
core_roofs(top)
pitched_m = lod2_roofs(top)
pitched_m |= dsm_pitched_roofs(top)
overrides.roof_shapes(feats, top, dtm, ROOF_GX, ROOF_GY, pitched_m, R0, C0, note)  # (scripts/overrides/building)
# the roof's voxel is its height above sea level rounded once: the ground under it (g) is rounded and smoothed on its own,
# and g + round(height over the ground) put a quarter of all roof cells a metre off their neighbours -- speckle and
# contour lines of the street below across every flat roof and plane of LoD2
topi = np.where(bmask, np.round(top + dtm - BASE) - g, 0).astype(np.int32)
_roof_f = np.where(bmask, top + dtm - BASE, np.nan).astype(np.float32)  # (the roof's height before rounding: caps.py)
# single LiDAR pits in a flat roof (1-3 m deep, up to 3 cells, building all round): each read as a black speck under
# the ambient occlusion (hotels' and banks' roofs); outside the old town's fitted pitched roofs
_cl = ndimage.grey_closing(topi, size=(3, 3))
_pit = bmask & (_cl - topi >= 1) & (_cl - topi <= 3) & (ndimage.minimum_filter(bmask.astype(np.uint8), 3) > 0)
_pit[cells_of(CORE_GEOM)] = False
_pit &= ~pitched_m  # (a valley between two LoD2 roofs is no pit)
_pl, _pn = ndimage.label(_pit)
if _pn:
    _pit &= np.r_[False, ndimage.sum(_pit, _pl, range(1, _pn + 1)) <= 3][_pl]
topi[_pit] = _cl[_pit]
note("roof pits filled:", int(_pit.sum()))
boti = np.round(bot_rel).astype(np.int32)
bmask &= topi >= 2


# colours/materials per feature
SACRED = {"church", "cathedral", "chapel", "basilica", "synagogue", "mosque", "temple", "shrine"}
M_CLASSIC, M_TENEMENT = 20, 22
CORE = CORE_GEOM
# a historic core's plasters where OSM gives no colour: ochre, terracotta, salmon, ivory, cream, an odd sage -- warm,
# rarely cool (the upstream project's palette for a rebuilt old town; Passau's own pastels are not measured yet)
CORE_WALLS = ["#d9a441", "#b55a3f", "#d98f6e", "#efe3c4", "#c98a5a", "#e6d3a3", "#e8c78f", "#b9775a", "#dcb47c",
              "#9daa87", "#c2866e", "#e9d6b4"]


# buildings that are structures, not houses: the shader's facade of storeys of windows over a ground floor of shop
# windows (M_WALL) on them read as housing -- the Kachlet power station (power=plant, building=industrial, its outline
# across the Danube) was a 350 m palace of windows. They get plain walls (M_SOLID)
PLAIN_BUILDINGS = {"industrial", "warehouse", "hangar", "silo", "storage_tank", "transformer_tower", "service",
                   "digester", "bunker", "water_tower", "barn", "farm_auxiliary", "cowshed", "stable", "sty", "garage",
                   "garages", "shed", "carport", "tank", "pumping_station", "bridge", "dam", "weir"}
PLAIN_MAN_MADE = {"works", "water_works", "wastewater_plant", "silo", "storage_tank", "tank", "water_tower",
                  "pumping_station", "reservoir_covered", "kiln", "gasometer", "dam", "weir", "lock_gate"}


def plain_walls(f, btype):
    return (btype in PLAIN_BUILDINGS or tag(f, "power") is not None or tag(f, "man_made") in PLAIN_MAN_MADE
            or tag(f, "waterway") in ("dam", "weir", "lock_gate"))


def wall_style(f):
    t = f["tags"]
    mat_tag = (tag(f, "building:material") or "").lower()
    col = parse_colour(t.get("building:colour") or t.get("colour")) or \
        (parse_colour(f["parent"]["tags"].get("building:colour")) if f.get("parent") else None)
    btype = tag(f, "building") or ""
    h = f["maxh"] or float(np.median(top[f["rr"], f["cc"]]))
    glass = "glass" in mat_tag or (not mat_tag and h > 45 and btype in ("office", "commercial", "hotel", "yes", "retail")
                                   and "building:colour" not in t)
    if glass:
        return pal(soften(col or hex_rgb("#8aa4b4"), 0.08), M_GLASS)
    if mat_tag in ("concrete",) and col is None:
        col = hex_rgb("#c9c6bd")
    if mat_tag in ("brick",) and col is None:
        col = hex_rgb("#a95f45")
    core = CORE.contains(f["geom"].representative_point())
    if col is None:
        walls = CORE_WALLS if core else WALL_DEFAULTS
        col = hex_rgb(walls[stable_hash(f["id"]) % len(walls)])
    if btype in SACRED or tag(f, "amenity") == "place_of_worship":
        return pal(soften(col), M_CLASSIC)  # stone or brick, tall windows: not the shader's office grid of storeys
    if plain_walls(f, btype):
        return pal(soften(col), M_SOLID)  # a plant, a works, a shed: no storeys of house windows (the shader's M_WALL)
    if core:
        return pal(soften(col), M_TENEMENT)
    return pal(soften(col), M_WALL)



ROOF_OVERRULED = []


# roof colours: each roof its own, the median of what the orthophoto sees on it (in CIELAB, so that a median of hues
# is a hue), with the ortho's haze taken out. Five hand-picked red-browns for every tiled roof were ~2x too saturated and
# much darker than the tiles (DOP20, Altstadt clay tiles: median RGB 188,151,133, 10-90 % 138,112,97 .. 222,179,163):
# the town read as one saturated orange where the ortho shows muted salmon and terracotta, roof by roof.
# ROOF_DEHAZE is the one knob: the ortho is taken as  seen = roof * t + ROOF_HAZE * (1 - t).  1 keeps its colours as
# they are (pale, milky); lower deepens and saturates them (0.75: the tiles' median becomes 174,125,100)
ROOF_DEHAZE = 0.75
ROOF_HAZE = np.array([230.0, 230.0, 232.0])
LUMW = np.array([0.299, 0.587, 0.114])
_XYZ = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
_WP = np.array([0.95047, 1.0, 1.08883])


def rgb_lab(c):
    """sRGB 0..255 (... x 3) -> CIELAB (D65)"""
    c = np.asarray(c, float) / 255
    x = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92) @ _XYZ.T / _WP
    f = np.where(x > 216 / 24389, np.cbrt(x), (24389 / 27 * x + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_rgb(lab):
    lab = np.asarray(lab, float)
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], -1)
    x = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * _WP
    l_ = np.clip(x @ np.linalg.inv(_XYZ).T, 0, 1)
    return np.clip(255 * np.where(l_ > 0.0031308, 1.055 * l_ ** (1 / 2.4) - 0.055, 12.92 * l_), 0, 255)


def lab_median(c):
    return lab_rgb(np.median(rgb_lab(c), 0))


def dehaze(rgb):
    return tuple(float(v) for v in np.clip((np.asarray(rgb, float) - ROOF_HAZE * (1 - ROOF_DEHAZE)) / ROOF_DEHAZE, 0, 255))


# a tiled roof the ortho can't tell (too small, or so tall its lean puts facade and street into the roof's cells) that
# OSM calls red: the measured tiles' 10th to 90th percentile, dehazed like the rest
ROOF_TILES = [dehaze(c) for c in ((138, 112, 97), (163, 131, 115), (188, 151, 133), (205, 165, 148), (222, 179, 163))]
# (neutral to faintly warm: the sky's blue fill turned cool greys lilac)
ROOF_GREYS = ["#55565a", "#646568", "#747577", "#858584", "#979692", "#aeaca6", "#c2bfb8"]
ROOF_COPPER = ["#86a99a", "#7d9f91"]
ROOF_LOG = {"tiles": 0, "copper": 0, "grey": 0, "copper_untagged": []}


def ortho_roof(f):
    """What the orthophoto sees on a roof: the share of its cells that are clay-tile red (hue red to orange,
    saturated) and their median colour, the median colour of all its cells, and the share and median colour of its
    copper-patina cells. Not the cells under a crown (one standing over the roof, or green: exg), deep shadow or glare.
    A house's median over all cells mixed the tiles' sunlit orange and shaded brown with dormers, skylights, gutters
    and the street seen past the eaves: tiled roofs came out beige, pink or lilac -- the tiles' own cells it is."""
    rr, cc = f["rr"], f["cc"]
    c0 = cellcol[rr, cc].astype(float)
    L = c0 @ LUMW
    lit = (L > 40) & (L < 235) & ~over[rr, cc]
    ok = lit & (exg[rr, cc] < 0.06)
    c = c0[ok] if ok.sum() >= 3 else c0
    mx, mn = c.max(1), c.min(1)
    s = (mx - mn) / np.maximum(mx, 1)
    tile = (c[:, 0] > c[:, 1] + 12) & (c[:, 0] > c[:, 2] + 25) & (s > 0.15)
    # copper patina by its hue: in this ortho a pale sage, a* -3 .. -9 with b* under 12 (a crown's green is yellow, b*
    # 20-30; slate, metal and the ortho's bluish shadow sit at a* about 0). Patina is green to exg: the lit cells.
    # Checked on the ortho roof by roof: the long roof south-east of the Dom (skylights between its copper strips:
    # 37 % of its cells), the old university, the Ilzstadt's churches
    cl = c0[lit] if lit.sum() >= 3 else c0
    lab = rgb_lab(cl)
    cop = (lab[:, 1] < -3) & (lab[:, 2] < 12) & (lab[:, 2] > -10) & (lab[:, 0] > 35)
    return (tile.mean(), (lab_median(c[tile]) if tile.any() else None), lab_median(c),
            cop.mean(), (lab_median(cl[cop]) if cop.any() else None))


def grey_roof(col, pitched):
    """sheet metal, slate, concrete, gravel: the ortho's lightness, dehazed, and a trace of its hue (mostly sky and
    shadow: a blue-grey turned lilac under the sky's fill); a pitched roof no lighter than a pale metal (white sheet
    roofs read as snow)"""
    lab = rgb_lab(dehaze(col))
    lab[1:] = np.clip(lab[1:] * 0.3, -3, 5)
    lab[0] = np.clip(lab[0], 36, 66 if pitched else 80)  # (dehazed, a tar roof went black)
    return tuple(lab_rgb(lab))


def roof_style(f):
    col = parse_colour(tag(f, "roof:colour"))
    mat = (tag(f, "roof:material") or "").lower()
    if col is None and mat == "glass":
        return pal(soften(hex_rgb("#93adbf"), 0.06), M_GLASS)  # glass atrium roofs (a university hall): blue-grey
    rr, cc = f["rr"], f["cc"]
    h = float(np.median(top[rr, cc]))
    pitched = pitched_m[rr, cc].mean() >= 0.4
    copper_tag = mat == "copper" or (col is not None and col[1] > col[0] + 15 and col[1] >= col[2])
    pick = lambda shades: shades[stable_hash(f["id"]) % len(shades)]
    # (from 80 m up the ortho's lean puts facade and street into the roof's cells: OSM's colour, if any)
    if len(rr) >= 3 and (h < 80 or col is None):
        ft, tc, mc, fc, cop = ortho_roof(f)
        if ft >= 0.3:  # clay tiles: their own median colour, dehazed
            ROOF_LOG["tiles"] += 1
            return pal(dehaze(tc), M_ROOF, q=12)
        # copper patina: by its hue on over a third of the roof, or a tenth where OSM says copper (or a green roof),
        # in the patina cells' own colour. (A fixed mint for the ortho's green-blue tint over all cells had fired on
        # slate, metal, bluish shadow and crowns over the eaves: mint roofs all over the town)
        if fc >= 0.35 or (copper_tag and fc >= 0.1):
            ROOF_LOG["copper"] += 1
            if not copper_tag:
                ROOF_LOG["copper_untagged"].append((f["id"], int(rr.mean()), int(cc.mean()), len(rr)))
            return pal(dehaze(cop), M_ROOF, q=12)
        if col is not None and np.linalg.norm(np.subtract(col, mc)) > 110:
            ROOF_OVERRULED.append((f["id"], tag(f, "roof:colour")))
        ROOF_LOG["grey"] += 1
        return pal(grey_roof(mc, pitched), M_ROOF, q=12)
    if col is None:
        return pal(soften(hex_rgb("#7d7f84"), 0.05), M_ROOF, q=12)
    if copper_tag:
        return pal(soften(hex_rgb(pick(ROOF_COPPER)), 0.05), M_ROOF, q=12)
    if col[0] > col[2] + 35 and col[0] > col[1] + 18:
        return pal(pick(ROOF_TILES[1:4]), M_ROOF, q=12)
    return pal(grey_roof(col, pitched), M_ROOF, q=12)


_GREY_L = sorted((float(np.dot(hex_rgb(h_), LUMW)), h_) for h_ in ROOF_GREYS)
n_dim = 0
for f in render:
    f["wall"] = landmarks.wall_override(f, pal) or wall_style(f)
    _ro = landmarks.roof_override(f, pal)
    f["roof"] = _ro or roof_style(f)
    # a pale flat roof (gravel, membrane: the ortho's glare) on a pale facade was the facade's own colour -- whole
    # blocks of the newer districts read as white boxes with no top. A flat grey roof within 30 of its facade's
    # lightness takes the palette's grey next under 30 darker than the facade
    if _ro is None and not tag(f, "roof:colour"):
        _r, _w = pal.entries[f["roof"]], pal.entries[f["wall"]]
        _rl, _wl = float(np.dot(_r[:3], LUMW)), float(np.dot(_w[:3], LUMW))
        _grey = max(_r[:3]) - min(_r[:3]) < 24
        if _r[3] == M_ROOF and _w[3] != M_GLASS and _grey and abs(_rl - _wl) < 30 and pitched_m[f["rr"], f["cc"]].mean() < 0.4:
            _cand = [h_ for l_, h_ in _GREY_L if l_ <= _wl - 30] or [_GREY_L[0][1]]
            f["roof"] = pal(soften(hex_rgb(_cand[-1]), 0.05), M_ROOF, q=12)
            n_dim += 1
note("pale flat roofs darkened under their facade:", n_dim)
note("roofs by the ortho (tiles / copper / grey):", ROOF_LOG["tiles"], ROOF_LOG["copper"], ROOF_LOG["grey"],
     "copper OSM does not tag:", len(ROOF_LOG["copper_untagged"]), ROOF_LOG["copper_untagged"][:12])
note("roof palette entries:", len({e for e in pal.entries if e[3] == M_ROOF}))
for f in render:
    wc, rc = parse_colour(tag(f, "building:colour")), parse_colour(tag(f, "roof:colour"))
    if pal.entries[f["wall"]][3] == M_GLASS and wc is not None and wc == rc:
        f["roof"] = f["wall"]

# parts under 1 m wide along a bigger one (a dark frame round a glass box, trims, fins): at 1 m they are one
# cell per step of a rotated wall, a dotted staircase that striped the whole facade -- they take the bigger part's wall
THIN_LOG = []
_pl = [f for f in render if f["part"] and f["maxh"]]
_thin, _thk = [], []
for f in _pl:
    rr_, cc_ = f["rr"], f["cc"]
    m_ = np.zeros((rr_.max() - rr_.min() + 3, cc_.max() - cc_.min() + 3), bool)
    m_[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1] = True
    from shapely.affinity import translate as _tr
    _mr = _tr(f["geom"], C0, R0).minimum_rotated_rectangle  # (in the project grid's coordinates, as above)
    _xy = np.array(_mr.exterior.coords)
    _ang = math.degrees(math.atan2(_xy[1, 1] - _xy[0, 1], _xy[1, 0] - _xy[0, 0])) % 90
    rotated = 12 < _ang < 78  # on the grid a 1 m frame or band draws cleanly (a tower's white frame, its bands)
    (_thin if ndimage.distance_transform_edt(m_).max() <= 1.5 and rotated else _thk).append(f)  # (1.41: 2 across on a diagonal)
_bb = np.array([(f["rr"].min(), f["rr"].max(), f["cc"].min(), f["cc"].max()) for f in _thk]) if _thk else np.zeros((0, 4))
n_thin = 0
for f in _thin:
    rr_, cc_ = f["rr"], f["cc"]
    lo_ = f["minh"] or 0
    # parts overlap (a lobby under a tower): every thick part within 2 m spanning the same storeys, the biggest wins
    k_ = np.nonzero((_bb[:, 0] <= rr_.max() + 2) & (_bb[:, 1] >= rr_.min() - 2) & (_bb[:, 2] <= cc_.max() + 2) & (_bb[:, 3] >= cc_.min() - 2))[0]
    best = None
    for k in k_:
        p_ = _thk[k]
        if abs(p_["maxh"] - f["maxh"]) > 6 or abs((p_["minh"] or 0) - lo_) > 6:
            continue
        r0_, c0_ = rr_.min() - 2, cc_.min() - 2
        m_ = np.zeros((rr_.max() - r0_ + 3, cc_.max() - c0_ + 3), bool)
        m_[rr_ - r0_, cc_ - c0_] = True
        m_ = ndimage.binary_dilation(m_, iterations=2)
        q_ = (p_["rr"] >= r0_) & (p_["rr"] < r0_ + m_.shape[0]) & (p_["cc"] >= c0_) & (p_["cc"] < c0_ + m_.shape[1])
        if q_.any() and m_[p_["rr"][q_] - r0_, p_["cc"][q_] - c0_].any() and (best is None or len(p_["rr"]) > len(best["rr"])):
            best = p_
    if best is not None:
        if best["wall"] != f["wall"]:
            THIN_LOG.append((f["id"], int(rr_.mean()), int(cc_.mean()), pal.entries[f["wall"]][:4], pal.entries[best["wall"]][:4], len(rr_)))
        f["wall"] = best["wall"]
        n_thin += 1
note("thin parts given their neighbour's wall:", n_thin, "of", len(_thin))
json.dump(THIN_LOG, open(RDIR / "thin_parts.json", "w"))

note("OSM roof colours overruled by the ortho:", len(ROOF_OVERRULED), ROOF_OVERRULED[:8])
# (room over the tallest of anything in the region -- buildings, the surface model's masts and pylons, crowns up to 40 m,
# the set pieces' lanterns -- so that nothing is cut off, whatever the region holds; the export trims to what is there)
H = int(g.max() + max(topi.max(), nd_max.max(), 41) + 24)
note("volume height", H)
vol = np.zeros((H, D, W), np.uint16)

stage("buildings")
# ---------------------------------------------------------------- natural ground
# open land OSM says nothing about (the default paving, no path, square, car park or building on it) is not pavement
# when the ortho or the terrain says otherwise: the wooded and grassy hillsides under Oberhaus and Mariahilf, gardens
# on the slopes and the river banks had come out as pale paving terraces. Streets and squares are drawn explicitly
# and stay as drawn.
_gy, _gx = np.gradient(ndimage.gaussian_filter(g.astype(np.float32), 1.5))
slope = np.hypot(_gx, _gy)
_water = gcol == C["water"]
_open = (gcol == C["paving"]) & (explicit == 0) & ~ndimage.binary_dilation(bmask, iterations=1)
_d_drawn = ndimage.distance_transform_edt(~((explicit > 0) | bmask))
_ex3, _lum3 = ndimage.median_filter(exg, 3), ndimage.median_filter(lum, 3)
_red_b = ndimage.median_filter(cellcol[..., 0] - cellcol[..., 2], 3)
_hill = ndimage.binary_closing(slope > 0.3, iterations=2)
_bank = (ndimage.distance_transform_edt(~_water) <= 10) & ~_water
_green = _ex3 > 0.03
_crown = nd_mean > 2.5
_brown = (_red_b > 14) & (_lum3 < 150) & ~_green & (_hill | (_d_drawn >= 6))  # (in town brown is a roof's eave or shadow)
_nat = np.full((D, W), C["paving"], np.uint16)
_nat[_bank & ~_hill] = C["shore"]  # a flat bank by the water the ortho sees grey: rip-rap and gravel
_nat[_brown] = C["dirt"]
_nat[_hill & (_d_drawn >= 2) & (_lum3 < 145)] = C["grass2"]  # a slope away from paths, not pale: meadow
_nat[_hill & (_crown | (_lum3 < 75))] = C["garden"]  # under the crowns or in their shade: the forest floor
_nat[_hill & _brown] = C["dirt2"]
_nat[_green & ~_crown] = C["grass"]
_nat[_green & _crown] = C["garden"]
# a mown or harvested field OSM does not map (its farmland stops at the map's edge, or none is drawn): pale and
# straw-yellow in the ortho, far from anything drawn, in a patch of 1000 cells or more (a building lot of bare sand or a
# cemetery is smaller) -- it was a paved square in the middle of the meadows
_straw = _open & ~_green & ~_crown & (_lum3 >= 140) & (_red_b > 18) & (_d_drawn >= 6)
_straw &= np.isin(tn, [0, TN["grassland"], TN["arable"]])  # (not on a cadastre's building plot, park or car park)
_straw = ndimage.binary_opening(_straw, iterations=2)
_straw &= region.windowed_sizes(_straw, 64, 64) >= 1000  # (its patch within 192 m of its block: region.py)
_nat[_straw] = C["stubble"]
# where the cadastre knows the land's use (ALKIS, above), the class is its, the shade the ortho's: forest and copse are
# forest floor under their crowns and meadow in the clearings (they were pale paving, dirt or straw wherever the ortho
# saw the ground between crowns pale or brown); grassland is meadow, pale straw where it is mown; a park lawn, its
# pale paths gravel; waste land bare earth or a meadow where it is green, the bank's stones by the water; a car park
# the car park's asphalt where it isn't green
_wood = np.isin(tn, [TN["forest"], TN["copse"]])
_nat[_wood] = np.where(_crown | (_lum3 < 75), C["garden"], C["grass2"])[_wood]
_k = tn == TN["grassland"]
_nat[_k] = np.where(_green, C["grass"], np.where((_lum3 >= 140) & ~_crown, C["stubble"],
                                                  np.where(_crown, C["garden"], C["grass2"])))[_k]
_k = np.isin(tn, [TN["park"], TN["cemetery"]])
_nat[_k] = np.where(_green, np.where(_crown, C["garden"], C["grass"]), np.where(
    (_lum3 >= 150) & (_d_drawn >= 1), C["gravel"], np.where(_crown | (_lum3 < 90), C["garden"], C["grass2"])))[_k]
_k = tn == TN["waste"]
_nat[_k] = np.where(_green, C["grass2"], np.where(_bank, C["shore"], C["dirt"]))[_k]
_k = tn == TN["parking"]
_nat[_k] = np.where(_green, C["grass"], C["parking"])[_k]
# the waterline: the ortho's cells there mix the river's brown-green with the bank (a lime and orange seam along every
# quay's foot); within 3 m of the water a bank is rip-rap unless plainly green
_edge = (ndimage.distance_transform_edt(~_water) <= 3) & ~_water & (_ex3 < 0.08)
_nat[_edge] = C["shore"]
_nat[~_open] = C["paving"]
# a 3 x 3 majority among the open cells: no single pale cell in a meadow, no single green cell on a courtyard
_NAT = ("paving", "shore", "dirt", "dirt2", "grass", "grass2", "garden", "stubble", "gravel", "parking")
_cls = [C[k] for k in _NAT]
_votes = np.stack([region.boxsum((_nat == k) & _open, 3) for k in _cls])  # (whole votes: a tie goes to the first)
_maj = np.array(_cls, np.uint16)[_votes.argmax(0)]
gcol[_open] = _maj[_open]
note("natural ground on open land (OSM silent):", {k: int(((gcol == C[k]) & _open).sum()) for k in _NAT})
note("  of it by the cadastre's use:", {k: int(((tn == v) & _open).sum()) for k, v in TN.items()})

# ---------------------------------------------------------------- cemeteries
# a cemetery (landuse=cemetery, amenity=grave_yard) OSM gives no surface was the default pale paving: a car park
# among the trees. As the ortho shows them: lawn, gravel walks every ~25 m along the plot's long axis and across it,
# and between them rows of graves -- a headstone (one grey or dark voxel) and its planted bed in front, rows 3 m
# apart. The paths OSM maps and the chapels stay as drawn; the stones are set after the trees (grave_stones)
CEM_STONES = [pal(c) for c in ("#9a9790", "#a8a59d", "#b8b3a8", "#c4c0b6", "#8d8b86", "#6c6d6f", "#55575a")]  # granite, limestone, a few dark
grave_stones = []  # (row, col, palette id)
n_cem = 0
for oid, typ, t, geom in osm.areas:
    if not (t.get("landuse") == "cemetery" or t.get("amenity") == "grave_yard") or underground(t):
        continue
    rr_, cc_ = cells_of(geom)
    if not len(rr_):
        continue
    k_ = ~bmask[rr_, cc_] & (explicit[rr_, cc_] == 0) & np.isin(gcol[rr_, cc_], [C[k] for k in (
        "paving", "paving2", "grass", "grass2", "garden", "shore", "dirt", "dirt2", "stubble")])
    rr_, cc_ = rr_[k_], cc_[k_]
    gcol[rr_, cc_] = C["grass2"]
    if geom.area < 400:
        continue
    # the plot's axes: its minimum rotated rectangle's long side
    # (in the project grid's coordinates: the same rectangle, and the same corner first, in every region)
    from shapely.affinity import translate as _tr
    _mr = [(x_ - C0, y_ - R0) for x_, y_ in _tr(geom, C0, R0).minimum_rotated_rectangle.exterior.coords]
    _e = max(((_mr[i], _mr[i + 1]) for i in range(4)), key=lambda e: math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))
    th = math.atan2(_e[1][1] - _e[0][1], _e[1][0] - _e[0][0])
    _q = round(th / (math.pi / 2)) * (math.pi / 2)
    if abs(th - _q) < math.radians(12):  # nearly square to the grid: rows on the grid (a diagonal of 1 m dots wobbles)
        th = _q
    ox, oy = _e[0]
    x_, y_ = cc_ + 0.5 - ox, rr_ + 0.5 - oy
    u_ = x_ * math.cos(th) + y_ * math.sin(th)
    v_ = -x_ * math.sin(th) + y_ * math.cos(th)
    v_ = np.abs(v_)
    inner = geom.buffer(-2.5)
    m_in = np.zeros((D, W), bool)
    if not inner.is_empty:
        _ri, _ci = cells_of(inner)
        m_in[_ri, _ci] = True
    walk = (np.mod(v_, 26) < 2) | (np.mod(u_ + 12, 30) < 2)  # gravel walks, 2 m wide
    gcol[rr_[walk], cc_[walk]] = C["gravel"]
    vm = np.floor(np.mod(v_ - 2, 26)).astype(int)  # 0..23 inside a block of rows
    um = np.floor(np.mod(u_ + 10, 30)).astype(int)  # 0..27 along it
    blk = ~walk & m_in[rr_, cc_] & (vm >= 1) & (vm <= 22) & (um >= 1) & (um <= 26)
    row = vm % 3
    # wide plain lawns in the ortho (the war graves' fields, a cemetery's meadow) keep rows; crowned cells keep them
    # too (graves under the trees)
    stone = blk & (row == 1) & (um % 2 == 0)
    bed = blk & (row == 2) & (um % 2 == 0)
    # between the graves gravel where the ortho sees the plot pale (the old town's churchyards: raked gravel between
    # dense rows), lawn where it is green
    aisle = blk & ~stone & ~bed & (_lum3[rr_, cc_] > 135) & (_ex3[rr_, cc_] < 0.03)
    gcol[rr_[aisle], cc_[aisle]] = C["gravel"]
    gcol[rr_[bed], cc_[bed]] = C["garden"]
    for r, c in zip(rr_[stone], cc_[stone]):
        grave_stones.append((int(r), int(c), CEM_STONES[cell_hash(r, c, "grave") % len(CEM_STONES)]))
    n_cem += 1
note("cemeteries laid out:", n_cem, "grave stones:", len(grave_stones))

# ground column
for zz in range(H):
    m = zz < g - 1
    if not m.any():
        break
    vol[zz][m] = C["soil"]
rr, cc = np.nonzero(np.ones((D, W), bool))
vol[g[rr, cc] - 1, rr, cc] = gcol[rr, cc]
# a paved cell 2 m or more above a neighbour stands on a retaining wall (a quay, a terrace on the hillside, a ramp's
# side): its exposed face masonry, not the brown soil of a garden's bank -- rough stone blocks of a few greys
# (Passau's quays and terrace walls are granite and limestone; a flat pale concrete made them giant blank slabs).
# On natural ground too where OSM maps a wall (barrier=retaining_wall/wall/city_wall)
_nb_lo = ndimage.minimum_filter(g, footprint=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
_mat = np.array([e[3] for e in pal.entries] + [0] * 256)
_natural_top = np.isin(_mat[gcol], [M_GRASS, M_LEAF, M_SOIL, M_WATER]) | np.isin(gcol, [C["dirt"], C["dirt2"], C["stubble"], C["stubble2"]])
_osm_wall = np.zeros((D, W), np.uint8)
burn(_osm_wall, [(l_.buffer(1.5), 1) for _, t_, l_ in osm.lines
                 if t_.get("barrier") in ("retaining_wall", "wall", "city_wall") or t_.get("man_made") in ("quay", "embankment")])
# a water override's outline is a wall too (a lock chamber's), faced in its own colour (default concrete) within 2 m
_lockwall = np.zeros((D, W), np.uint16)
if _locks:
    burn(_osm_wall, [(geom_.boundary.buffer(1.5), 1) for *_, geom_ in _locks])
    burn(_lockwall, [(geom_.boundary.buffer(2), pal(sty_[0], landmarks.MAT_IDS[sty_[1]])) for *_, sty_, geom_ in _locks])
_wall = (g - _nb_lo >= 2) & (~_natural_top | (_osm_wall > 0))
n_rw = n_lw = 0
_rr0, _cc0 = np.mgrid[R0:R0 + D, C0:C0 + W]  # (the project grid's: the same stones in every region)
for zz in range(int(_nb_lo[_wall].min()) if _wall.any() else 0, int(g.max())):
    m = _wall & (zz >= _nb_lo) & (zz < g - 1)
    if not m.any():
        continue
    # blocks 2 m long, courses offset course by course
    k = ((_rr0[m] + _cc0[m] + (zz % 2)) // 2 * 2654435761 + zz * 40503) % 1000003 % len(STONE)
    vol[zz][m] = np.array(STONE, np.uint16)[k]
    n_rw += int(m.sum())
    if _locks:
        _lw = _lockwall[m]
        vol[zz][m] = np.where(_lw > 0, _lw, vol[zz][m])
        n_lw += int((_lw > 0).sum())
note("retaining walls (paved ground 2 m+ over a neighbour): masonry voxels", n_rw)
if _locks:
    note("water overrides: wall face voxels", n_lw)
    overrides.lock_gates(vol, g, gcol == C["water"], osm.lines, pal, landmarks.MAT_IDS, cells_of, BASE, note)

# buildings: base fill with the tallest covering feature's wall, then parts paint their own [minh, maxh)
basewall = np.zeros((D, W), np.uint16)
roofcol_fix = np.zeros((D, W), np.uint16)
for f in sorted(render, key=lambda f: f["maxh"] or float(np.median(top[f["rr"], f["cc"]]))):
    basewall[f["rr"], f["cc"]] = f["wall"]
# an outline's cell outside all its parts, where the LiDAR stands as tall as a part within 4 m, is that part mapped a
# little small (a tower's beige concrete came out in the outline's brown glass): the part's wall
_parts = sorted([f for f in render if f["part"] and f["maxh"]], key=lambda f: f["maxh"])
_pid = np.zeros((D, W), np.int32)
for i_, f in enumerate(_parts, 1):
    _pid[f["rr"], f["cc"]] = i_
n_pw = 0
for f in render:
    if f["part"] or not f.get("has_parts"):
        continue
    if f["tags"].get("building:colour"):
        continue  # the outline has its own facade colour (a glass upper storey round a white part): it stays
    rr_, cc_ = f["rr"], f["cc"]
    r0_, c0_ = max(rr_.min() - 5, 0), max(cc_.min() - 5, 0)
    sub_ = _pid[r0_:rr_.max() + 6, c0_:cc_.max() + 6]
    if not (sub_ > 0).any():
        continue
    d_, (ir_, ic_) = ndimage.distance_transform_edt(sub_ == 0, return_indices=True)
    k_ = _pid[rr_, cc_] == 0
    for r_, c_ in zip(rr_[k_], cc_[k_]):
        i_, j_ = r_ - r0_, c_ - c0_
        if d_[i_, j_] > 4:
            continue
        p_ = _parts[sub_[ir_[i_, j_], ic_[i_, j_]] - 1]
        # a rim up to 2 m wide round a part (one outline cell per step of its rotated walls, striping its
        # glass in the outline's dark grey) as soon as it stands 70 % of the part's height; up to 4 m when as tall
        ok_ = (d_[i_, j_] <= 2 and topi[r_, c_] >= 0.7 * p_["maxh"]) or abs(p_["maxh"] - topi[r_, c_]) <= 6
        if ok_ and p_["wall"] != basewall[r_, c_]:
            basewall[r_, c_] = p_["wall"]
            n_pw += 1
note("outline cells given their adjacent part's wall:", n_pw)
# LiDAR tower taller than the OSM part covering the cell (footprints misregistered):
# take the facade from the nearest OSM part that is tall enough to explain the height
tall_id = np.zeros((D, W), np.int32)
tall_feats = sorted([f for f in render if (f["maxh"] or 0) >= 30], key=lambda f: f["maxh"])
for i, f in enumerate(tall_feats, 1):
    tall_id[f["rr"], f["cc"]] = i
need = bmask & np.isfinite(cell_maxh) & (topi > np.nan_to_num(cell_maxh) + 10) & (topi >= 30)
if need.any() and tall_feats:
    dist, (ir, ic) = ndimage.distance_transform_edt(tall_id == 0, return_indices=True)
    rr_, cc_ = np.nonzero(need)
    fid = tall_id[ir[rr_, cc_], ic[rr_, cc_]]
    ok = (dist[rr_, cc_] < 15) & (fid > 0)
    n_fix = 0
    for r_, c_, k_ in zip(rr_[ok], cc_[ok], fid[ok]):
        f = tall_feats[k_ - 1]
        if f["maxh"] >= topi[r_, c_] - 12:
            basewall[r_, c_] = f["wall"]
            roofcol_fix[r_, c_] = f["roof"]
            n_fix += 1
    note("tower cells recoloured from nearest tall OSM part:", n_fix)
# a roof on its own (building=roof, carport, canopy: the station's platform roofs, a petrol station's) is a sheet on
# posts, not a block: drawn from 2.5 m to the surface model's top it stood as a 3 m box of facade with windows over
# the platforms. One voxel of roof where nothing is under it, and posts along its middle (drawn below)
ROOF_ONLY = {"roof", "carport", "canopy"}
roof_only = [f for f in render if f["tags"].get("building") in ROOF_ONLY or f["tags"].get("building:part") == "roof"]
for f in roof_only:
    k = (boti[f["rr"], f["cc"]] >= 2) & (topi[f["rr"], f["cc"]] >= 3)
    rr_, cc_ = f["rr"][k], f["cc"][k]
    boti[rr_, cc_] = np.maximum(boti[rr_, cc_], topi[rr_, cc_] - 1)
zb = g + boti
zt = g + topi
for zz in range(int(g.min()), H):
    m = bmask & (zz >= zb) & (zz < zt)
    if not m.any():
        continue
    vol[zz][m] = basewall[m]
_ro_ids = {id(f) for f in roof_only}
for f in sorted([f for f in render if f["part"] and f["maxh"] and id(f) not in _ro_ids], key=lambda f: -f["maxh"]):
    rr_, cc_ = f["rr"], f["cc"]
    k = bmask[rr_, cc_]
    rr_, cc_ = rr_[k], cc_[k]
    lo = g[rr_, cc_] + int(round(f["minh"]))
    hi = np.minimum(g[rr_, cc_] + int(round(f["maxh"])), zt[rr_, cc_])
    for zz in range(int(lo.min()) if len(lo) else 0, int(hi.max()) if len(hi) else 0):
        m = (zz >= lo) & (zz < hi)
        vol[zz, rr_[m], cc_[m]] = f["wall"]
n_post = 0
for f in roof_only:  # posts every 8 m along the roof's middle line (its cells farthest from the edge)
    rr_, cc_ = f["rr"], f["cc"]
    k = boti[rr_, cc_] >= 2
    if k.sum() < 12:
        continue
    rr_, cc_ = rr_[k], cc_[k]
    r0_, c0_ = rr_.min() - 1, cc_.min() - 1
    m_ = np.zeros((rr_.max() - r0_ + 2, cc_.max() - c0_ + 2), bool)
    m_[rr_ - r0_, cc_ - c0_] = True
    dt_ = ndimage.distance_transform_edt(m_)
    mid = m_ & (dt_ >= ndimage.maximum_filter(dt_, 3) - 0.01) & (dt_ >= min(2, dt_.max()))
    pr, pc = np.nonzero(mid)
    if not len(pr):
        continue
    pts = np.c_[pc, pr].astype(float)
    _, _, vt_ = np.linalg.svd(pts - pts.mean(0), full_matrices=False)
    t_ = (pts - pts.mean(0)) @ vt_[0]
    last = -1e9
    for j in np.argsort(t_):
        if t_[j] - last < 8 and t_[j] < t_.max() - 0.5:
            continue
        if t_[j] - last < 3:
            continue
        last = t_[j]
        r, c = pr[j] + r0_, pc[j] + c0_
        top_ = int(zb[r, c])
        col_ = vol[int(g[r, c]):top_, r, c]
        col_[col_ == 0] = C["pole"]
        n_post += 1
note("roofs on their own drawn as sheets on posts:", len(roof_only), "roofs,", n_post, "posts")
# roofs: topmost voxel of every building column (+ terraces: voxels with empty above)
roofcol = np.zeros((D, W), np.uint16)
for f in sorted(render, key=lambda f: f["maxh"] or 0):
    roofcol[f["rr"], f["cc"]] = f["roof"]
roofcol = np.where(roofcol_fix > 0, roofcol_fix, roofcol)
# (patina copper is green in the ortho too, but as blue as it is green: churches' and palaces' roofs had grown
# lime gardens; planted roofs are yellow-green, blue under 0.85 of green -- a roof garden 0.70, patina 0.98-0.99)
green_roof = bmask & (exg > 0.08) & (topi < 40) & ~over & (cellcol[..., 2] < 0.85 * cellcol[..., 1])
# a green roof is an area, not a rim: the ortho's green along parapets (crowns hanging over the edge, copper, moss)
# put lime garden voxels on cornices and ledges all over the city. Opened by 1 cell, patches of 12+ cells, and not
# where the LiDAR stands 2 m above the roof (a crown over it)
green_roof &= nd_max < topi + 2
green_roof = ndimage.binary_opening(green_roof, iterations=1)
_gl, _gn = ndimage.label(green_roof)
if _gn:
    green_roof &= np.r_[False, ndimage.sum(green_roof, _gl, range(1, _gn + 1)) >= 12][_gl]
# a small step in a facade (a 1-3 m setback, a stair of a sloping wing, an edge left lower by the LiDAR) is wall, not
# roof: the building's roof colour (taken from the ortho over its whole top) put cream blobs and checkerboards on glass
# towers. Patches under 25 cells more than 6 m below the highest top within 3 m.
_ledge = bmask & ~pitched_m & (topi < ndimage.maximum_filter(np.where(bmask, topi, 0), 7) - 6)  # (not a steep roof's eaves)
_lab, _n = ndimage.label(_ledge)
if _n:
    _sz = ndimage.sum(_ledge, _lab, range(1, _n + 1))
    _ledge &= np.r_[False, _sz < 25][_lab]
roofcol = np.where(_ledge & ~green_roof, basewall, roofcol)
note("facade steps topped with wall colour:", int(_ledge.sum()))
rr, cc = np.nonzero(bmask)
vol[zt[rr, cc] - 1, rr, cc] = np.where(green_roof[rr, cc], C["garden"], roofcol[rr, cc])
# a steep tiled roof steps 2-3 m from cell to cell: under its top voxel each step's side showed the wall's plaster, so
# from the street the old town's roofs read as more storeys of facade. In the historic core, the side of a step down
# to a lower cell of the same roof takes the roof's tiles or copper -- a dome's flanks step 3-4 m (a tower's side or a
# setback of 5 m or more stays wall). Outside it too on every pitched roof taken from LoD2
core_m = np.zeros((D, W), bool)
core_m[cells_of(CORE)] = True
mats_of_ids = np.array([e[3] for e in pal.entries] + [0] * 256)
n_rs = 0
for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
    nb_t = region.shift2(zt, (dr, dc)); nb_b = region.shift2(bmask, (dr, dc))
    step = bmask & nb_b & (core_m | pitched_m) & ~green_roof & (zt - nb_t >= 2) & (zt - nb_t <= 4)
    for k in (2, 3, 4):
        m = step & (zt - nb_t >= k)
        rr_, cc_ = np.nonzero(m)
        z_ = zt[rr_, cc_] - k
        keep = mats_of_ids[vol[z_, rr_, cc_]] != M_ROOF
        vol[z_[keep], rr_[keep], cc_[keep]] = roofcol[rr_[keep], cc_[keep]]
        n_rs += int(keep.sum())
note("roof step sides in roof material (historic core, pitched roofs):", n_rs)
note("green roof cells:", int(green_roof.sum()))
# rooftop plant rooms, lift housings and stair heads (1.5-5 m over a building's main roof, under 80 cells) are roof
# material, not facade: they wore the facade's office windows and read as little houses on every roof
n_rb = 0
for f in render:
    rr_, cc_ = f["rr"], f["cc"]
    if len(rr_) < 100 or f["part"]:
        continue
    t_ = topi[rr_, cc_]
    med_ = int(np.median(t_))
    if med_ < 6:
        continue
    up_ = (t_ > med_ + 1.5) & (t_ <= med_ + 5)  # a plant room, lift housing or stair head: one storey
    if not up_.any():
        continue
    m_ = np.zeros((rr_.max() - rr_.min() + 1, cc_.max() - cc_.min() + 1), bool)
    m_[rr_[up_] - rr_.min(), cc_[up_] - cc_.min()] = True
    lab_, nl_ = ndimage.label(m_)
    small_ = np.r_[False, ndimage.sum(m_, lab_, range(1, nl_ + 1)) < 80]
    # set back from the facade (none of it within 2 m of the outline's edge): a top storey flush with the facade
    # (a crown storey) is building, not plant room
    fp_ = np.zeros(m_.shape, bool)
    fp_[rr_ - rr_.min(), cc_ - cc_.min()] = True
    near_edge_ = ndimage.distance_transform_edt(np.pad(fp_, 1))[1:-1, 1:-1] <= 2
    flush_ = np.r_[False, ndimage.maximum(near_edge_ & m_, lab_, range(1, nl_ + 1)) > 0] if nl_ else np.zeros(1, bool)
    small_ &= ~flush_
    k_ = up_ & small_[lab_[rr_ - rr_.min(), cc_ - cc_.min()]]
    for r_, c_ in zip(rr_[k_], cc_[k_]):
        z0_, z1_ = int(g[r_, c_]) + med_, int(zt[r_, c_]) - 1
        col_ = vol[z0_:z1_, r_, c_]
        col_[col_ != 0] = roofcol[r_, c_]
        n_rb += 1
note("rooftop structures in roof material:", n_rb)

stage("natural ground, cemeteries")
# ---------------------------------------------------------------- vegetation (LiDAR canopy + OSM trees)
trees = [(oid, t, p) for oid, t, p in osm.nodes if t.get("natural") == "tree"]
# every known tree (scripts/trees.py: OSM's tree nodes and the Bavarian single-tree register of the 2024 flight)
import trees as treedb
all_trees = treedb.load(trees, buildings=bmask)
note("known trees: OSM natural=tree", sum(t["src"] == "osm" for t in all_trees), "+ Einzelbäume register",
     sum(t["src"] == "bv" for t in all_trees))
# the LiDAR point clouds (scripts/laser.py; Feb 2021, leaf-off): the canopy's measured height, the crowns' undersides,
# conifers by their winter density. Optional: without data/laser.npz the trees come from the surface model alone
LZ = None
if Path("data/laser.npz").exists() and not os.environ.get("NO_LASER"):
    LZ = region.load_npz("data/laser.npz")
else:
    note("no data/laser.npz (scripts/laser.py): trees from the surface model only")
# the forests' dominant species from remote sensing (scripts/species_map.py: DLR Tree Species Germany 2022, 2016 where
# 2022 has lost the canopy; 10 m). Optional: without data/raw/treespecies_*.tif (or with NO_SPECIES_MAP) the trees'
# kinds come from OSM and the laser alone
import species_map
SPM = None if os.environ.get("NO_SPECIES_MAP") else species_map.grid()
if SPM is None:
    note("no tree species map (data/raw/treespecies_*.tif): conifers by OSM and the laser only")
# the OSM trees widen the ortho's green test and pardon wall edges (as before); the register's points do not
tree_rc = np.array([(int(t["y"]), int(t["x"])) for t in all_trees if t["src"] == "osm"])
near_tree = np.zeros((D, W), bool)
if len(tree_rc):
    near_tree[tree_rc[:, 0], tree_rc[:, 1]] = True
    near_tree = ndimage.binary_dilation(near_tree, iterations=3)
veg = (~bmask) & (nd_mean > 2.2) & ((exg > 0.025) | (near_tree & (exg > -0.03)))
# nor inside any building's outline: one drawn only through its parts (a church) left the cells between its
# parts out of bmask, and its green copper roof grew 1 800 leaf voxels, pillars up its front
_allb = np.zeros((D, W), bool)
for f in feats:
    if not f["part"] and f["tags"].get("building") not in ("roof", "carport", "canopy"):
        _allb[f["rr"], f["cc"]] = True
note("vegetation cells inside building outlines dropped:", int((veg & _allb).sum()))
veg &= ~_allb
# LiDAR wall edges outside OSM footprints look like tall "trees": reject cells next to a building
# whose height is close to that building's roof
btop_near = ndimage.maximum_filter(np.where(bmask, topi, 0), size=7)
wall_edge = (btop_near > 0) & (nd_mean > 0.6 * btop_near) & (nd_mean > 6)
veg &= ~wall_edge | (near_tree & (nd_mean < 25))
step = ndimage.maximum_filter(nd_mean, 3) - ndimage.minimum_filter(nd_mean, 3)
veg &= ~((btop_near > 0) & (step > 7) & (nd_mean > 0.5 * btop_near))
veg &= nd_mean < 32  # no trees taller than ~30 m in town
# no trees growing out of a stadium shell (its fins and roof edge are LiDAR-high and greenish in the ortho)
stad = np.zeros((D, W), np.uint16)
burn(stad, [(geom, 1) for oid, typ, t, geom in osm.areas_with("leisure", ("stadium",))])
veg &= ~((stad > 0) & ~near_tree)
veg = ndimage.binary_opening(veg, iterations=1)
note("wall-edge cells rejected as vegetation:", int(wall_edge.sum()))
lab, n = ndimage.label(veg)
sizes = ndimage.sum(veg, lab, range(1, n + 1))
veg &= np.isin(lab, np.nonzero(sizes >= 4)[0] + 1)
# image-matched surface (DOM20) leaves pinholes and frayed rims in crowns: close them, fill holes up to 30 m2
_vc = ndimage.binary_closing(veg, iterations=1) & ~bmask & (nd_mean > 1.5)
_holes = ndimage.binary_fill_holes(_vc) & ~_vc
_hl, _hn = ndimage.label(_holes)
if _hn:
    _hs = ndimage.sum(_holes, _hl, range(1, _hn + 1))
    _vc |= np.isin(_hl, np.nonzero(_hs <= 30)[0] + 1) & ~bmask & ~(gcol == C["water"])
note("canopy cells added by closing / hole filling:", int((_vc & ~veg).sum()))
veg = _vc
veg_laser = np.zeros((D, W), bool)  # canopy cells whose height the laser measured
if LZ is not None:
    # the image-matched surface smears crowns into the gaps between them and over the lawn at their rims (a third of
    # its canopy cells are off by more than 2 m). Where the laser saw the ground there, well sampled and with no
    # vegetation over 2 m, beside canopy it did see (3 m or less), the cell is open: the rim and the gaps go. A crown
    # the laser did not see at all (planted or grown since 2021) stays, and so does the rim of any tree of the 2024
    # register (within 2 m of its point): the surface model has the last word on whether a tree stands
    _lcan = LZ["veg_top"] >= 30
    _bvpt = np.zeros((D, W), bool)
    for t in all_trees:
        if t["src"] != "osm" or t.get("bv_height"):
            _bvpt[int(t["y"]), int(t["x"])] = True
    _open = (LZ["n_pulse"] >= 6) & (LZ["veg_top"] < 20) & (LZ["n_ground"] >= 3)
    _trim = veg & _open & (ndimage.distance_transform_edt(~_lcan) <= 3) & (ndimage.distance_transform_edt(~_bvpt) > 2)
    veg &= ~_trim
    lab, n = ndimage.label(veg)
    sizes = ndimage.sum(veg, lab, range(1, n + 1))
    veg &= np.isin(lab, np.nonzero(sizes >= 4)[0] + 1)
    note("canopy cells the laser saw open (rims, gaps between crowns) dropped:", int(_trim.sum()))
    # the canopy's height: the laser's highest vegetation return (leaf-off twigs, within a few dm of the summer top),
    # grown by what the 2024 surface adds, up to 1.5 m in three years; where the surface model is far lower (under
    # 60 %) the tree was cut back or felled since, and the surface model's height stands
    _lt = LZ["veg_top"].astype(np.float32) / 10
    _lt = np.where(_lt >= 2, _lt, ndimage.median_filter(_lt, 3))
    _use = veg & (_lt >= 2) & (nd_mean >= 0.6 * _lt)
    _nv = _lt + np.clip(nd_mean - _lt, 0, 1.5)
    note("canopy heights from the laser:", int(_use.sum()), "of", int(veg.sum()), "cells; surface model minus laser, median",
         round(float(np.median((nd_mean - _lt)[_use])), 2) if _use.any() else None, "m, |diff| > 2 m:",
         round(float((np.abs(nd_mean - _lt)[_use] > 2).mean()), 3) if _use.any() else None)
    nd_mean = np.where(_use, _nv, nd_mean)
    veg_laser = _use
nd_mean = np.where(veg & (nd_mean < 2.2), np.maximum(nd_mean, ndimage.median_filter(np.where(veg, nd_mean, 0), 5)), nd_mean)
hs = ndimage.gaussian_filter(np.where(veg, nd_mean, 0), 2) / np.maximum(ndimage.gaussian_filter(veg.astype(float), 2), 1e-3)
crown_top = np.round(np.minimum(nd_mean, 40)).astype(np.int32)
# against a wall the DSM is the wall's (1 m green pillars 20-30 m up the facades): within 2 m
# of a building a crown is no taller than its canopy away from the walls (gaussian mean x 1.25 + 2 m), 12 m with none
_nearb = ndimage.binary_dilation(bmask, iterations=2) & veg
_far = veg & ~ndimage.binary_dilation(bmask, iterations=2)
_wf = ndimage.gaussian_filter(_far.astype(np.float32), 3)
_hf = ndimage.gaussian_filter(np.where(_far, nd_mean, 0).astype(np.float32), 3) / np.maximum(_wf, 1e-3)
_cap = np.where(_wf > 0.05, _hf * 1.25 + 2, 12)
_clip = _nearb & (crown_top > _cap)
crown_top = np.where(_clip, np.round(_cap), crown_top).astype(np.int32)
note("crowns against walls clipped to their canopy:", int(_clip.sum()))
crown_bot = np.clip(np.round(hs * 0.38), 2, None).astype(np.int32)
crown_bot = np.minimum(crown_bot, crown_top - 1)
# leaf colour from ortho: luminance x hue bins
hue = np.zeros((D, W), np.float32)
r_, g_, b_ = cellcol[..., 0], cellcol[..., 1], cellcol[..., 2]
yellowish = (r_ - b_) / rgbsum > 0.05
lbin = np.clip(((lum - 40) / 110 * 5).astype(int), 0, 4)
leafidx = np.array(LEAVES, np.uint16)[(4 - lbin) + 5 * (~yellowish)]

# trunks: every known tree standing under a LiDAR crown gets one, from the ground up into its crown (the crown's leaf
# columns start at crown_bot, so the trunk's top voxel touches them face to face: the crown stands, it does not float);
# a known tree with no crown in the surface model (planted since) is drawn procedurally. Crowns that no database tree
# stands under get trunks at their tops (local maxima of the canopy height, >= 5 m apart).
n_new = n_trunk = 0
canopy_near = ndimage.binary_dilation(veg, iterations=2)
_vd, (_vr, _vc) = ndimage.distance_transform_edt(~veg, return_indices=True)
trunk_at = np.zeros((D, W), bool)
# where a trunk may stand: never on a carriageway, rails, tram bed or in the water; a trunk placed only from the canopy
# (no tree known there) also not on paths and squares -- it would stand in the walkers' way -- but on soft ground
_hard = np.isin(gcol, [C[k] for k in ("water", "asphalt", "asphalt_l", "rail", "trambed", "ballast", "cycle", "parking")]) | is_road
trunk_ok_db = ~_hard
trunk_ok_peak = np.isin(gcol, [C[k] for k in ("grass", "grass2", "garden", "scrub", "dirt", "dirt2", "fresh", "bare", "soil",
                                               "flower", "flower2", "gravel")]) & ~is_road
_okd, (_okr, _okc) = ndimage.distance_transform_edt(~(trunk_ok_peak & veg), return_indices=True)
_dbd, (_dbr, _dbc) = ndimage.distance_transform_edt(~(trunk_ok_db & veg), return_indices=True)


trunks = []  # (row, col, thick): drawn once the crowns are shaped around them


trunk_conifer = []  # per trunk: a conifer by the database's species (or OSM leaf_type)
trunk_rec = []  # per trunk: its record in the tree register (trees.json), None for the canopy tops' (added below)
trunk_broad = []  # per trunk: known to be broadleaved (species, leaf_type): never a conifer by the laser


def put_trunk(r, c, thick=False, conifer=False, rec=None):
    trunks.append((r, c, thick))
    trunk_conifer.append(conifer)
    trunk_rec.append(rec)
    trunk_broad.append(rec is not None and treedb.is_broadleaf(rec))
    trunk_at[r, c] = True


for t in all_trees:
    c, r = int(t["x"]), int(t["y"])
    if not (2 <= c < W - 2 and 2 <= r < D - 2) or bmask[r, c]:
        t["drawn"] = "none"
        continue
    if canopy_near[r, c]:
        if not veg[r, c] and _vd[r, c] <= 2.5:  # the point just off its crown's LiDAR cells: under the nearest one
            r, c = int(_vr[r, c]), int(_vc[r, c])
        if veg[r, c] and not trunk_ok_db[r, c]:  # mapped onto the road edge: to the kerb side (more than 3 m into
            if _dbd[r, c] > 3:                     # the carriageway: not drawn, the cars drive there --
                t["drawn"] = "none"                # docs/plans/road-clearance.md)
                continue
            r, c = int(_dbr[r, c]), int(_dbc[r, c])
        if veg[r, c] and trunk_at[max(0, r - 1):r + 2, max(0, c - 1):c + 2].any():  # a trunk beside it already
            t["drawn"] = "none"
            continue
        if veg[r, c]:
            # a big tree (circumference 2.5 m and up, or 24 m tall in the register) on a trunk of 2 x 2
            put_trunk(r, c, thick=(t.get("trunk_cm") or 0) >= 250 or (t.get("bv_height") or 0) >= 24,
                      conifer=treedb.is_conifer(t), rec=t)
            t["drawn"] = "lidar"
            # where the trunk stands (moved under its crown or to the kerb): phenology.py finds each crown's tree by
            # its nearest trunk, so a broadleaf crown beside a conifer must not take the conifer's evergreen class
            t["x"], t["y"] = float(c) + 0.5, float(r) + 0.5
            t["z"] = int(g[r, c])
            t["h"] = int(crown_top[r, c])
            n_trunk += 1
            continue
        t["drawn"] = "none"  # under another tree's crown edge: its own crown is not resolved
        continue
    if t["src"] == "bv":  # the register's crowns are in the surface model: none there now, none drawn
        t["drawn"] = "none"
        continue
    if is_road[r, c]:  # (a tree planted since, mapped on the carriageway: none -- the cars drive there)
        t["drawn"] = "none"
        continue
    n_new += 1
    landmarks.small_tree(vol, g, r, c, stable_hash(t["id"]), LEAVES, C["trunk"], height=t.get("height"))
    t["drawn"] = "procedural"
    t["z"] = int(g[r, c])
note("trunks under LiDAR crowns at known trees:", n_trunk)
note("known trees without a crown in the surface model -> procedural:", n_new)
# crowns no database tree stands under: a trunk at each canopy top >= 5 m from any trunk
peak = veg & (nd_mean >= ndimage.maximum_filter(np.where(veg, nd_mean, 0), size=7)) & (nd_mean >= 4)
_td = ndimage.distance_transform_edt(~trunk_at)
pr_, pc_ = np.nonzero(peak & (_td >= 5))
order = np.argsort(-nd_mean[pr_, pc_], kind="stable")  # (equal heights: row by row, as in every region)
taken = np.zeros((D, W), bool)
n_peak = 0
for k in order:
    r, c = int(pr_[k]), int(pc_[k])
    if taken[max(0, r - 4):r + 5, max(0, c - 4):c + 5].any():
        continue
    if not trunk_ok_peak[r, c]:  # the crown's top over a path or a road: the trunk on the nearest soft ground under it,
        if _okd[r, c] <= 4:      # else on the pavement (a street tree), never on the carriageway
            r, c = int(_okr[r, c]), int(_okc[r, c])
        elif not trunk_ok_db[r, c]:
            if _dbd[r, c] > 3:
                continue
            r, c = int(_dbr[r, c]), int(_dbc[r, c])
    put_trunk(r, c, rec=dict(id=f"lidar:{r + R0}_{c + C0}", src="lidar", x=float(c) + 0.5, y=float(r) + 0.5, drawn="lidar",
                             z=int(g[r, c]), peak=float(nd_mean[int(pr_[k]), int(pc_[k])])))
    taken[r, c] = True
    n_peak += 1
note("trunks at canopy tops with no known tree under them:", n_peak)
# crowns, one per trunk: every canopy cell belongs to its nearest trunk (Voronoi). The LiDAR gives only a noisy top
# surface, so each crown is drawn as one rounded solid standing on its trunk, the way a voxel diorama draws a tree:
#  - its radial coordinate u runs from 0 at the trunk to 1 at the edge of its own cell -- the canopy's rim or the
#    line where it meets its neighbour's crown (distance to the trunk / (that + distance to the cell's edge)), so a
#    crown tapers towards each neighbour too and packed crowns read as separate domes with a notch between them,
#    not as one Voronoi column each with straight sides and a flat top;
#  - a broadleaf crown is a squashed superellipsoid over u (its depth from its footprint's radius: no tall narrow
#    green pillars), a conifer a cone; height, depth and fullness vary a little per tree;
#  - a metre or so of smooth noise on its top and underside, so the leaf surface is lumpy rather than turned;
#  - one base leaf tone per tree (its mean ortho colour), lighter clumps on top and darker ones underneath, instead of
#    each column taking its own ortho pixel (stripes).
if trunks:
    nT = len(trunks)
    tidx = np.zeros((D, W), np.int32)
    for i_, (r_, c_, _) in enumerate(trunks, 1):
        tidx[r_, c_] = i_
    _dt, (_tr_, _tc_) = ndimage.distance_transform_edt(tidx == 0, return_indices=True)
    # (a canopy cell further than region.CROWN_R from every trunk -- low scrub, no peak in it -- is no crown's: drawn
    # as the canopy's own column below)
    own = np.where(veg & (_dt <= region.CROWN_R), tidx[_tr_, _tc_], 0)
    note("canopy cells further than", region.CROWN_R, "m from every trunk (no crown's):", int((veg & (_dt > region.CROWN_R)).sum()))
    idx_ = np.arange(1, nT + 1)
    # the distance to the edge of the own cell: to the nearest cell with another owner or no canopy
    _same = own > 0
    for _ax, _sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
        _same &= region.shift(own, _sh, _ax) == own
    _db = ndimage.distance_transform_edt(_same)
    # a crown is one solid per tree, not a column per cell: its height is the crown's robust top (the 5x5 median of the
    # noisy image-matched surface, then the crown's 90th percentile), measured from the ground at its trunk -- on a slope
    # the crown sits on its trunk instead of hanging down the hill as a curtain
    _sm = ndimage.median_filter(np.where(veg, crown_top, 0), 5)
    vr_, vc_ = np.nonzero(veg)
    k_ = own[vr_, vc_] - 1
    ok_ = k_ >= 0
    kk = np.maximum(k_, 0)
    _hv = np.maximum(_sm[vr_, vc_], 3).astype(np.float32)
    _kx = np.where(ok_, k_, nT)  # (a cell no crown owns counts for none: after them all)
    _ord = np.lexsort((_hv, _kx))
    _cnt = np.bincount(_kx, minlength=nT + 1)[:nT]
    _start = np.concatenate([[0], np.cumsum(_cnt)[:-1]])
    Ht = np.where(_cnt > 0, _hv[_ord][np.clip(_start + (0.9 * np.maximum(_cnt - 1, 0)).astype(int), 0, len(_hv) - 1)], 3)
    Ht = Ht.astype(np.float32)
    Re = np.sqrt(np.maximum(_cnt, 1) / np.pi).astype(np.float32)  # the radius of a disc of the crown's footprint
    G0 = np.array([g[r_, c_] for r_, c_, _ in trunks], np.float32)
    con = np.array(trunk_conifer, bool)
    hsh = np.array([cell_hash(r_, c_, "crown") for r_, c_, _ in trunks], np.int64)
    v1, v2, v3, v4 = ((hsh >> s) % 1000 / 1000.0 for s in (0, 8, 16, 24))  # per-tree variation in [0, 1)
    _sumc = lambda a: np.bincount(kk[ok_], weights=np.asarray(a, np.float64)[vr_[ok_], vc_[ok_]], minlength=nT)
    measured = _sumc(veg_laser) > 0.5 * np.maximum(_cnt, 1)  # the crown's height from the laser
    have_base = np.zeros(nT, bool)
    # a crown whose species OSM or the register knows keeps it; the others take the species map's class where half
    # of the crown's cells or more have it (species_map.per_crown), else the laser's
    _unk = ~con & ~np.array(trunk_broad, bool)
    cls_rs, share_rs = np.full(nT, species_map.NONE, np.uint8), np.zeros(nT)
    if SPM is not None:
        cls_rs, share_rs = species_map.per_crown(SPM[vr_[ok_], vc_[ok_]], kk[ok_], nT)
    _mapped = share_rs >= 0.5
    cls_rs = np.where(_mapped, cls_rs, species_map.NONE)
    everg_rs = np.isin(cls_rs, species_map.EVERGREEN)
    larch_rs = cls_rs == species_map.LARCH
    broad_rs = np.isin(cls_rs, species_map.BROADLEAF)
    lcon = np.zeros(nT, bool)
    if LZ is not None:
        # conifers by the winter scan: a spruce, fir, pine, yew or thuja keeps its needles and stops the pulse in the
        # crown (one return, nothing behind it); a bare broadleaf crown lets it on through its twigs to the ground
        # (more returns), and the needles reflect brighter: the canopy first returns' mean intensity is ~960 over
        # evergreen conifers, ~560 over bare broadleaf crowns (~690 over leafless larch). A quarter of the crown's
        # canopy pulses single or a mean intensity of 780 and up makes it a conifer (against the DLR map's forest
        # blocks: recall 0.82 at precision 0.72; single >= 0.2 alone found half the conifers)
        _can, _sgl = _sumc(LZ["n_canopy"]), _sumc(LZ["n_single"])
        _int = _sumc(LZ["int_canopy"]) * 16 / np.maximum(_can, 1)
        # (a crown of 10 m2 or more: a narrow dense column is an ivy-clad trunk or a pole as often, a green pillar)
        lcon = ((_sgl >= 0.25 * _can) | (_int >= 780)) & (_can >= 15) & (_cnt >= 10)
        # needles in February, single and bright: no larch (the map's larch is then a spruce or Douglas fir beside it),
        # and in a broadleaf pixel a conifer among the broadleaves
        _dense = (_sgl >= 0.25 * _can) & (_int >= 800) & (_can >= 15)
        larch_rs &= ~_dense
        lcon = (everg_rs | (cls_rs == species_map.LARCH) & _dense | broad_rs & _dense
                | (cls_rs == species_map.NONE) & lcon)
    lcon = _unk & (lcon | everg_rs | larch_rs)
    note("crowns of unknown species on the species map:", int((_unk & _mapped).sum()), "of", int(_unk.sum()),
         "(evergreen conifer", int((_unk & everg_rs).sum()), "larch", int((_unk & larch_rs).sum()), "broadleaved",
         int((_unk & broad_rs).sum()), ")")
    note("conifers by the species map and the laser:", int(lcon.sum()), "(by species:", int(con.sum()), ")")
    con |= lcon
    # the map's genus where the crown is drawn as the map says (trees.json "sp_rs", for phenology.py; "species"/"sp"
    # stay the register's and OSM's): not where the laser overruled it (needles in a broadleaf or larch pixel)
    _say = _unk & ((everg_rs | larch_rs) & con | broad_rs & ~con)
    for i_ in np.nonzero(_say)[0]:
        if trunk_rec[i_] is not None:
            trunk_rec[i_]["sp_rs"] = species_map.GENUS[int(cls_rs[i_])] or species_map.OTHER_BROADLEAF
    if LZ is not None:
        # the crown's underside from the laser: the median over its cells (8+ vegetation returns) of their lowest
        # tenth -- the lowest branches, and on a tree in the open, its skirt
        _cb = (LZ["veg_n"] >= 8) & veg
        _m = ok_ & _cb[vr_, vc_]
        _kb, _vb = kk[_m], LZ["veg_p10"][vr_[_m], vc_[_m]].astype(np.float32) / 10
        _o = np.lexsort((_vb, _kb))
        _nb = np.bincount(_kb, minlength=nT)
        _sb = np.concatenate([[0], np.cumsum(_nb)[:-1]])
        base_l = np.where(_nb > 0, _vb[_o][np.clip(_sb + _nb // 2, 0, max(len(_vb) - 1, 0))] if len(_vb) else 0, np.nan)
        have_base = (_nb >= 4) & measured
        _rl = base_l / np.maximum(Ht, 1)
        if have_base.any():
            note("crown base / height from the laser, quartiles (broadleaf, conifer):",
                 np.round(np.percentile(_rl[have_base & ~con], [25, 50, 75]), 2).tolist(),
                 np.round(np.percentile(_rl[have_base & con], [25, 50, 75]), 2).tolist() if (have_base & con).any() else None)
    # no tall narrow crowns: a broadleaf tree is at most ~3.4 crown radii + 5 m tall (a conifer 5 radii). A crown the
    # laser measured is as tall as it is (in the forests the crowns are narrow and tall, packed): up to 6 radii + 5 m
    Ht = np.minimum(Ht, np.where(con, 5 + np.where(measured, 7.0, 5.0) * Re, 5 + np.where(measured, 6.0, 3.2) * Re)) * (0.95 + 0.06 * v1)
    # a crown squeezed against a facade (a third of it within 2 m of a building) is the wall's LiDAR as much as a tree:
    # lower still (2.4 radii + 3 m), no green pillar up the front
    _atwall = np.bincount(_kx, weights=_nearb[vr_, vc_].astype(np.float64), minlength=nT + 1)[:nT] / np.maximum(_cnt, 1)
    Ht = np.where(_atwall > 0.33, np.minimum(Ht, 3 + 2.4 * Re), Ht)
    Ht = np.maximum(Ht, 3)
    # crown depth (top to underside over the trunk): about the crown's width, never more than 2/3 of the tree
    dep = np.minimum(0.62 * Ht, (1.5 + 0.5 * v2) * Re + 2)
    dep = np.where(con, np.minimum(0.82 * Ht, 4.5 * Re + 2), dep)
    if have_base.any():
        # from the laser's crown base: in leaf-off it is biased low (bare twigs, the trunk, undergrowth reflect where
        # leaves would hide them in summer: the lowest tenth of the returns sits at ~0.17 of the height under a bare
        # broadleaf's crown), so a broadleaf takes it halfway towards the 0.38 drawn without it. A conifer's needles
        # are there in winter too, but its dense crown shadows its own underside from the pulses (its lowest tenth
        # reads ~0.5 of the height, a spruce's skirt hangs lower): three quarters of it. Never deeper than a crown's width allows
        # (2.4-3 radii + 3 m broadleaf, 5 radii + 3 m conifer), no pillars of leaves
        _rb = np.clip(0.5 * _rl + 0.5 * 0.38, 0.15, 0.65)
        _rc = np.clip(0.75 * _rl, 0.1, 0.5)
        _dl = Ht * (1 - np.where(con, _rc, _rb))
        _dl = np.minimum(_dl, np.where(con, 5 * Re + 3, (2.4 + 0.6 * v2) * Re + 3))
        dep = np.where(have_base & np.isfinite(_dl), _dl, dep)
        note("crowns shaped on the laser's crown base:", int(have_base.sum()), "of", nT)
    dep = np.maximum(dep, np.minimum(2.0, Ht - 1))
    pw = 1.7 + 0.9 * v3  # superellipse exponent: a round ball (1.7) to a fuller, flatter-topped lime (2.6)
    u = np.clip(_dt[vr_, vc_] / (_dt[vr_, vc_] + _db[vr_, vc_] + 0.8), 0, 1)
    H_, dp_, pw_ = Ht[kk], dep[kk], pw[kk]
    con_ = con[kk]
    # smooth noise, ~1 m amplitude, 2-3 m patches
    # (hashed from the project grid's coordinates, region.noise: the same crowns in every region)
    nz_ = region.noise(7, 1.3)[vr_, vc_]
    nz2_ = region.noise(8, 1.0)[vr_, vc_]
    zc = H_ - 0.5 * dp_  # broadleaf: a superellipsoid, its waist a little below the middle (u = 1)
    s_ = np.clip(1 - u ** pw_, 0, 1) ** (1 / pw_)
    top_b = zc + 0.5 * dp_ * s_
    bot_b = zc - 0.5 * dp_ * s_ * 1.1
    top_c = H_ - (dp_ - 0.5) * u ** 0.9            # conifer: a cone to the top, the skirt flaring out a little
    bot_c = H_ - dp_ + 0.25 * dp_ * u
    top_rel = np.where(con_, top_c, top_b) + np.clip(nz_ * 1.0, -1.5, 1.5) * np.minimum(1, dp_ / 4)
    bot_rel = np.where(con_, bot_c, bot_b) + np.clip(nz2_ * 0.7, -1.0, 1.0) * np.minimum(1, dp_ / 4)
    top_abs = np.round(G0[kk] + top_rel).astype(np.int32)
    bot_abs = np.round(G0[kk] + bot_rel).astype(np.int32)
    bot_abs = np.maximum(bot_abs, g[vr_, vc_] + 2)  # uphill the crown keeps clear of the ground
    # gaps: the thin rim where two crowns meet (and the outermost fringe) is left out
    keep = ok_ & (top_abs > bot_abs) & ~((s_ < 0.32) & ~con_ & (dp_ >= 4))
    crown_top[vr_[ok_], vc_[ok_]] = (top_abs - g[vr_, vc_])[ok_]
    crown_bot[vr_[ok_], vc_[ok_]] = (bot_abs - g[vr_, vc_])[ok_]
    veg[vr_[ok_ & ~keep], vc_[ok_ & ~keep]] = False
    # the trunk always reaches its crown: over the trunk the crown's underside is the crown's own (no noise)
    for i_, (r_, c_, _) in enumerate(trunks):
        if veg[r_, c_]:
            crown_bot[r_, c_] = max(2, int(round(G0[i_] + Ht[i_] - (dep[i_] if con[i_] else 1.05 * dep[i_])) - g[r_, c_]))
            crown_top[r_, c_] = max(int(crown_top[r_, c_]), int(crown_bot[r_, c_]) + 1)
    for i_, rec_ in enumerate(trunk_rec):  # conifers stay green through the winter (phenology.py)
        if rec_ is not None and con[i_]:
            rec_["con"] = 1
    note("crowns as solids at their trunks:", nT, "conifers:", int(con.sum()), "rim cells left out:", int((ok_ & ~keep).sum()))
    # one leaf tone per tree: its crown's mean ortho brightness and hue
    _lt = np.asarray(ndimage.mean(lum, labels=own, index=idx_), np.float32)
    _yt = np.asarray(ndimage.mean(yellowish.astype(np.float32), labels=own, index=idx_), np.float32) + (v3 - 0.5) * 0.5 > 0.5
    _lb = np.clip(((np.nan_to_num(_lt, nan=90) - 40) / 110 * 5 + (v4 - 0.5) * 1.6).astype(int), 0, 4)
    tone_t = (4 - _lb) + 5 * (~_yt)  # index into LEAVES
    tone = np.full((D, W), -1, np.int16)
    tone[vr_[ok_], vc_[ok_]] = np.where(con_, -2 - (hsh[kk] % 5), tone_t[kk])[ok_]
    czc = np.zeros((D, W), np.int32)  # the crown's waist (absolute), to tell its upper half from its underside
    czc[vr_[ok_], vc_[ok_]] = np.round(G0[kk] + np.where(con_, H_ - 0.6 * dp_, zc))[ok_].astype(np.int32)
    # conifers (thuja, pine, spruce, yew...: the city database's species) in dark blue-green needles, not leaf green
    NEEDLES = np.array([pal(c_, M_LEAF) for c_ in ("#37553f", "#3f5f48", "#456a4f", "#4d7356", "#52785a")], np.uint16)  # dark to light
    note("conifer crowns (database species):", int(con.sum()), "cells", int((ok_ & con_).sum()))
    # which tree each 2 m cell's leaves belong to (data/crowns.npz, for phenology.py's foliage.bin): the tree owning
    # most of the cell's canopy, the trunk's own cell counting for four (a crown keeps the cell over its trunk). The
    # viewer turns a leaf by its 2 m cell, so a cell is evergreen or deciduous as a whole: where a broadleaf crown's
    # edge shares a cell with a conifer, its leaf voxels there stayed in leaf through the winter (thin bright-green
    # columns beside the conifers among the bare trees), and the conifer's needles in a broadleaf's cell went bare.
    # Those voxels (the other kind than the cell's owner) are left out: the boundary between the two snaps to 2 m
    # (a larch, by its species or the species map, is a cone but bare in winter)
    evg = con & ~np.array([((r_ or {}).get("species") or (r_ or {}).get("sp_rs") or "").split(" ")[0] in ("Larix", "Metasequoia")
                           for r_ in trunk_rec])
    _wt = np.where(veg, 1, 0).astype(np.int8)
    _wt[tidx > 0] *= 4
    _o4 = np.where(veg, own, 0).reshape(D // 2, 2, W // 2, 2).transpose(0, 2, 1, 3).reshape(D // 2, W // 2, 4)
    _w4 = _wt.reshape(D // 2, 2, W // 2, 2).transpose(0, 2, 1, 3).reshape(D // 2, W // 2, 4)
    own2 = np.zeros((D // 2, W // 2), np.int32)  # (trunk index + 1, 0 where no canopy)
    _bn = np.zeros((D // 2, W // 2), np.int16)
    for k_ in range(4):
        _cand = _o4[..., k_]
        _n = ((_o4 == _cand[..., None]) * _w4).sum(-1)
        _up = (_cand > 0) & (_n > _bn)
        own2[_up], _bn[_up] = _cand[_up], _n[_up]
    _evg0 = np.concatenate([[False], evg])
    _odd = veg & (own > 0) & (_evg0[own] != np.repeat(np.repeat(_evg0[own2], 2, 0), 2, 1))
    note("crown cells of the other kind than their 2 m cell's owner (evergreen / deciduous) left out:", int(_odd.sum()),
         "(broadleaf in a conifer's cell:", int((_odd & ~_evg0[own]).sum()), ")")
    veg &= ~_odd
# a crown over a carriageway keeps ROAD_CLEAR m clear of its ground (a street tree is pruned for the traffic; the
# sloped caps lift the drawn street up to caps.CLAMP = 60/64 m over its voxel, and a car's body reaches 1.8 m over it:
# docs/plans/road-clearance.md); over the trunk's own cell too (none stands on a carriageway)
ROAD_CLEAR = 3
_lift = veg & is_road & (crown_bot < ROAD_CLEAR)
crown_bot[_lift] = ROAD_CLEAR
note("crown cells over carriageways lifted to", ROAD_CLEAR, "m:", int(_lift.sum()))
LEAVES_ = np.array(LEAVES, np.uint16)
rr, cc = np.nonzero(veg)
if trunks:
    tn_ = tone[rr, cc].astype(np.int32)
    cz_ = czc[rr, cc]
for zz in range(int(g.min()) + 1, int((g + crown_top).max()) + 1):
    m = (zz >= g[rr, cc] + crown_bot[rr, cc]) & (zz < g[rr, cc] + crown_top[rr, cc])
    if not m.any():
        continue
    sel = (rr[m], cc[m])
    col_ = leafidx[sel]
    if trunks:
        t_ = tn_[m]
        # clumps of 3 x 3 x 3 voxels (fewer colour seams for the mesher than single voxels): a fifth of those in the
        # upper half one tone lighter, a tenth underneath one darker
        hz = (((rr[m] + R0) // 3) * 73856093 ^ ((cc[m] + C0) // 3) * 19349663 ^ (zz // 3) * 83492791) % 10  # (the project grid's)
        up_ = zz >= cz_[m]
        sh_ = np.where(up_ & (hz < 2), -1, np.where(~up_ & (hz < 1), 1, 0))
        b_ = t_ % 5  # broadleaf: lightness step within the hue family
        leaf_ = LEAVES_[np.clip(t_ - b_ + np.clip(b_ + sh_, 0, 4), 0, 9)]
        n_ = NEEDLES[np.clip((-2 - t_) + sh_, 0, 4)]
        col_ = np.where(t_ >= 0, leaf_, np.where(t_ <= -2, n_, col_))
    cur = vol[zz][sel]
    vol[zz][sel] = np.where(cur == 0, col_, cur)
note("canopy cells:", int(veg.sum()), "crowns:", len(trunks))
for r_, c_, thick in trunks:  # from the ground one voxel into the crown's lowest point, over the trunk
    hb = int(crown_bot[r_, c_]) + 1
    for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)) if thick else ((0, 0),):
        rr_, cc_ = r_ + dr, c_ + dc
        if 0 <= rr_ < D and 0 <= cc_ < W and not bmask[rr_, cc_]:
            vol[g[rr_, cc_]:g[rr_, cc_] + hb, rr_, cc_] = C["trunk"]
# branches: a broadleaf crown's bare wood, inside its leaves -- what the viewer shows of it in winter, when the leaves
# are gone (voxelMaterial.ts; mesher.worker.ts draws wood through the leaves around it). Per tree, from its own cells
# and a generator seeded by its trunk's project grid cell (the same tree in every region): the trunk on up to a fork at
# a quarter to two fifths of the crown's depth, a leader on towards the top, 3-5 limbs (more in a wider crown) out to
# half the crown's reach in their direction and up, each forking into 1-3 branches (by the crown's width) that end a
# metre or two inside the leaf surface near its rim; in wide crowns more off the leader and the limbs' middles. One
# voxel thick, the branches paler (twig), never on the leaf surface (no brown specks in summer). Voxels only within
# the tree's own crown cells, into its leaves or the air under its top; none in an evergreen conifer. A larch (bare in
# winter as well, phenology.py) gets a conifer's skeleton instead: its trunk on up as a straight leader, inside the
# needles, to near the top, whorls of 4-5 thin branches round it every 1.2-1.7 m, near level, the lower ones longer
# (out to most of the crown's reach, drooping a little), the upper ones short and rising: a bare cone. (A packed
# forest's narrow crowns get few branches: each wood voxel costs ~6 triangles, drawn all year.)
n_wood = n_wtree = n_ltree = 0
if trunks:
    _isleaf = np.zeros(len(pal.entries) + 64, bool)
    _isleaf[[i for i, e in enumerate(pal.entries) if e[3] == M_LEAF]] = True
    _AZ = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    _ST = np.arange(1, 2 * region.CROWN_R + 1) * 0.5
    for i_, (r0_, c0_, thick_) in enumerate(trunks):
        if evg[i_] or not veg[r0_, c0_]:
            continue
        zb_ = int(g[r0_, c0_] + crown_bot[r0_, c0_])
        zt_ = int(g[r0_, c0_] + crown_top[r0_, c0_])
        if zt_ - zb_ < 4:
            continue
        own_id = i_ + 1
        # the crown's reach along 16 directions from the trunk's centre: to the last of its own cells before a gap
        _y = r0_ + 0.5 + np.outer(np.sin(_AZ), _ST)
        _x = c0_ + 0.5 + np.outer(np.cos(_AZ), _ST)
        _ri, _ci = np.floor(_y).astype(np.int64), np.floor(_x).astype(np.int64)
        _in = (_ri >= 0) & (_ri < D) & (_ci >= 0) & (_ci < W)
        _ri, _ci = np.clip(_ri, 0, D - 1), np.clip(_ci, 0, W - 1)
        _in &= veg[_ri, _ci] & (own[_ri, _ci] == own_id)
        _fo = np.argmin(_in, 1)
        reach_ = np.where(_in.all(1), _ST[-1], np.where(_fo > 0, _ST[np.maximum(_fo - 1, 0)], 0.0))
        if reach_.max() < (1 if con[i_] else 2):  # (a larch's narrow cone: its leader and what branches fit)
            continue
        rng_ = np.random.default_rng(cell_hash(r0_, c0_, "limbs"))

        def reach_at(a):
            f = (a % (2 * np.pi)) / (2 * np.pi) * 16
            k = int(f) % 16
            return reach_[k] + (reach_[(k + 1) % 16] - reach_[k]) * (f - int(f))

        def crown_z(r, c):
            """the crown's underside and top (absolute) at (r, c) if it is this tree's, else None"""
            if 0 <= r < D and 0 <= c < W and veg[r, c] and own[r, c] == own_id:
                return int(g[r, c] + crown_bot[r, c]), int(g[r, c] + crown_top[r, c])
            return None

        def hidden(z, r, c):
            """under the leaf surface: inside a crown on all four sides and above (from the crowns' rasters, not the
            volume: the same whatever order the trees are drawn in)"""
            for rn, cn, zn in ((r - 1, c, z), (r + 1, c, z), (r, c - 1, z), (r, c + 1, z), (r, c, z + 1)):
                if not (0 <= rn < D and 0 <= cn < W and veg[rn, cn]
                        and g[rn, cn] + crown_bot[rn, cn] <= zn < g[rn, cn] + crown_top[rn, cn]):
                    return False
            return True

        def put(z, r, c, col):
            global n_wood
            if not (0 <= r < D and 0 <= c < W and 0 <= z < H) or own[r, c] != own_id or z <= g[r, c]:
                return
            v = vol[z, r, c]
            if col == C["twig"] and not hidden(z, r, c):  # a branch stays under the leaf surface
                return
            if (v == 0 and z < g[r, c] + crown_top[r, c]) or _isleaf[v]:
                vol[z, r, c] = col
                n_wood += 1

        def seg(p, q, col):
            d = np.subtract(q, p, dtype=np.float64)
            n = int(np.ceil(np.abs(d).max()))
            for t in range(n + 1):
                x, y, z = (p + d * (t / max(n, 1)))
                put(int(np.floor(z)), int(np.floor(y)), int(np.floor(x)), col)

        def tip(a, frac, lo, hi, base):
            """a point frac of the reach out along azimuth a (from the trunk), its height lo..hi of the way from the
            crown's underside to a metre and a half under its top there (pulled in until it is in the crown)"""
            for k in range(6):
                d = frac * reach_at(a) * (1 - 0.15 * k)
                x, y = c0_ + 0.5 + d * np.cos(a), r0_ + 0.5 + d * np.sin(a)
                cz = crown_z(int(np.floor(y)), int(np.floor(x)))
                if cz is not None and cz[1] - 1.5 > cz[0] + 0.5:
                    b_, t_ = cz[0] + 0.5, cz[1] - 1.5
                    z = b_ + (lo + (hi - lo) * rng_.random()) * (t_ - b_)
                    return np.array([x, y, max(z, base)])
            return None

        if con[i_]:  # a larch (a conifer, not evergreen)
            n_ltree += 1
            cx, cy, dz = c0_ + 0.5, r0_ + 0.5, zt_ - zb_
            # the leader: bark, under the needles' surface (a cone's top metres are the trunk's column alone: there
            # it stops, or it would stand out of the crown in summer), its upper third in twig
            for z in range(zb_ + 1, zt_):
                if not hidden(z, r0_, c0_):
                    if z > zb_ + dz // 2:
                        break
                    continue
                col = C["trunk"] if z < zb_ + 2 * dz // 3 else C["twig"]
                for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)) if thick_ and z < zb_ + dz // 2 else ((0, 0),):
                    if hidden(z, r0_ + dr, c0_ + dc):
                        put(z, r0_ + dr, c0_ + dc, col)
            z = zb_ + 1 + rng_.random() * 1.5
            while z < zt_ - 2:
                f = (zt_ - z) / dz  # 1 at the crown's foot .. 0 at its top
                nb = 4 + int(rng_.random() < 0.4)
                a0 = rng_.random() * 2 * np.pi
                for k in range(nb):
                    a = a0 + k * 2 * np.pi / nb + rng_.uniform(-0.4, 0.4)
                    # out to the cone's rim at this height (put() stops it a voxel under the needles' surface)
                    L = reach_at(a) * (0.4 + 0.6 * f) * rng_.uniform(0.9, 1.0) + 0.5
                    if L < 1:
                        continue
                    seg(np.array([cx, cy, z]), np.array([cx + L * np.cos(a), cy + L * np.sin(a), z + L * (0.35 - 0.5 * f)]),
                        C["twig"])
                z += 1.2 + 0.5 * rng_.random()
            continue
        n_wtree += 1
        dz = zt_ - zb_
        zf = zb_ + max(1, int(round((0.25 + 0.15 * rng_.random()) * dz)))
        cx, cy = c0_ + 0.5, r0_ + 0.5
        for z in range(zb_ + 1, zf + 1):  # the trunk on up to the fork
            for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)) if thick_ else ((0, 0),):
                put(z, r0_ + dr, c0_ + dc, C["trunk"])
        fork = np.array([cx, cy, zf + 0.5])
        rbar = float(np.mean(reach_))
        nl = 3 + (rbar >= 4.5) + (rbar >= 6.5) + int(rng_.random() < 0.2)
        a0 = rng_.random() * 2 * np.pi
        # the leader: on up from the fork, leaning a little, two branches off its top
        lean = rng_.random() * 2 * np.pi
        top = np.array([cx + 0.6 * np.cos(lean), cy + 0.6 * np.sin(lean), zt_ - 1.5])
        if top[2] > fork[2] + 1:
            mid = fork + (top - fork) * 0.6
            seg(fork, mid, C["trunk"])
            seg(mid, top, C["twig"])
            for k in range(2 if rbar >= 4 else 0):
                t2 = tip(a0 + (k + 0.5) * 2 * np.pi / 2 + rng_.uniform(-0.4, 0.4), 0.45, 0.75, 1.0, top[2] - 1)
                if t2 is not None:
                    seg(mid, t2, C["twig"])
        for k in range(nl):
            a = a0 + (k + 0.5) * 2 * np.pi / nl + rng_.uniform(-0.3, 0.3)
            e = tip(a, 0.45 + 0.15 * rng_.random(), 0.35, 0.7, fork[2] + 1)
            if e is None:
                continue
            seg(fork, e, C["trunk"])
            # branches off the limb's end: out to the rim, one up and one or two to the sides
            for da, lo, hi in ((rng_.uniform(-0.25, 0.25), 0.7, 1.0), (rng_.uniform(0.45, 0.75), 0.4, 0.8),
                               (-rng_.uniform(0.45, 0.75), 0.4, 0.8))[:1 + (rbar >= 4) + (rbar >= 6)]:
                t2 = tip(a + da, 0.85 + 0.1 * rng_.random(), lo, hi, e[2] - 2)
                if t2 is not None:
                    seg(e, t2, C["twig"])
            # and one off its middle, outwards and lower: the crown's waist
            if rbar >= 5.5 and k % 2 == 0:
                m2 = fork + (e - fork) * 0.5
                t2 = tip(a + rng_.uniform(-0.5, 0.5), 0.8, 0.1, 0.4, m2[2] - 2)
                if t2 is not None:
                    seg(m2, t2, C["twig"])
note("broadleaf crowns given branches:", n_wtree, "larches:", n_ltree, "wood voxels:", n_wood)
# the tree register for the viewer and for phenology.py: the trees standing in the core (a region's), each with its
# place in the map's order (regions.py sorts by it: OSM's trees as osm.json has them, the register's as its file does,
# the trunks at canopy tops tallest first, then row by row)
for t in trunk_rec:  # the trunks placed at canopy tops: no database tree, an id from the cell
    if t is not None and t["src"] == "lidar":
        t["h"] = int(crown_top[int(t["y"]), int(t["x"])])
        all_trees.append(t)
_tr = []
for t in all_trees:
    if not in_core(int(t["y"]), int(t["x"])):
        continue
    rec = dict(id=t["id"], x=round(t["x"] + MC0, 1), y=round(t["y"] + MR0, 1), src=t["src"], drawn=t.get("drawn"))
    for k_src, k_out in (("z", "z"), ("h", "h"), ("species", "sp"), ("trunk_cm", "cm"), ("osm", "osm"), ("height", "h_inv"),
                        ("bv_height", "h_bv"), ("con", "con"), ("sp_rs", "sp_rs")):
        if t.get(k_src) is not None:
            rec[k_out] = t[k_src]
    if t["src"] == "lidar":
        key = [2, -t["peak"], int(t["y"]) + R0, int(t["x"]) + C0]
    else:
        key = [0, t["osm"]] if t["src"] == "osm" else [1, t["k"]]  # (OSM's: its id, the file's order in any cut of it)
    _tr.append(dict(key=key, rec=rec))
RESULT["trees"] = _tr
# which tree each 2 m cell's leaves belong to, for phenology.py (foliage.bin): own2 above, as a tree's id here
# (regions.py: an index into trees.json). (phenology.py took the nearest trunk on the 2 m grid, which is not always the
# crown's own: a broadleaf crown's side beside a conifer took the conifer's evergreen class and stood green through the
# winter, a pillar)
_crown_ids = []
_best = np.full((D // 2, W // 2), -1, np.int32)
if trunks:
    _map = np.full(len(trunks) + 1, -1, np.int32)
    for i_, rec_ in enumerate(trunk_rec):
        if rec_ is not None:
            _map[i_ + 1] = len(_crown_ids)
            _crown_ids.append(rec_["id"])
    _best = _map[own2]
RESULT["crown_ids"] = _crown_ids

stage("vegetation")
# ---------------------------------------------------------------- fountains
# A flat walk-on fountain (OSM fountain=splash_pad): dark speckled granite cut into irregular
# polygons, darker shard inlays, flush with the paving, slot drain round the edge, jets from steel rings ~2 m apart.
GRAN = [pal("#6a6e71"), pal("#62666a"), pal("#72767a")]
SHARD, DRAIN, RING = pal("#4a4d50"), pal("#3a3c3f", M_METAL), pal("#b9bdc0", M_METAL)
n_jets = 0
jets = []  # (key in the map's order, jet): regions.py keeps a region's in its core
for rel_pad, oid_pad, geom in splash_pads:  # (keyed by OSM type and id: the file's order, in any region's cut of it)
    rr, cc = cells_of(geom)
    if len(rr) == 0:
        continue
    m = np.zeros((D, W), bool)
    m[rr, cc] = True
    edge = m & ~ndimage.binary_erosion(m)
    # polygon slabs: Voronoi cells around a few random seeds
    rng = np.random.default_rng(stable_hash(int((rr + R0).mean()), int((cc + C0).mean())))
    seeds = np.stack([rng.uniform(rr.min(), rr.max() + 1, 14), rng.uniform(cc.min(), cc.max() + 1, 14)], 1)
    for r, c in zip(rr, cc):
        z0 = g[r, c] - 1
        d2 = ((seeds - (r + 0.5, c + 0.5)) ** 2).sum(1)
        o2 = np.sort(d2)
        k = int(np.argmin(d2))
        if edge[r, c]:
            v = DRAIN
        elif o2[1] - o2[0] < 1.6:  # seam between slabs
            v = SHARD
        elif r % 2 == 0 and c % 2 == 0:
            v = RING
            jets.append(([rel_pad, oid_pad, int(r) + R0, int(c) + C0], [c + MC0 + 0.5, int(z0 + 1), r + MR0 + 0.5]))  # rendered as animated water columns in the viewer
            n_jets += 1
        else:
            v = SHARD if cell_hash(r, c, 7) % 23 == 0 else GRAN[k % 3]
        vol[z0, r, c] = v
note("splash-pad fountain jets:", n_jets)


# ---------------------------------------------------------------- planted beds
# small leisure=garden / flowerbed islands are raised perennial beds edged with concrete bench-kerbs
n_beds = 0
for oid, typ, t, geom in osm.areas:
    if not (t.get("leisure") == "garden" or t.get("landuse") == "flowerbed") or underground(t) or not (4 <= geom.area <= 400):
        continue
    rr, cc = cells_of(geom)
    k = ~bmask[rr, cc]
    rr, cc = rr[k], cc[k]
    if len(rr) == 0:
        continue
    m = np.zeros((D, W), bool)
    m[rr, cc] = True
    edge = m & ~ndimage.binary_erosion(m)
    for r, c in zip(rr, cc):
        z0 = g[r, c]
        if vol[z0, r, c] != 0:
            continue
        if edge[r, c] and geom.area > 12:
            vol[z0, r, c] = C["benchkerb"]
        elif stable_hash(oid, r + R0, c + C0) % 5:
            vol[z0, r, c] = PERENNIALS[cell_hash(r, c, oid) % len(PERENNIALS)]
    n_beds += 1
note("raised planting beds:", n_beds)

# ---------------------------------------------------------------- street furniture
# a post stands beside the carriageway and the tracks, not in them: OSM's lamp nodes sit on the kerb line, and 89 of
# them fell a metre or two inside the road as drawn (cars drove through the poles); such a post takes the nearest
# cell off the road within 4 m, and one deeper in (a lamp hung over the street) gets no pole
_driven = is_road | np.isin(gcol, [C["trambed"], C["rail"], C["ballast"]])
_kd, (_kr, _kc) = ndimage.distance_transform_edt(_driven, return_indices=True)


def kerb(c, r):
    if not (0 <= c < W and 0 <= r < D):
        return None
    return (int(_kc[r, c]), int(_kr[r, c])) if _kd[r, c] <= 4 else None


def lamp_height(t, c, r):
    return int(parse_len(t.get("height")) or (10 if is_road[max(r - 6, 0):r + 7, max(c - 6, 0):c + 7].any() else 6))


def stand_lamp(c, r, z0, hgt, key):
    vol[z0:z0 + hgt - 1, r, c] = np.where(vol[z0:z0 + hgt - 1, r, c] == 0, C["pole"], vol[z0:z0 + hgt - 1, r, c])
    vol[z0 + hgt - 1, r, c] = C["lamp"]
    lamps.append((c, r, int(z0 + hgt - 1)))
    LAMP_KEYS.append(key)


# a lamp node by a bridge way (within 3 m: OSM's lamp nodes sit on the kerb line) waits for the deck (below): it
# stands on the deck's top, not on the ground or the river under it -- kerb() put the Marienbrücke's lamps (a deck of
# carriageway from edge to edge) beside the deck, poles from the Inn up to its edge, and the Alte Poststraße's over the
# A 3 stood on the motorway, up to under the deck. d_br, d_gr: the node's distance from the nearest bridge way and
# from the nearest way on the ground that may be lit (one under the bridge, the street the bridge lands on; not the
# unlit A 3 under the Alte Poststraße, nor a field track: UNLIT). A node's layer tag decides: 0 or less on the
# ground, 1 or more on the deck
_bridge_ways = STRtree([p_ for p_, _, _ in bridge_shapes])
_ground_ways = STRtree(lit_ground_ways)


def _way_dist(tree, p):
    _, d_ = tree.query_nearest(p, max_distance=8, return_distance=True)
    return float(d_.min()) if len(d_) else math.inf


lamps = []  # (c, r, z) here; LAMP_KEYS: each one's place in the map's order (regions.py)
LAMP_KEYS = []
bridge_lamps = []  # (oid, tags, node, d_br, d_gr): placed with the deck
for oid, t, p in osm.nodes_with("highway", ("street_lamp",)):  # (keys: OSM ids, the file's order in any cut of it)
    d_br, layer = _way_dist(_bridge_ways, p), parse_len(t.get("layer"))
    if d_br <= 3 and (layer is None or layer >= 1) and 0 <= p.x < W and 0 <= p.y < D:
        bridge_lamps.append((oid, t, p, d_br, math.inf if layer else _way_dist(_ground_ways, p)))
        continue
    c, r = kerb(int(p.x), int(p.y)) or (-1, -1)
    if not (0 <= c < W and 0 <= r < D) or bmask[r, c]:
        continue
    stand_lamp(c, r, int(g[r, c]), lamp_height(t, c, r), [0, oid])
note("street lamps:", len(lamps), "(and", len(bridge_lamps), "by bridge ways, placed with the decks)")
# (the bridges' lamps where their nodes are: the park and the inferred deck lamps keep 12 m from them)
lamp_xy = np.array([(c, r) for c, r, _ in lamps] + [(int(p.x), int(p.y)) for _, _, p, _, _ in bridge_lamps], float).reshape(-1, 2)
# park lamps: OSM maps almost none in the parks and along the river promenades (the Innpromenade, the Ortspitze),
# which stood dark at night. Along their walks a 4 m lamp every ~25 m, a metre and a half beside the way on soft
# ground or paving (never on the way itself, a carriageway or in a building), none within 12 m of another lamp
_parks = [g_ for _, _, t_, g_ in osm.areas if t_.get("leisure") == "park" and not underground(t_)]
_park_u = _uu(_parks).buffer(0) if _parks else None
_pwalk = np.zeros((D, W), np.uint8)
burn(_pwalk, [(s_, 1) for s_, _ in foot_shapes + cycle_shapes])
n_pl = 0
for oid, t, line in osm.lines:
    if t.get("highway") not in ("footway", "path", "pedestrian", "cycleway") or underground(t) or on_bridge(t):
        continue
    name = (t.get("name") or "").lower()
    seg = line if ("promenade" in name or name == "ortspitze") else (line.intersection(_park_u) if _park_u is not None else None)
    for i_part, part in enumerate(getattr(seg, "geoms", [seg]) if seg is not None and not seg.is_empty else []):
        if part.geom_type != "LineString" or part.length < 20:
            continue
        for k, s_ in enumerate(np.arange(10, part.length - 5, 25)):
            p0, p1 = part.interpolate(max(s_ - 1, 0)), part.interpolate(min(s_ + 1, part.length))
            L_ = math.hypot(p1.x - p0.x, p1.y - p0.y) or 1
            side = 1 if k % 2 == 0 else -1
            for off in (1.8, 2.6):
                x_ = part.interpolate(s_).x - (p1.y - p0.y) / L_ * off * side
                y_ = part.interpolate(s_).y + (p1.x - p0.x) / L_ * off * side
                c, r = int(x_), int(y_)
                if 0 <= c < W and 0 <= r < D and not bmask[r, c] and not _driven[r, c] and not _pwalk[r, c] \
                        and gcol[r, c] != C["water"] and vol[g[r, c], r, c] == 0:
                    break
            else:
                continue
            if len(lamp_xy) and np.min(np.hypot(lamp_xy[:, 0] - c, lamp_xy[:, 1] - r)) < 12:
                continue
            z0 = int(g[r, c])
            vol[z0:z0 + 3, r, c] = C["pole"]
            vol[z0 + 3, r, c] = C["lamp"]
            lamps.append((c, r, z0 + 3))
            LAMP_KEYS.append([1, oid, i_part, k])
            lamp_xy = np.vstack([lamp_xy, [c, r]])
            n_pl += 1
note("park and promenade lamps:", n_pl)

n_gs = 0
for r, c, v in grave_stones:  # the headstones (cemeteries above): not where a trunk or a bed already stands
    if vol[g[r, c], r, c] == 0 and not bmask[r, c]:
        vol[g[r, c], r, c] = v
        n_gs += 1
note("grave stones set:", n_gs)
# benches (OSM amenity=bench, ~280 in the promenades, parks and squares): a wooden seat two voxels long beside the
# walk, along the nearest path; on the ground, never on a carriageway or in a building
BENCH = pal("#7a5a3e")
_walks = [l_ for _, t_, l_ in osm.lines if t_.get("highway") in ("footway", "path", "pedestrian", "cycleway", "living_street",
                                                                  "service", "residential", "track")]
_wtree = STRtree(_walks) if _walks else None
n_bench = 0
for oid, t, p in osm.nodes_with("amenity", ("bench",)):
    c, r = int(p.x), int(p.y)
    if not (1 <= c < W - 1 and 1 <= r < D - 1) or bmask[r, c] or _driven[r, c]:
        continue
    dc, dr = 1, 0
    if _wtree is not None:
        l_ = _walks[_wtree.nearest(p)]
        if l_.distance(p) < 8:
            s_ = l_.project(p)
            a_, b_ = l_.interpolate(max(s_ - 1, 0)), l_.interpolate(min(s_ + 1, l_.length))
            dc, dr = (1, 0) if abs(b_.x - a_.x) >= abs(b_.y - a_.y) else (0, 1)
    cells = [(r, c), (r + dr, c + dc)]
    if any(bmask[r_, c_] or _driven[r_, c_] or vol[g[r_, c_], r_, c_] != 0 or abs(int(g[r_, c_]) - int(g[r, c])) > 0
           for r_, c_ in cells):
        cells = cells[:1]
        if vol[g[r, c], r, c] != 0:
            continue
    for r_, c_ in cells:
        vol[g[r_, c_], r_, c_] = BENCH
    n_bench += 1
note("benches:", n_bench)

for oid, typ, t, geom in osm.areas_with("amenity", ("shelter",)):
    if t.get("shelter_type") not in (None, "public_transport", "basic_hut") or bmask[cells_of(geom)].any():
        continue
    rr, cc = cells_of(geom)
    zz = g[rr, cc] + 2
    vol[zz, rr, cc] = C["shelter"]
    vol[g[rr, cc], rr, cc] = np.where((rr + R0 + cc + C0) % 3 == 0, C["pole"], 0)

for oid, t, p in osm.nodes_with("man_made", ("flagpole",)):
    c, r = int(p.x), int(p.y)
    if 0 <= c < W and 0 <= r < D and not bmask[r, c]:
        hgt = int(parse_len(t.get("height")) or 9)
        vol[g[r, c]:g[r, c] + hgt, r, c] = C["fence"]

# bridges / decks: over the rail cut (DTM drops below them) and the rivers. The deck follows the bridge ways
# (bridge=yes roads, paths, tracks buffered to their width; man_made=bridge areas only near them). Its top takes the
# colour of the way on it (asphalt, pavement, cycle lane, tram bed).
deck_col = np.zeros((D, W), np.uint16)
deck_lay = np.zeros((D, W), np.uint16)  # the layer of the way that owns the cell
bridge_area = np.zeros((D, W), np.uint16)
burn(bridge_area, [(geom, 1) for oid, typ, t, geom in osm.areas_with("man_made", ("bridge",))])
for layer in sorted({l for _, _, l in bridge_shapes}):  # upper decks win
    burn(deck_col, [(p_, c_) for p_, c_, l in sorted(bridge_shapes, key=lambda x: -x[0].area) if l == layer])
    burn(deck_lay, [(p_, l + 1) for p_, c_, l in bridge_shapes if l == layer])
near_way = ndimage.binary_dilation(deck_col > 0, iterations=3)
deck_col = np.where((deck_col == 0) & (bridge_area > 0) & near_way, C["deck"], deck_col)
deck = (deck_col > 0) & (nd_mean > 2)
deck = ndimage.binary_closing(deck, iterations=2)  # no slits of sky between the carriageways
deck_col = np.where(deck & (deck_col == 0), C["deck"], deck_col)
# the deck's height: a profile along each bridge way -- the DSM (0.5 m) sampled across the way every metre, its 30th
# percentile (the road surface, not the cars, railings or stays), samples dropped where a higher deck hides the way or
# nothing stands above the river, then a 25 m running median and a 15 m mean. Every deck cell takes the height of the
# nearest profile point of its own layer: one smooth level, so cars drive on it. (The cell-by-cell lowest return
# picked up cells half over the water at the deck edges and broke the decks into steps metres apart.)
from scipy.spatial import cKDTree
water_ = gcol == C["water"]
prof = []  # per way: (x, y, h, layer) every metre
for line, hw, layer, _ in bridge_lines:
    n_ = max(2, int(line.length) + 1)
    P_ = np.array([line.interpolate(v_).coords[0] for v_ in np.linspace(0, line.length, n_)])
    T_ = np.gradient(P_, axis=0)
    T_ /= np.maximum(np.linalg.norm(T_, axis=1, keepdims=True), 1e-6)
    a_, b_ = np.meshgrid(np.arange(-1.5, 1.6, 0.5), np.arange(-max(0.7 * hw, 0.5), max(0.7 * hw, 0.5) + 0.01, 0.5))
    a_, b_ = a_.ravel(), b_.ravel()
    X_ = P_[:, :1] + T_[:, :1] * a_ - T_[:, 1:] * b_
    Y_ = P_[:, 1:] + T_[:, 1:] * a_ + T_[:, :1] * b_
    S_ = dsm[np.clip((Y_ * 2).astype(int), 0, 2 * D - 1), np.clip((X_ * 2).astype(int), 0, 2 * W - 1)]
    pr_, pc_ = np.clip(P_[:, 1].astype(int), 0, D - 1), np.clip(P_[:, 0].astype(int), 0, W - 1)
    # samples on a building beside the way are its roof, not the deck (a sidewalk along a tower: its deck climbed the
    # facade); a way over buildings (a viaduct's arches) keeps them
    Sb_ = bmask[np.clip(Y_.astype(int), 0, D - 1), np.clip(X_.astype(int), 0, W - 1)] & ~bmask[pr_, pc_][:, None]
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        h_ = np.nanpercentile(np.where(Sb_, np.nan, S_), 30, axis=1)
    gd_ = dtm[pr_, pc_]
    ok_ = np.isfinite(h_) & (deck_lay[pr_, pc_] <= layer + 1) & ((h_ > gd_ + 1.5) | (~water_[pr_, pc_] & (h_ > gd_ - 1.5)))
    if ok_.sum() >= 2:
        h_ = np.interp(np.arange(n_), np.nonzero(ok_)[0], h_[ok_])
    else:  # hidden all along (a walkway slung under a higher deck): straight between its ends' ground
        h_ = np.linspace(gd_[0], gd_[-1], n_)
    for win in (61, 31, 15):  # the deck is the lowest surface: knock down what stands on it (a pylon's legs, cables)
        hs_ = ndimage.median_filter(h_, min(win, n_), mode="nearest")
        h_ = np.where(h_ > hs_ + 0.6, hs_, h_)
    prof.append(np.column_stack([P_, h_, np.full(n_, layer + 1)]))
deck_abs = np.zeros((D, W), np.float32)


def _knn(pts, q, k):
    """the k nearest points to each query (distances, indices), ties by the points' order (the same in every region:
    cKDTree's own order among equal distances follows its tree, which follows the points the region holds), nearest
    first; distances to a micrometre (their last bits follow the region's origin)"""
    n = min(k + 6, len(pts))
    d_, k_ = cKDTree(pts).query(q, k=n)
    d_, k_ = d_.reshape(len(q), n), k_.reshape(len(q), n)
    o = np.lexsort((k_, np.round(d_, 6)), axis=-1)[:, :min(k, n)]
    return np.take_along_axis(d_, o, -1), np.take_along_axis(k_, o, -1)
if prof:
    # across the deck the ways agree: one surface per layer, each point the low end (10th percentile) of its layer
    # within 10 m. Each way on its own rounded to a different metre from its neighbour (steps along the deck between
    # the lanes); and where they disagree, the higher ones stand under something -- a cable-stayed bridge's stays lean
    # over the outer lanes for 150 m each side of the pylon, so their profile climbed smoothly to the pylon (no spike
    # for the running median to knock down), and with the median of the lanes the deck rose 23 m in mounds round it
    allp = np.vstack(prof)
    for L_ in np.unique(allp[:, 3]):
        sel_ = allp[:, 3] == L_
        sub_ = allp[sel_]
        nb_ = cKDTree(sub_[:, :2]).query_ball_point(sub_[:, :2], 10.0)
        allp[sel_, 2] = [np.percentile(sub_[i_, 2], 10) for i_ in nb_]
    k0 = 0
    for i_, pw_ in enumerate(prof):
        h_ = allp[k0:k0 + len(pw_), 2]
        n_ = len(h_)
        pw_[:, 2] = region.movmean(ndimage.median_filter(h_, min(25, n_), mode="nearest"), min(15, n_))
        k0 += n_
    # a bridge way often ends (in OSM) metres before the ground climbs back to the deck: the deck carries on along the
    # way's direction, level, until the ground is within 1.5 m of it (up to 15 m) -- no hole for the cars to drop into
    ext_shapes = []
    for (line, hw, layer, col_), pw_ in zip(bridge_lines, list(prof)):
        if len(pw_) < 3:
            continue
        for e0, e1 in ((0, 2), (-1, -3)):
            P0, h0 = pw_[e0, :2], pw_[e0, 2]
            u_ = P0 - pw_[e1, :2]
            u_ = u_ / max(np.linalg.norm(u_), 1e-6)
            ext = []
            for d_ in range(1, 16):
                q = P0 + u_ * d_
                r_, c_ = int(q[1]), int(q[0])
                if not (0 <= r_ < D and 0 <= c_ < W) or dtm[r_, c_] >= h0 - 1.5 or bmask[r_, c_]:
                    break
                ext.append(q)
            if not ext:
                continue
            ext_shapes.append((LineString([P0, ext[-1]]).buffer(max(hw, 1.5), cap_style="flat"), col_, layer + 1))
            prof.append(np.column_stack([np.array(ext), np.full(len(ext), h0), np.full(len(ext), layer + 1)]))
    for L_ in sorted({l for _, _, l in ext_shapes}):
        m_ = np.zeros((D, W), np.uint16)
        burn(m_, [(p_, c_) for p_, c_, l in ext_shapes if l == L_])
        m_ = np.where((m_ > 0) & ~bmask & (deck_lay <= L_) & ~deck, m_, 0)
        deck_col[m_ > 0] = m_[m_ > 0]
        deck_lay[m_ > 0] = L_
        deck |= m_ > 0
    note("bridge ends carried on to meet the ground:", len(ext_shapes))
    prof = np.vstack(prof)
    # where the ground climbs to the deck (an abutment, an embankment the DTM runs up under the deck) the LiDAR stands
    # less than 2 m over it: still the deck, if the surface is at the deck's level (else pits down to the ground)
    abut = (deck_col > 0) & ~bmask & ~deck & ndimage.binary_dilation(deck, iterations=15)
    rr, cc = np.nonzero(deck | abut)
    for L_ in np.unique(deck_lay[rr, cc]):
        sel = deck_lay[rr, cc] == L_
        pts = prof if L_ == 0 or not (prof[:, 3] == L_).any() else prof[prof[:, 3] == L_]
        d_, k_ = _knn(pts[:, :2], np.column_stack([cc[sel] + 0.5, rr[sel] + 0.5]), 12)
        w_ = 1 / np.maximum(d_, 0.5) ** 2  # a smooth surface between the ways: any step is a contour across the deck
        deck_abs[rr[sel], cc[sel]] = (pts[k_, 2] * w_).sum(1) / w_.sum(1)
zt_ = np.round(deck_abs - BASE).astype(np.int32)
if prof is not None and len(prof):
    deck |= abut & (np.abs(dsm_mean - deck_abs) < 1.0)
deck &= zt_ >= g + 1
# a building and a deck in one cell: the LiDAR says which is on top. A building whose roof is at the deck or under it
# stands under the bridge (shops in a viaduct's arcades, a station's halls under an
# avenue: there the carriageway and tram track were drawn as bare roofs); it keeps its walls up to the
# deck. A building rising over the deck stands beside it or on it (the viaduct's towers), and there is no deck in it
_btop = g + topi
_under = deck & bmask & (_btop <= zt_ + 2)
deck &= ~bmask | _under
_ru, _cu = np.nonzero(_under)
for _z in range(int(zt_[_ru, _cu].min()) if len(_ru) else 0, int(_btop[_ru, _cu].max()) + 4 if len(_ru) else 0):
    _m = _z >= zt_[_ru, _cu]
    vol[_z, _ru[_m], _cu[_m]] = 0
note("deck cells over buildings under a bridge:", int(_under.sum()), "building cells that keep the deck out:", int(((deck_col > 0) & bmask & ~_under).sum()))
# a scrap of deck lying on the ground (under 60 cells, no metre of air under any of it: where the ground of a ramp
# dips a metre under its way) is no bridge: it stood as grey slabs and steps on the carriageway
_lab, _n = ndimage.label(deck, np.ones((3, 3), bool))
_scrap = np.zeros((D, W), bool)
if _n:
    _sz = ndimage.sum(deck, _lab, np.arange(1, _n + 1))
    _air = ndimage.maximum(zt_ - 2 - g, _lab, np.arange(1, _n + 1))
    _scrap = np.isin(_lab, 1 + np.nonzero((_sz < 60) & (_air <= 0))[0]) & ~bmask
    deck &= ~_scrap
# a bridge way where no deck is built because the ground comes up to it (the ramp up to the Schanzlbrücke: an
# embankment the terrain model counts as ground, over the passages under it) is drawn on the ground: its carriageway
# and sidewalks had been left out of the ground's colours (bridge ways go on the deck), a pale plaza of default paving.
# Where its level is within 3 m of the ground, on open ground no other way or area is drawn on. (Its level away from
# any deck: the ways' profiles as on the deck)
_bwh = deck_abs.copy()
_rn, _cn = np.nonzero((deck_col > 0) & (deck_abs == 0) & ~bmask)
if len(_rn) and len(prof):
    for L_ in np.unique(deck_lay[_rn, _cn]):
        sel = deck_lay[_rn, _cn] == L_
        pts = prof if L_ == 0 or not (prof[:, 3] == L_).any() else prof[prof[:, 3] == L_]
        d_, k_ = _knn(pts[:, :2], np.column_stack([_cn[sel] + 0.5, _rn[sel] + 0.5]), 12)
        w_ = 1 / np.maximum(d_, 0.5) ** 2
        _bwh[_rn[sel], _cn[sel]] = (pts[k_, 2] * w_).sum(1) / w_.sum(1)
zt_ = np.where(deck_abs > 0, zt_, np.round(_bwh - BASE).astype(np.int32))
_bw = (deck_col > 0) & ~deck & ~bmask & (_bwh > 0) & (zt_ <= g + 2) & (zt_ >= g - 3) \
    & (explicit == 0) & (gcol != C["water"])
_bw |= _scrap & (deck_col > 0)
_bwr = np.zeros((D, W), np.uint8)
burn(_bwr, [(p_, 1) for p_ in bridge_road_polys])
_bwc = deck_col.copy()
_bwc[_bw & (lm > 0) & (_jm == 0) & (deck_col == C["asphalt"])] = C["mark"]
gcol[_bw] = _bwc[_bw]
_rb, _cb = np.nonzero(_bw)
vol[g[_rb, _cb] - 1, _rb, _cb] = _bwc[_rb, _cb]
is_road |= _bw & (_bwr > 0)
note("deck scraps on the ground dropped:", int(_scrap.sum()), "cells; bridge ways drawn on the ground where it reaches "
     "their level:", int(_bw.sum()), "cells")


# the ground at the bridgeheads and under the bridge ways drawn on it (ground.py, phase "decks")
GCTX.__dict__.update(g=g, deck=deck, zt=zt_, bw=_bw, bmask=bmask, veg=veg, water=gcol == C["water"], river_lv=RIVER_LV,
                     on_bridge=on_bridge)
_gn = ground.run(GCTX, "decks")
_bwl = GCTX.changed["bridge_way"]
_rh, _ch = np.nonzero(_gn > g)
if len(_rh):
    # what stood on the old ground (a kerb, a post, a car) rises with it; under it soil, the top keeps its colour, and
    # a side 2 m or more over its neighbour is masonry, as the retaining walls above
    _g0, _g1 = g[_rh, _ch], _gn[_rh, _ch]
    _lift = _g1 - _g0
    # open land no way or area is drawn on had been read as the slope of a pit (a meadow on the hillside): paved, as
    # the bridgehead round it, unless the ortho sees it green
    _pv = (explicit[_rh, _ch] == 0) & (exg[_rh, _ch] <= 0.03) & ~_bwl[_rh, _ch]  # (a bridge way keeps its colours)
    gcol[_rh[_pv], _ch[_pv]] = C["paving"]
    vol[_g0[_pv] - 1, _rh[_pv], _ch[_pv]] = C["paving"]
    _old = np.stack([vol[np.minimum(_g0 - 1 + k, H - 1), _rh, _ch] for k in range(7)])
    for k in range(6, -1, -1):
        _z = _g1 - 1 + k
        _ok = (_z < H) & ((_old[k] != 0) | (_z <= _g0 + 5))  # (air written only where it moved from: not into a crown)
        vol[_z[_ok], _rh[_ok], _ch[_ok]] = _old[k][_ok]
    for k in range(int(_lift.max())):
        _m = k < _lift
        vol[_g0[_m] - 1 + k, _rh[_m], _ch[_m]] = C["soil"]
    _nb = ndimage.minimum_filter(_gn, footprint=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))[_rh, _ch]
    _rp, _cp = _rh + R0, _ch + C0
    for k in range(int((_g1 - _nb).max())):
        _z = _nb + k
        _m = (_z < _g1 - 1) & (_g1 - _nb >= 2)
        _s = ((_rp[_m] + _cp[_m] + (_z[_m] % 2)) // 2 * 2654435761 + _z[_m] * 40503) % 1000003 % len(STONE)
        vol[_z[_m], _rh[_m], _ch[_m]] = np.array(STONE, np.uint16)[_s]
    g = _gn
note("bridgeheads: ground lifted to the dropped surface:", len(_rh), "cells, by", int(_lift.sum()) if len(_rh) else 0,
     "m in all, up to", int(_lift.max()) if len(_rh) else 0, "m")
deck_h = np.where(deck, zt_ - g, 0).astype(np.float32)
# under a deck over the river nothing hangs but the bridge's own structure (landmarks.py): LiDAR columns caught at the
# deck edge (catenary masts, railings, green from the ortho) were extruded into dangling bits; and no tree crown grows
# into the underside of a deck anywhere
_leafy = np.zeros(len(pal.entries) + 64, bool)
_leafy[[i for i, e in enumerate(pal.entries) if e[3] == M_LEAF] + WOOD_IDS] = True
_rw, _cw = np.nonzero(deck)
_wet = water_[_rw, _cw]
for _z in range(int(g.min()), int(zt_.max()) + 6):
    _m = (_z >= g[_rw, _cw]) & (_z < zt_[_rw, _cw] + 6)
    _v = vol[_z, _rw[_m], _cw[_m]]
    _under = _z < zt_[_rw[_m], _cw[_m]] - 2
    vol[_z, _rw[_m], _cw[_m]] = np.where((_under & _wet[_m]) | _leafy[_v], 0, _v)  # (a crown poking through the deck too)
# and beside a deck over the water (3 m): the LiDAR's returns off the deck's edge, green in the ortho, stood as crowns
# hanging from the edge down to the river; no tree grows in the river there
_rim = ndimage.binary_dilation(deck, iterations=3) & ~deck & water_
_rr, _cr = np.nonzero(_rim)
n_rim = 0
for _z in range(int(g.min()), int(zt_.max()) + 6):
    _v = vol[_z, _rr, _cr]
    _k = _leafy[_v]
    vol[_z, _rr[_k], _cr[_k]] = 0
    n_rim += int(_k.sum())
note("leaves off the water beside the decks:", n_rim)
# a railway bridge carries its track across: the rails on the ballast, and ballast (not the grey road deck) between
# tracks and to the deck edges -- the rail bridge read as a road with a step where the track left the embankment
_way = (deck_col > 0) & (deck_col != C["deck"])
_dw, (_iw, _jw) = ndimage.distance_transform_edt(~_way, return_indices=True)
_fill = deck & (deck_col == C["deck"]) & (deck_col[_iw, _jw] == C["ballast"]) & (_dw <= 4)
deck_col[_fill] = C["ballast"]
# the lane markings of the roads on the bridges (they were painted on the ground under the deck)
_lm_deck = deck & (lm > 0) & (deck_col == C["asphalt"])
deck_col[_lm_deck] = C["mark"]
note("lane marking cells on decks:", int(_lm_deck.sum()))
_rl = np.zeros((D, W), np.uint16)
burn(_rl, bridge_rails + rails, all_touched=True)  # (the ground track's too: the deck runs on over the abutments)
_on = deck & (_rl > 0) & np.isin(deck_col, [C["ballast"], C["trambed"]])  # rails lie on a track bed, a tram's too
deck_col[_on] = _rl[_on]
note("rail decks: ballast fill", int(_fill.sum()), "rail cells", int(_on.sum()))
rr, cc = np.nonzero(deck)
if len(rr):
    zt_ = zt_[rr, cc]
    for dz in (1, 2):
        vol[zt_ - dz, rr, cc] = C["deck"]
    vol[zt_ - 1, rr, cc] = deck_col[rr, cc]
note("bridge deck cells:", int(deck.sum()))


stage("fountains, beds, furniture")
# ---------------------------------------------------------------- bridge piers
# The decks stood on nothing between their abutments: the A 3's kilometre over the Danube at Schalding, the rail and
# road bridges, the footbridges over the Ilz floated over the water and the valleys. A pier is a wall across the deck
# (as wide as the deck less PIER_INSET at each edge, PIER_T metres thick along the way) from the deck's underside down
# to the ground, or through the river to its bed. Where OSM maps them (bridge:support=pier nodes: the Marienbrücke),
# or a street override lists the way's spans (overrides.py `piers`, as such nodes: the A 3's Donaubrücke Schalding),
# they stand there (in the river too), and the ways near them get no others. Elsewhere every span metres along each bridge way (by
# bridge:structure -- of the way, or of the man_made=bridge outline it lies in -- and the way's kind; a suspension or
# cable-stayed bridge none, a way shorter than 1.5 spans none: one span), evenly over its length. A pier is left out
# where it would stand in the river more than PIER_WATER metres from the bank (the fairway: the cruise ships, the
# boats, boats.py, keep further out than that), where a pier already stands within a third of a span (twin decks,
# the sidewalks beside a carriageway: one pier under all of them), and cell by cell on a building, on a road, path or
# track under the bridge (with PIER_CLEAR metres beside it: the traffic, the trains and the car pass), under a lower
# bridge's way, and where the deck stands less than PIER_MIN metres over the ground or the water. (The surface models
# do not show piers under the decks: the laser and the DOM see the deck.) Region-local: a way's stations come from its
# whole OSM line, a pier from the cells within PIER_REACH of its station.
PIER_INSET, PIER_WATER, PIER_CLEAR, PIER_MIN, PIER_REACH = 0.75, 25.0, 1.0, 2, 30.0
_rail_kinds = ("rail", "tram", "light_rail", "narrow_gauge", "subway")


def pier_span(t, struct):
    """metres between the piers of a bridge way (tags t, its bridge:structure), or None: no piers"""
    if struct in ("suspension", "cable-stayed", "cable_stayed", "arch", "simple-suspension", "floating"):
        return None  # (an arch, too: it stands on its springings at the banks)
    if struct == "truss":
        return 60.0
    if t.get("railway"):
        return 30.0
    base = (t.get("highway") or "").replace("_link", "")
    if base in ("motorway", "trunk"):
        return 45.0
    if base in ("footway", "path", "cycleway", "steps", "pedestrian", "bridleway", "track"):
        return 20.0
    return 35.0


def bridge_piers():
    deck_top = np.where(deck, np.round(g + deck_h), 0).astype(np.int32)  # the first free voxel over the deck
    wd = ndimage.distance_transform_edt(water_)  # metres from the bank (0 on land)
    clr = np.zeros((D, W), np.uint8)  # ways on the ground (and their margins)
    burn(clr, [(l_.buffer(max(way_width(t_) if t_.get("highway") else 3.8, 2.0) / 2 + PIER_CLEAR), 1)
               for _, t_, l_ in osm.lines if (t_.get("highway") or t_.get("railway") in _rail_kinds)
               and not on_bridge(t_) and not underground(t_)])
    burn(clr, [(g_, 1) for _, _, t_, g_ in osm.areas if t_.get("railway") == "platform"])
    blay = np.zeros((D, W), np.uint16)  # the lowest layer of a bridge way over the cell (+1)
    for oid_, t_, l_, hw_ in sorted(bridge_ways, key=lambda x: -int(layer_of(x[1]) or 1)):
        burn(blay, [(l_.buffer(hw_ + PIER_CLEAR), int(layer_of(t_) or 1) + 1)])
    outlines = [(g_, t_.get("bridge:structure")) for _, _, t_, g_ in osm.areas_with("man_made", ("bridge",))]
    pier = np.zeros((D, W), bool)

    def at(x, y):
        c, r = int(math.floor(x)), int(math.floor(y))
        return (r, c) if 0 <= r < D and 0 <= c < W else None

    def place(line, dist, layer, span, thick, mapped=False):
        """a pier across the deck at dist along line (mapped: OSM's, wherever it stands); False where none stands"""
        p, q = line.interpolate(max(dist - 1, 0)), line.interpolate(min(dist + 1, line.length))
        P = line.interpolate(dist)
        tx, ty = q.x - p.x, q.y - p.y
        tl = math.hypot(tx, ty)
        if tl < 1e-6:
            return False
        tx, ty = tx / tl, ty / tl
        nx, ny = -ty, tx
        ref = None
        for a in (0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2):
            rc = at(P.x + nx * a, P.y + ny * a)
            if rc and deck[rc] and deck_lay[rc] == layer + 1:
                ref = int(deck_top[rc]); break
        rc = at(P.x, P.y)
        if ref is None:
            return False
        if rc is None or (water_[rc] and wd[rc] > PIER_WATER and not mapped):
            return False
        # across the deck: as far as deck of this level goes, over gaps of up to 6 m (between twin carriageways)
        ext = [0.0, 0.0]
        for k, sgn in enumerate((-1, 1)):
            gap = 0.0
            for a in np.arange(0.5, PIER_REACH, 0.5):
                rc = at(P.x + nx * a * sgn, P.y + ny * a * sgn)
                if rc and deck[rc] and abs(int(deck_top[rc]) - ref) <= 2:
                    ext[k], gap = a, 0.0
                else:
                    gap += 0.5
                    if gap > 6:
                        break
        a0, a1 = -ext[0] + PIER_INSET, ext[1] - PIER_INSET
        if a1 - a0 < 1:
            a0, a1 = (a0 + a1) / 2 - 0.5, (a0 + a1) / 2 + 0.5
        # a pier within a third of a span already (another way on the same deck)
        for b in np.arange(-span / 3, span / 3 + 0.01, 1.0):
            for a in np.arange(a0, a1 + 0.01, 1.0):
                rc = at(P.x + nx * a + tx * b, P.y + ny * a + ty * b)
                if rc and pier[rc]:
                    return False
        cells = set()
        for a in np.arange(a0, a1 + 0.01, 0.5):
            for b in np.arange(-thick / 2 + 0.25, thick / 2, 0.5):
                rc = at(P.x + nx * a + tx * b, P.y + ny * a + ty * b)
                if rc and deck[rc] and abs(int(deck_top[rc]) - ref) <= 2:
                    cells.add(rc)
        cells = [rc for rc in sorted(cells) if not bmask[rc] and not clr[rc] and not (0 < blay[rc] < layer + 1)
                 and deck_top[rc] - 2 - g[rc] >= PIER_MIN]
        if not cells:
            return False
        for rc in cells:
            pier[rc] = True
        return True

    n_osm = n_der = 0
    supports = [p_ for _, t_, p_ in osm.nodes if t_.get("bridge:support") == "pier"]
    mapped = set()
    for p_ in supports:
        near = [(l_.distance(p_), i, oid_, t_, l_, hw_) for i, (oid_, t_, l_, hw_) in enumerate(bridge_ways)
                if l_.distance(p_) <= hw_ + 10]
        for _, i, *_ in near:
            mapped.add(i)
        if near:
            _, i, oid_, t_, l_, hw_ = min(near, key=lambda x: (x[0], x[2]))
            n_osm += place(l_, l_.project(p_), int(layer_of(t_) or 1), 20.0, 2.0, True)
    order = sorted(range(len(bridge_ways)), key=lambda i: (-bridge_ways[i][2].length, bridge_ways[i][0]))
    for i in order:
        if i in mapped:
            continue
        oid_, t_, l_, hw_ = bridge_ways[i]
        struct = t_.get("bridge:structure")
        if struct is None:
            mid = l_.interpolate(0.5, normalized=True)
            struct = next((s_ for o_, s_ in outlines if s_ and o_.contains(mid)), None)
        span = pier_span(t_, struct)
        if span is None or l_.length < 1.5 * span:
            continue
        n = int(round(l_.length / span))
        thick = 2.0 if span >= 30 else 1.0
        for k in range(1, n):
            n_der += place(l_, l_.length * k / n, int(layer_of(t_) or 1), span, thick)
    # down from the deck's underside through the air and the river to the ground or the bed
    rr, cc = np.nonzero(pier)
    top = deck_top[rr, cc] - 2
    z = top - 1
    act = z >= 0
    n_vox = 0
    while act.any():
        v = vol[np.maximum(z, 0), rr, cc]
        ok = act & ((v == 0) & (z >= g[rr, cc]) | (v == C["water"]))
        vol[z[ok], rr[ok], cc[ok]] = C["pier"]
        n_vox += int(ok.sum())
        act = ok & (z > 0)
        z = z - 1
    note(f"bridge piers: {n_osm} from OSM, {n_der} derived; {len(rr)} cells, {n_vox} voxels")
    return pier


bridge_piers()
# bridge pylons (a cable-stayed bridge's mast): compact LiDAR blobs far above the deck inside a bridge
pyl = (bridge_area > 0) & (nd_max > np.where(deck_h > 0, deck_h, nd_mean) + 45) & ~bmask  # the stays fan out low; only the mast stands this high
pyl = ndimage.binary_opening(pyl, iterations=2)  # the cable-stay fan is a thin sheet in the LiDAR; the mast is thick
lab_, n_ = ndimage.label(pyl)
n_pyl = 0
for i_, sl in enumerate(ndimage.find_objects(lab_), 1):
    m_ = lab_[sl] == i_
    if m_.sum() < 6 or max(m_.shape) > 25:  # a mast is compact; a long sheet is the cable fan
        continue
    for r_, c_ in zip(*np.nonzero(m_)):
        r_, c_ = r_ + sl[0].start, c_ + sl[1].start
        z0_, z1_ = int(g[r_, c_]), int(g[r_, c_] + round(float(nd_max[r_, c_])))
        vol[z0_:z1_, r_, c_] = np.where(vol[z0_:z1_, r_, c_] == 0, C["fence"], vol[z0_:z1_, r_, c_])
    n_pyl += 1
note("bridge pylons from LiDAR:", n_pyl)
# lamps on the bridges: OSM often maps none on the river bridges, but they
# are lit -- put one every 32 m on each kerb of the deck, unless OSM has a lamp within 12 m (none on a dark road's
# bridge: ways.unlit, as the streets' lamps). A kerb is
# deck that carries no way of its own, with no carriageway or track within 4 m beyond it: the inner side of a
# carriageway with tram tracks beside it has none, and its lamps stood in the trams' way
_bed = np.isin(deck_col, [C["asphalt"], C["mark"], C["trambed"], C["ballast"], C["rail"]])
# OSM's lamps by the bridge ways (street furniture above) stand on the deck's top: on the nearest deck cell off the
# carriageway and the tracks within 4 m of the node, else on the deck cell nearest the kerb (the edge of a deck that
# is carriageway from edge to edge). One as near a way on the ground as the bridge way (by a street under the bridge)
# stands on the ground, where no deck over it or right beside it is lower than its head; and one with no deck within
# 4 m too
_od, (_oi, _oj) = ndimage.distance_transform_edt(~deck, return_indices=True)
_of, (_fi, _fj) = ndimage.distance_transform_edt(~(deck & ~_bed), return_indices=True)
n_ol = 0
for oid, t, p, d_br, d_gr in bridge_lamps:
    c0, r0 = int(p.x), int(p.y)
    kc, kr = kerb(c0, r0) or (c0, r0)
    hgt = lamp_height(t, kc, kr)
    room = _od[kr, kc] > 1.5 or deck_h[_oi[kr, kc], _oj[kr, kc]] >= hgt + 1  # (no deck over or beside the post under its head)
    if _od[r0, c0] <= 4 and not (room and d_gr <= d_br + 1.5):
        r, c = (int(_fi[r0, c0]), int(_fj[r0, c0])) if _of[r0, c0] <= 4 else (int(_oi[kr, kc]), int(_oj[kr, kc]))
        if not bmask[r, c]:
            stand_lamp(c, r, int(g[r, c] + round(float(deck_h[r, c]))), hgt, [0, oid])
            n_ol += 1
    elif kerb(c0, r0) and not bmask[kr, kc]:
        stand_lamp(kc, kr, int(g[kr, kc]), hgt, [0, oid])
note("OSM's lamps by the bridge ways:", n_ol, "on the decks,", len(bridge_lamps) - n_ol, "on the ground or none")
n_bl = 0
for line, w, i_br in bridge_roads:
    for k_, dist in enumerate(np.arange(10, line.length - 6, 32.0)):
        p = line.interpolate(dist)
        q_ = line.interpolate(min(dist + 1, line.length))
        tx, ty = q_.x - p.x, q_.y - p.y
        tl = max(np.hypot(tx, ty), 1e-6)
        for side in (-1, 1):
            off = side * (w / 2 + 0.4)
            c, r = int(p.x - ty / tl * off), int(p.y + tx / tl * off)
            if not (0 <= c < W and 0 <= r < D) or not deck[r, c] or _bed[r, c]:
                continue
            if any(_bed[min(max(int(p.y + tx / tl * (off + side * d_)), 0), D - 1), min(max(int(p.x - ty / tl * (off + side * d_)), 0), W - 1)]
                   for d_ in (1, 2, 3, 4)):
                continue
            if len(lamp_xy) and np.min(np.hypot(lamp_xy[:, 0] - c, lamp_xy[:, 1] - r)) < 12:
                continue
            z0 = int(g[r, c] + round(float(deck_h[r, c])))
            vol[z0:z0 + 8, r, c] = np.where(vol[z0:z0 + 8, r, c] == 0, C["pole"], vol[z0:z0 + 8, r, c])
            vol[z0 + 8, r, c] = C["lamp"]
            lamps.append((c, r, int(z0 + 8)))
            LAMP_KEYS.append([2, i_br, k_, side])
            lamp_xy = np.vstack([lamp_xy, [c, r]])
            n_bl += 1
note("inferred lamps on bridge decks (OSM has almost none):", n_bl)

# ---------------------------------------------------------------- vehicles frozen from the surface model + ortho
# only parked cars stay frozen; cars caught mid-carriageway by the survey flight are replaced by the live simulation
veh = (~bmask) & (~veg) & (parking_mask > 0) & (nd_mean > 1.1) & (nd_mean < 4.2)
lab, n = ndimage.label(veh)
objs = ndimage.find_objects(lab)
n_cars = n_bus = 0
for i, sl in enumerate(objs, 1):
    m = lab[sl] == i
    area = int(m.sum())
    if area < 4 or area > 70:
        continue
    rr, cc = np.nonzero(m)
    rr, cc = rr + sl[0].start, cc + sl[1].start
    hmean = float(nd_mean[rr, cc].mean())
    col = np.median(cellcol[rr, cc], axis=0)
    hsv = list(colorsys.rgb_to_hsv(*(col / 255)))
    hsv[1] = min(1, hsv[1] * 1.4)
    hsv[2] = min(1, hsv[2] * 1.1)
    col = tuple(int(v * 255) for v in colorsys.hsv_to_rgb(*hsv))
    idx = pal(col, M_CAR, q=16)
    big = area > 22 and hmean > 2.4
    z0 = g[rr, cc]
    vol[z0, rr, cc] = idx
    if big:
        vol[z0 + 1, rr, cc] = idx
        vol[z0 + 2, rr, cc] = pal((235, 235, 235), M_CAR)
        n_bus += 1
    else:
        # cabin: inner cells only
        er = ndimage.binary_erosion(m)
        r2, c2 = np.nonzero(er)
        if len(r2):
            vol[g[r2 + sl[0].start, c2 + sl[1].start] + 1, r2 + sl[0].start, c2 + sl[1].start] = pal((60, 72, 86), M_GLASS)
        n_cars += 1
note("vehicles from LiDAR:", n_cars, "cars,", n_bus, "buses/trams/trucks")

# churches' walls are the plain classic material (no grid of office storeys): without windows of their own they read
# as blank blocks. Tall windows on every straight outer edge, a second
# row under the eaves of the tall ones; curated churches (passau.py) redraw theirs later
_win = pal((58, 70, 68), 21)
n_cw = 0
for f in render:
    t_ = f["tags"]
    if f["part"] or f["geom"].geom_type != "Polygon" or len(f["rr"]) < 150 or \
            not (t_.get("building") in SACRED or t_.get("amenity") == "place_of_worship"):
        continue
    h30 = float(np.percentile(topi[f["rr"], f["cc"]], 30))
    if h30 < 9:
        continue
    rows = [(3, int(min(7, h30 - 5)))] + ([(int(h30) - 7, 4)] if h30 >= 20 else [])
    n_cw += landmarks.edge_windows(vol, g, f["geom"], _win, rows, 4.5)
note("church windows:", n_cw)

stage("bridge piers, vehicles")
# ---------------------------------------------------------------- curated landmark details
landmarks.apply_zones(vol, g, feats, pal, bmask, note)
overrides.apply_details(vol, g, feats, pal, note)  # the building overrides' windows and parts (parts.py)
# rooms: the curated ones (interiors.ROOMS, none yet) carved out of the buildings now standing, and recorded (the tiles'
# room sections; the distance levels fill them again)
import interiors
interiors.build(vol, R0, C0, note)
# where a hanging building piece may carry its walls down (1: inside a building outline) or needs posts (2: roof-only)
bkind = np.zeros((D, W), np.uint8)
ROOFY = {"roof", "carport", "canopy", "shelter"}
for f in feats:  # walls may come down only inside an outline that itself stands on the ground (not a part on stilts,
    # not a raised passage: a connector 4-9 m over the street got filled solid to the ground)
    if not f["part"] and (f["minh"] or 0) < 2.5 and f["tags"].get("building") not in ROOFY:
        bkind[f["rr"], f["cc"]] = 1
for f in feats:
    if f["tags"].get("building") in ROOFY or f["tags"].get("building:part") == "roof":
        bkind[f["rr"], f["cc"]] = 2
import tunnels
_bores = tunnels.plan(osm, g)  # roads and paths through the hills (the B 12 under the Georgsberg): bored below
import underpass
underpass.SKIP = set(tunnels.IDS)
underpass.build(vol, g, pal, C, osm, note)
carriageway_sanity(lambda r, c: vol[g[r, c] - 1, r, c], "after the underpasses")
RESULT["labels"] = landmarks.details(vol, g, topi, feats, pal, osm, cells_of, note)  # (labels.py finishes them: regions.py)
tunnels.build(vol, g, pal, C, STONE, note, _bores)  # (after the set pieces: the curtain wall stands over the bore)

stage("landmark details, underpasses, tunnels")
# ---------------------------------------------------------------- floating debris
import debris
debris.drop_debris(vol, g, np.array([i for i, e in enumerate(pal.entries) if e[3] == M_LEAF] + WOOD_IDS, dtype=vol.dtype), note, dbg=RDIR)

stage("drop_debris")
# ---------------------------------------------------------------- export
Hm = int(np.nonzero(vol.reshape(H, -1).any(axis=1))[0].max()) + 1
vol = vol[:Hm]
note("final height", Hm, "palette", len(pal.entries))
stage("height crop")
# the three rivers in their own colours, as the orthophoto shows them: the Danube dark green, the Inn milky grey-green
# from the glaciers, the Ilz peat-black, and the bands running side by side below the Dreiflüsseeck. Per 8 m block the
# median of the open water's cells (10 m off the banks, ships, bridges and their shadows' worst), a block with none
# taking the nearest block's within 32 m (else WATER_RGB, a pond far from the rivers), smoothed over ~50 m and drawn
# between the blocks' centres (blocks of the project grid: the same colours in every region)
WATER_RGB = (104, 128, 112)
_ri, _ci = np.arange(D)[:, None], np.arange(W)[None, :]
_wm = vol[g - 1, _ri, _ci] == C["water"]
_cov = vol[np.minimum(g, Hm - 1), _ri, _ci] != 0
_open = ndimage.binary_erosion(_wm, iterations=10) & ~ndimage.binary_dilation(_cov & _wm, iterations=10)
_B = 8
assert R0 % _B == 0 and C0 % _B == 0 and D % _B == 0 and W % _B == 0
_blk = np.where(_open[..., None], cellcol, np.nan).reshape(D // _B, _B, W // _B, _B, 3)


def _block_median(blk):
    # in a function, not at module level: numpy warns once per all-NaN block (150 000 a region), and each warning,
    # ignored or not, looks up its caller's line -- at the end of this module's body ~90 us each, 460 s summed over
    # the map's regions (docs/plans/build-speed-2.md F1)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmedian(blk, axis=(1, 3))


_bc = _block_median(_blk)
_has = np.isfinite(_bc[..., 0])
if _wm.any():
    _bd, _near = ndimage.distance_transform_edt(~_has, return_indices=True) if _has.any() else \
        (np.full(_has.shape, np.inf), np.indices(_has.shape))
    _bc = np.where((_bd <= 4)[..., None], _bc[_near[0], _near[1]], np.array(WATER_RGB, float))
    _bc = np.stack([ndimage.gaussian_filter(ndimage.median_filter(_bc[..., k], 5), 2.5) for k in range(3)], -1)

    def _lerp(n, nb):  # cell -> the two blocks round it and the weight of the second
        t = (np.arange(n) + 0.5) / _B - 0.5
        i0 = np.floor(t).astype(int)
        return np.clip(i0, 0, nb - 1), np.clip(i0 + 1, 0, nb - 1), (t - i0)
    _r0, _r1, _fr = _lerp(D, D // _B)
    _c0, _c1, _fc = _lerp(W, W // _B)
    _wc = np.zeros((D, W, 3))
    for k in range(3):
        _a = _bc[..., k]
        _row = _a[_r0] * (1 - _fr[:, None]) + _a[_r1] * _fr[:, None]
        _wc[..., k] = _row[:, _c0] * (1 - _fc[None]) + _row[:, _c1] * _fc[None]
    # the ortho's water is sunlit and flat: a little darker and richer, as the rivers look from the Oberhaus
    _wc = np.clip((_wc.mean(-1, keepdims=True) + (_wc - _wc.mean(-1, keepdims=True)) * 1.5) * 0.82, 0, 255)
    _wc = _wc * np.array([0.80, 1.0, 0.98])  # and the red taken down: the ortho's glare reads the Inn's jade as concrete grey
    _q = (np.round(_wc[_wm] / 8) * 8).astype(np.int32)
    _uq, _inv = np.unique(_q, axis=0, return_inverse=True)
    _wid = np.array([pal(tuple(int(v) for v in u), M_WATER, q=8) for u in _uq], vol.dtype)
    vol[(g - 1)[_wm], np.nonzero(_wm)[0], np.nonzero(_wm)[1]] = _wid[_inv.ravel()]
    note(f"river colours from the ortho: {len(_uq)} shades over {int(_wm.sum())} water cells")
stage("river colours")
# the ground as the tiles show it before the foliage (grass as bare earth), for terrain.py: the first moment of loading
_ids = vol[g - 1, np.arange(D)[:, None], np.arange(W)[None, :]]
_lut = np.array([e[:3] for e in pal.entries], np.uint8)
_lut[[i for i, e in enumerate(pal.entries) if e[3] == M_GRASS]] = _lut[C["bare"]]
CORE_OUT = dict(g=tunnels.surface(g).astype(np.int16), rgb=_lut[_ids], water=_wm, b=np.where(bmask, topi, 0).astype(np.int16))  # (b: building height above ground, photo-pose tools)
# the buildings' footprints as drawn (OSM outlines moved onto LoD2's, align_to_lod2): the OSM id of the outline each
# building cell belongs to, for zones.py and windows.py
_fp = np.zeros((D, W), np.int64)
for f in sorted([f for f in feats if not f["part"]], key=lambda f: -f["area"]) + [f for f in render if f["part"] and f.get("parent")]:
    k_ = bmask[f["rr"], f["cc"]]
    _fp[f["rr"][k_], f["cc"][k_]] = (f["parent"] if f["part"] else f)["id"]
CORE_OUT["oid"] = _fp
import tiles
EXPORT_IDS = dict(face_ids={i for i, e in enumerate(pal.entries) if e[3] == M_CLOCK},
                         fol_ids={i for i, e in enumerate(pal.entries) if e[3] == M_LEAF} | set(WOOD_IDS),
                         grass_ids={i for i, e in enumerate(pal.entries) if e[3] == M_GRASS}, bare_id=C["bare"],
                         wall_ids=[i for i, e in enumerate(pal.entries) if e[3] in tiles.WALL_MATS])
stage("ground rgb, footprints")
# nothing hangs in the air: crowns get trunks, building pieces walls or posts, specks go (debris.support_floating)
debris.support_floating(vol, g, pal, bkind, note, C["trunk"], C["pole"], trunk_ok=trunk_ok_db, dbg=RDIR)
stage("support_floating")


def plane_codes():
    """Per column, the roof plane its top face lies in (ROOF_GX/GY), coded as mesher.worker.ts lights a roof: 1 + slope
    (2.5 degree steps, 10 to 75) x 64 + downhill direction (64 steps); 0 where flat, not known, or the column's top is
    not that roof's voxel any more (a landmark rebuilt over it, a rooftop structure, a canopy). The viewer estimated the
    plane from the voxel steps, which a slope rounded to whole metres turns into noise."""
    fol = np.zeros(65536, bool)
    fol[sorted(EXPORT_IDS["fol_ids"] | EXPORT_IDS["grass_ids"])] = True
    roofm = np.zeros(65536, bool)
    roofm[[i for i, e in enumerate(pal.entries) if e[3] == M_ROOF]] = True
    ztop = np.full((D, W), -1, np.int32)
    tv = np.zeros((D, W), np.uint16)
    for z in range(vol.shape[0]):
        v = vol[z]
        k = (v != 0) & ~fol[v]
        ztop[k] = z
        tv[k] = v[k]
    ok = bmask & (ztop == zt - 1) & roofm[tv] & np.isfinite(ROOF_GX) & np.isfinite(ROOF_GY)
    gx_, gy_ = np.nan_to_num(ROOF_GX), np.nan_to_num(ROOF_GY)
    k = np.minimum(30, np.floor(np.arctan(np.hypot(gx_, gy_)) / (np.pi / 72) + 0.5)).astype(np.int32)
    az = (np.floor(np.arctan2(-gy_, -gx_) / (np.pi / 32) + 0.5).astype(np.int32) + 64) % 64
    code = np.where(ok & (k >= 4), 1 + k * 64 + az, 0).astype(np.uint16)
    note("roof plane codes shipped:", int((code > 0)[CORE_SL].sum()), "columns of", int(bmask[CORE_SL].sum()),
         "building columns in the core;", "known plane but top changed:", int((bmask & np.isfinite(ROOF_GX) & ~ok)[CORE_SL].sum()))
    return code


PLANES = plane_codes()
stage("plane codes")
# the core's nodes (tiles.export_window: from the region's volume, the same bytes as from the whole map's)
import window
from aoi import MAP_D, MAP_W
_kr0, _kr1, _kc0, _kc1 = aoi_core = (CORE_SL[0].start + MR0, CORE_SL[0].stop + MR0, CORE_SL[1].start + MC0, CORE_SL[1].stop + MC0)  # (map cells)
_win = window.Window(_kr0, _kr1, _kc0, _kc1, MAP_D, MAP_W)
_ea, _eb, _ec, _ed = _win.region(tiles.HALO)  # (the core and the nodes' apron: all the export reads)
_es = (slice(_ea - MR0, _eb - MR0), slice(_ec - MC0, _ed - MC0))
RESULT["tiles"] = {str(k): v for k, v in tiles.export_window(vol[(slice(None),) + _es], g[_es], PLANES[_es], (_ea, _eb, _ec, _ed),
                                                            _win, OUT / "tiles", levels=[lv["s"] for lv in tiles.manifest(MAP_D, MAP_W)],
                                                            rooms=interiors.runs(_es[0].start, _es[0].stop, _es[1].start, _es[1].stop),
                                                            **EXPORT_IDS).items()}
stage("tiles.export_window")
# drivable-surface mask (1 = carriageway/road area, 2 = rails / track bed): regions.py writes it as qa_roadmask.bin.gz
qa = np.zeros((D, W), np.uint8)
qa[is_road] = 1
qa[np.isin(gcol, [C["trambed"], C["rail"]])] = 2
CORE_OUT["qa"] = qa
# what traffic.py drives on (regions.py runs it over the map): vehicles on a bridge way take the deck under them, or
# the nearest deck cell within 2 m (a way's centreline can run just off the deck)
_dd, (_ir, _ic) = ndimage.distance_transform_edt(~deck, return_indices=True)
deck_near = np.where(_dd <= 2, deck_h[_ir, _ic], 0).astype(np.float32)
# off the deck mask, on a bridge way (a viaduct whose arches are OSM buildings, a deck end): the top of what the
# voxels hold there -- lamps, poles and leaves aside -- within the LiDAR's reach
_skip = np.zeros(len(pal.entries) + 64, bool)
_skip[[i for i, e in enumerate(pal.entries) if e[3] in (M_LEAF, M_LAMP, M_CAR)] + WOOD_IDS + [C["pole"], C["fence"]]] = True
_rb, _cb = np.nonzero((deck_col > 0) & (_dd > 2))
_lim = g[_rb, _cb] + np.clip(np.round(nd_mean[_rb, _cb]), 0, 40).astype(int) + 3
_top = g[_rb, _cb].copy()
for _z in range(int(g.min()), int(_lim.max()) + 1 if len(_lim) else 0):
    _m = (_z >= g[_rb, _cb]) & (_z < _lim) & (_z < vol.shape[0])
    _v = vol[np.minimum(_z, vol.shape[0] - 1), _rb[_m], _cb[_m]]
    _top[np.nonzero(_m)[0][(_v != 0) & ~_skip[_v]]] = _z + 1
deck_near[_rb, _cb] = _top - g[_rb, _cb]
CORE_OUT["deck_near"] = deck_near
CORE_OUT["twater"] = (gcol == C["water"]) & (_dd <= 2)
CORE_OUT["floor"] = tunnels.FLOOR if tunnels.FLOOR is not None else np.full((D, W), -1, np.int16)
CORE_OUT["walk"] = underpass.WALK
# the continuous surfaces the voxels were rounded from, for the sloped caps (caps.py, via regions.py data/surface.npz;
# docs/plans/surface-caps.md): nothing here decides, it only keeps what was computed. gt: the ground as the tiles have
# it (grnd: a bore's floor, not the hill over it as g above); deck: a deck's surface where it is built (m over BASE,
# NaN elsewhere); roof_z: the roof's height at the cell's middle where its plane is known (the float zt was rounded
# from), roof_gx / roof_gy: its rise per metre east / south (NaN: unknown)
CORE_OUT["gt"] = g.astype(np.int16)
CORE_OUT["deck"] = np.where(deck, deck_abs - BASE, np.nan).astype(np.float32)
_rk = (PLANES > 0) | np.isfinite(ROOF_GX)
CORE_OUT["roof_z"] = np.where(_rk, _roof_f, np.nan).astype(np.float32)
CORE_OUT["roof_gx"], CORE_OUT["roof_gy"] = ROOF_GX.astype(np.float32), ROOF_GY.astype(np.float32)
# gsrc: the ground's surface where it was lifted to the surface model (SAG_SRC: a carriageway on a structure the terrain
# model left out; m over BASE, NaN elsewhere): the caps take it there instead of the terrain model
CORE_OUT["gsrc"] = SAG_SRC
note("surface exports: deck cells", int(deck[CORE_SL].sum()), "roof cells with a plane", int(_rk[CORE_SL].sum()),
     "of them rounded off their top:", int((_rk & bmask & (np.round(np.nan_to_num(_roof_f)) != zt))[CORE_SL].sum()))
_lines = {oid: l_ for oid, _, l_ in osm.lines}


def _owned(oid):
    """a way is the region's whose middle lies in its core (regions.py: each way's decision from one region)"""
    p_ = _lines[oid].interpolate(0.5, normalized=True)
    return in_core(int(p_.y), int(p_.x))


RESULT.update(open_cut=sorted(o for o in OPEN_CUT if _owned(o)), bore_ids=sorted(o for o in tunnels.IDS if _owned(o)),
              walk_ids=sorted(o for o in underpass.IDS if _owned(o)))
# debug: top-down colour of the highest voxel, the ground's classes (regions.py: data/debug/topdown.png, ground.png)
# (layer by layer: a bool copy of the whole volume was the region's peak, ~0.6 GB; an empty column gets Hm - 1 as before)
topz = np.full(vol.shape[1:], Hm - 1, np.int64)
for _z in range(Hm):
    topz[vol[_z] != 0] = _z
topv = np.take_along_axis(vol, topz[None], 0)[0]
palarr = np.array([e[:3] for e in pal.entries], np.uint8)
CORE_OUT["topdown"] = np.clip(palarr[topv] * np.clip(0.55 + topz / 120, 0, 1.2)[..., None], 0, 255).astype(np.uint8)
CORE_OUT["groundcol"] = palarr[gcol]
# this region's core: the rasters (crowns' owners on the 2 m grid), the volume (for traffic.py and the labels: regions.py),
# the lists in the map's order (lamps, jets), the palette's new colours
_k2 = tuple(slice(sl.start // 2, sl.stop // 2) for sl in CORE_SL)
stage("qa, deck_near, topdown")
np.savez(RDIR / "core.npz", crowns=_best[_k2], **{k: v[CORE_SL] for k, v in CORE_OUT.items()})
stage("core.npz")
import mapstore
mapstore.save_volume(RDIR / "vol.npz", vol[(slice(None),) + CORE_SL])  # (compressed, in 128 m column blocks)
stage("vol.npz")
(RDIR / "vol.npy").unlink(missing_ok=True)  # (as it was kept before)
# (the registry's new colours: those the core uses -- one met only in the halo, which another region builds, is not
# this region's to add)
_used = set(np.unique(vol[(slice(None),) + CORE_SL]).tolist())
_gc = CORE_OUT["g"][CORE_SL].astype(np.int64)  # (a histogram of the core's ground: the map's median, regions.py)
RESULT["g_hist"] = [int(_gc.min()), np.bincount((_gc - _gc.min()).ravel()).tolist()]
RESULT.update(core=list(aoi_core), Hm=Hm, new_palette=[list(e) for e in pal.new if pal.index[e] in _used], ids=dict(trunk=C["trunk"], pole=C["pole"], fence=C["fence"]), sanity=SANITY,
              lamps=[[k_, [c + MC0, r + MR0, z_]] for (c, r, z_), k_ in zip(lamps, LAMP_KEYS) if in_core(r, c)],
              jets=[[k_, j_] for k_, j_ in jets if in_core(k_[1] - R0, k_[2] - C0)], notes=report["notes"],
              osm_timestamp=osm.timestamp)
import region_inputs
RESULT["deps"] = region_inputs.deps_of_process()
RESULT["features_used"] = FEATURE_USED  # (the large features' decisions it took: regions.py rebuilds it when one changes)  # (the code this region read: regions.py rebuilds it when that changes)
stage("palette, lists")
json.dump(RESULT, open(RDIR / "out.json", "w"))
print("done")
