"""The pipeline's checks, run on a fixture map: a MAP_CONFIG of ~2 km² round the Altstadt (scripts/fixtures/), built
with the normal pipeline from the same data/raw in workspaces of its own (data/check/<fixture>/), so that what a check
costs does not grow with the map of scripts/map.json.

usage: uv run python scripts/check.py COMMAND [ARGS] [--fixture PATH] [-j JOBS] [--keep]

  verify                        hard checks on the fixture's build: nothing floating left, carriageways
                                in their own colour, LoD2 and the laser scan found where they should be, the moving
                                things on the volume's surface (sunk / hover shares under a threshold), the sloped
                                caps (carriageway share, roughness, edge mismatches), and local road defects
  golden --record DIR           every output of a fresh fixture build (web/public/data, data/*.npz arrays, data/*.bin,
  golden --compare DIR          the inputs prep/lod2/laser.npz) hashed into DIR/golden.json, or compared with it: the
                                guard of a refactor that must not change a byte. --incremental: build in the kept
                                workspace instead of from scratch
  covers [COVER ...]            voxelize.py over the fixture as one region and over each cover (NXxNY or a size in
                                metres; default 2x2), then the Python steps after it: every output the same bytes. The
                                first cover is then built again: with nothing changed nothing may be built
                                (--no-incremental skips it), and with region 0_0 built again alone (--only) the
                                outputs must still be the same and no node file written again
  windows [STEP ...]            each windowed step (zones terrain tile_fields tiles_lod by default) over the whole
          [--covers C,C,..]     fixture and over each cover (default 2x2: both seams and a corner): the same bytes
  extent [--other PATH]         the fixture and a larger one (default scripts/fixtures/altstadt_wide.json: 1024 m more
                                to the west): every 128 m block of the volume (the regions' vol.npz) and every node of
                                the tiles (voxel sections) whose surroundings within region.HALO are the same in both
                                maps (the same map edge, or no edge that near) must hold the same voxels, colour by
                                colour -- what growing the map relies on
  all                           verify, covers, windows, extent
  build                         only the fixture's workspace (data/check/<name>/base), incrementally

The workspace of a fixture (data/check/<name>/base, kept between runs: built again only where code or inputs changed)
holds a copy of scripts/ (some steps write beside their script), data/raw linked, the inputs prep, lod2, laser.npz
built for the fixture (cached in data/check/<name>/inputs/ per code and config), and the outputs where the pipeline
puts them. covers, windows and golden work in scratch folders beside it (removed after, unless --keep). Not run: the
node steps (web/tools/tris.mjs, lamps.mjs) and climate.py (it fetches).

Runtime on the Altstadt fixture (WSL, 20 cores, -j 2, measured 2026-11-20 with other builds running): the inputs ~1 min
(once per code and config), a build from nothing ~5 min (two 1024 m regions ~3.5 min each, two thin ones ~30 s, the
steps after it 20 s), verify on a built workspace 4 s, covers ~12-16 min (the fixture as one region ~4 min at 4.2 GB),
windows ~9 min (tiles_lod.py ~4 min a run, the other steps seconds), extent ~6.5 min the first time (the wide
fixture's 6 regions) then seconds, golden ~5 min. Every command prints its time and peak RAM of a process and exits
1 if a check fails. (2026-11-21: golden --compare ~2 min each, voxelize 50-80 s and
the steps after it, side by side, ~50 s; the three fixtures' goldens have a workspace each and run as three shell jobs
at once, `cmd & cmd & wait`, in ~2.2 min at ~2.7 GB a process.)
"""
import ast
import hashlib
import json
import os
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from constants import M_CAR, M_LAMP, M_LEAF

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
PUB = "web/public/data"
CHECK = ROOT / "data" / "check"
FIXTURE = SCRIPTS / "fixtures" / "altstadt.json"
WIDE = SCRIPTS / "fixtures" / "altstadt_wide.json"
INPUTS = {"prep": "data/prep.npz", "lod2": "data/lod2.npz", "laser": "data/laser.npz"}  # (built in this order)
AFTER = ["places", "flood", "boats", "terrain", "zones", "objects", "windows", "phenology", "tile_fields"]
DROP_ENV = ("MAP_CONFIG", "FORCE", "NO_LOD2", "NO_LASER", "NO_SPECIES_MAP", "FINALDUMP", "TRAFFICDUMP", "OSM_REFRESH", "PYTHONPATH")
# per windowed step: what it reads (copied: the step rewrites some in place; or linked) and writes (window.py)
WSTEPS = {
    "zones": dict(copy=[f"{PUB}/meta.json"], link=["data/raw", "data/footprints.npz"],
                  out=["data/zones.bin", f"{PUB}/zones.json"]),
    "terrain": dict(copy=[f"{PUB}/meta.json"], link=["data/ground.npz"], out=["data/terrain.bin", f"{PUB}/terrain"]),
    "tile_fields": dict(copy=[f"{PUB}/meta.json", f"{PUB}/tiles", f"{PUB}/windows.bin"],
                        link=["data/zones.bin", "data/river.bin", "data/foliage.bin", "data/surface.npz", "data/prep.npz",
                              "data/ground.npz", "data/qa_roadmask.bin.gz"], out=[f"{PUB}/tiles", f"{PUB}/meta.json"],
                        whole=["-j", "1"]),  # (else windows of 1024 m in a pool)
    "tiles_lod": dict(copy=[f"{PUB}/meta.json", f"{PUB}/tiles"], link=[], out=[f"{PUB}/tiles", f"{PUB}/meta.json"]),
}


class Failed(Exception):
    pass


# ---------------------------------------------------------------- fixtures and workspaces

class Fixture:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.cfg = json.loads(self.path.read_text())
        self.name = self.path.stem
        m = self.cfg["map"]
        self.row0, self.col0, self.D, self.W = m["row0"], m["col0"], m["rows"], m["cols"]
        self.home = CHECK / self.name

    def cover(self, size="config"):
        import aoi
        import window
        boxes = aoi.built_boxes(self.cfg)
        boxes = None if boxes == [(0, self.D, 0, self.W)] else tuple(boxes)
        return window.cover(self.D, self.W, self.cfg.get("regions", {}).get("size") if size == "config" else size, boxes)


def env_for(ws, fx):
    env = {k: v for k, v in os.environ.items() if k not in DROP_ENV and not k.startswith("VOXEL_")}
    env.update(PYTHONPATH=str(ws / "scripts"), MAP_CONFIG=str(ws / "fixture.json"))
    return env


def run(ws, fx, script, args=(), log=None, scripts=None):
    """scripts/<script>.py of the workspace (or of `scripts`) with cwd ws, its output into ws/log_<script>.txt"""
    log = ws / f"log_{log or script}.txt"
    with open(log, "w") as fh:
        p = subprocess.run([sys.executable, str((scripts or ws / "scripts") / f"{script}.py"), *map(str, args)], cwd=ws,
                           env=env_for(ws, fx), stdout=fh, stderr=subprocess.STDOUT)
    if p.returncode:
        tail = log.read_text().splitlines()[-15:]
        raise Failed(f"{script}.py {' '.join(map(str, args))} failed in {ws} (exit {p.returncode}):\n  " + "\n  ".join(tail))
    return log


def import_closure(names):
    """the scripts/*.py files that scripts `names` import, transitively"""
    seen, todo = set(), list(names)
    while todo:
        n = todo.pop()
        f = SCRIPTS / f"{n}.py"
        if n in seen or not f.exists():
            continue
        seen.add(n)
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Import):
                todo += [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                todo.append(node.module.split(".")[0])
    return sorted(seen)


def raw_fingerprint():
    """data/raw's files (names, sizes, mtimes; one level of folders down): what the build reads of it, roughly"""
    raw = ROOT / "data" / "raw"
    out = []
    for f in sorted(raw.iterdir()):
        for g in sorted(f.iterdir()) if f.is_dir() else [f]:
            st = g.stat()
            out.append(f"{g.relative_to(raw)}:{st.st_size}:{st.st_mtime_ns}")
    return hashlib.sha256("\n".join(out).encode()).hexdigest()[:16]


def ensure_inputs(fx):
    """prep, lod2, laser.npz for the fixture, built once per (their code, the config, data/raw) in
    data/check/<name>/inputs/<key>/data/"""
    h = hashlib.sha256(json.dumps(fx.cfg, sort_keys=True).encode() + raw_fingerprint().encode())
    for n in import_closure(list(INPUTS)):
        h.update(n.encode() + (SCRIPTS / f"{n}.py").read_bytes())
    d = fx.home / "inputs" / h.hexdigest()[:16]
    if not all((d / p).exists() for p in INPUTS.values()):
        if (fx.home / "inputs").exists():
            shutil.rmtree(fx.home / "inputs")
        (d / "data").mkdir(parents=True)
        (d / "data" / "raw").symlink_to((ROOT / "data" / "raw").resolve())
        shutil.copy(fx.path, d / "fixture.json")
        for s in INPUTS:
            t = time.time()
            run(d, fx, s, scripts=SCRIPTS)
            print(f"  inputs: {s}.py {time.time() - t:.0f} s", flush=True)
    return d


def extends(path):
    """whether the registry at path is scripts/palette.json with colours added"""
    if not Path(path).exists():
        return False
    mine = json.loads((SCRIPTS / "palette.json").read_text())["palette"]
    return json.loads(Path(path).read_text())["palette"][:len(mine)] == mine


def setup(ws, fx, fresh=True, palette=None):
    """a workspace for fx at ws: a fresh copy of scripts/ (palette: the registry to start from), data/raw linked, the
    inputs linked; fresh: everything else removed (else the outputs and the regions' cache kept: incremental)"""
    if fresh and ws.exists():
        shutil.rmtree(ws)
    # the registry to start from: the one the last build of the fixture left (fx.home/palette.json), if it only added
    # colours to scripts/palette.json (a fixture meets a few the map does not): else a fresh build meets them, adds
    # them and builds its regions a second time, and a kept one builds every region again
    if palette is None and extends((fx.home / "palette.json")):
        palette = ws.parent / f".{ws.name}.palette.json"
        palette.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(fx.home / "palette.json", palette)
    if (ws / "scripts").exists():
        shutil.rmtree(ws / "scripts")
    shutil.copytree(SCRIPTS, ws / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    if palette is not None:
        shutil.copy(palette, ws / "scripts" / "palette.json")
    shutil.copy(fx.path, ws / "fixture.json")
    (ws / PUB).mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / PUB / "windows.json", ws / PUB / "windows.json")  # (not built by the pipeline)
    inp = ensure_inputs(fx)
    for p in ["data/raw"] + list(INPUTS.values()):
        dst = ws / p
        if dst.is_symlink() or dst.exists():
            dst.unlink()
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.symlink_to((ROOT / p).resolve() if p == "data/raw" else inp / p)
    return ws


def build(ws, fx, jobs, cover=(), after=True):
    t = time.time()
    run(ws, fx, "voxelize", list(cover) + ["-j", jobs])
    if extends(ws / "scripts" / "palette.json"):
        shutil.copy(ws / "scripts" / "palette.json", fx.home / "palette.json")
    t1 = time.time()
    if after:  # side by side as in build_data.sh (they read nothing of each other), then tile_fields (reads theirs)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(len(AFTER) - 1) as ex:
            for f in [ex.submit(run, ws, fx, s) for s in AFTER[:-1]]:
                f.result()  # (the first that failed raises, in AFTER's order)
        run(ws, fx, AFTER[-1])
    print(f"  {ws.relative_to(ROOT)}: voxelize {' '.join(cover) or '(default cover)'} {t1 - t:.0f} s"
          + (f", the steps after it {time.time() - t1:.0f} s" if after else ""), flush=True)


def base(fx, jobs, after=True):
    """the fixture's kept workspace, built incrementally"""
    ws = setup(fx.home / "base", fx, fresh=False)
    build(ws, fx, jobs, after=after)
    return ws


# ---------------------------------------------------------------- digests

def arr_sha(a):
    return hashlib.sha256(str((a.dtype, a.shape)).encode() + a.tobytes()).hexdigest()


def file_sha(f):
    return hashlib.sha256(Path(f).read_bytes()).hexdigest()


def digest(ws, inputs=False):
    """every output of a workspace: the files of web/public/data, the arrays of data/*.npz (a zip's entries carry the
    time they were written), data/*.bin, data/trees.json, data/qa_roadmask.bin.gz; inputs: also the arrays of prep, lod2, laser.npz"""
    h = {}
    for f in sorted((ws / PUB).rglob("*")):  # (the registry, scripts/palette.json, is meta.json's palette)
        if f.is_file():
            h[str(f.relative_to(ws))] = file_sha(f)
    for f in sorted((ws / "data").glob("*")):
        if (f.is_symlink() and not inputs) or not f.is_file():
            continue
        if f.suffix == ".npz":
            with np.load(f) as z:
                for k in sorted(z.files):
                    h[f"{f.relative_to(ws)}:{k}"] = arr_sha(z[k])
        elif f.suffix == ".bin" or f.name in ("trees.json", "qa_roadmask.bin.gz"):  # (the two not served: regions.py)
            h[str(f.relative_to(ws))] = file_sha(f)
    return h


def differ(ref, got):
    return sorted(k for k in set(ref) | set(got) if ref.get(k) != got.get(k))


# ---------------------------------------------------------------- verify: hard checks on a build

# thresholds of the hard checks: guards against a regression, set above what the Altstadt fixture gives (2026-11-20,
# in brackets); a change that crosses one is a bug, or a reason to move it (said in the commit)
LOD2_SHARE = 0.90     # building cells whose roof is LoD2's (0.965)
LASER_SHARE = 0.80    # canopy cells whose height is the laser's (0.884)
SHIFT_MAX = 3.0       # m: the mean shift of OSM's outlines onto LoD2's footprints, each way, per region (1.35)
CROWN_ROOFS_MAX = 12.0  # building cells per 10 000 standing 6 m or more over their LoD2 roof under a crown (10.0)
# the sloped caps (caps.py report): the carriageway cells with a cap, the capped carriageway's roughness (the second
# difference per metre, p99, cm), linked capped neighbours whose shared corners differ (altstadt: 0.984, 8.6, 0.0035)
CAPS = dict(road_share=0.95, rough_p99_cm=12.0, mismatch_share=0.01)
MATCH_SHARE = 0.40    # matched OSM outlines moved onto their LoD2 footprints (0.493)
SURFACE = {"road": dict(sunk=0.015, hover=0.005),  # (0.0090, 0.0022)
           "ped": dict(sunk=0.015, hover=0.015)}  # shares of the metres walked, see surface() (0.0078, 0.0075)
WET_MAX = 3           # m: a carriageway's or a railway's centreline on water (culvert.py; 9 m on the B 8 before it)
# bridge ways the deck_sag counter (voxelize.py) finds sagging that are known and are no deck on the ground
# beside it: their own level is a surface over the way (crowns), or a dip that is not the ground. Listed, not failed
DECK_SAG_KNOWN = {
    8099444: "Poststeg (haissengasse): samples 5 m under its deck mid-span, over the tracks, not the ground",
    80143938: "hiking path (haissengasse): crowns 45 m up the slope over its east half (taller than veg allows)",
    138602284: "path (haissengasse): crowns 35 m over it, outside veg",
    27663642: "Stockbauersteig (hals): crowns over its east end, its west end's ramp smoothed into the bank",
    1169724321: "Steffelmuehlweg (kachlet): crowns over a short bridge the ortho does not see green",
    1272598946: "footway (altstadt): crowns over 3 m of it",
    131994367: "Wels-Passau railway's Inn bridge (inn), a through truss: the surface model sees its top chords 11 m "
               "over the rails (314 m) over the 85 m river span; the deck at 303 m meets both approaches",
    131994370: "the same bridge's other track (inn)",
}



def surface(ws, fx):
    """where the moving things meet the voxels: every car lane and footpath of traffic.json walked every
    metre at the height the viewer gives it (linear between path points), against the finished volume (the regions'
    vol.npz, mapstore.MapVolume: nothing of the map's size)
      sunk:  a solid voxel (not leaves, lamps, poles, trunks, cars) 0.3-1.5 m above the path -- the vehicle drives
             into a deck, a wall, a kerb step
      hover: nothing solid in the 2 m below the path -- it drives over a hole, or above a deck that is drawn lower
    -> {network: dict(metres, sunk=(metres, share, worst 10 m clusters), hover=...)}"""
    import mapstore
    meta = json.load(open(ws / PUB / "meta.json"))
    import trafficpack
    tr = trafficpack.unpack(json.load(open(ws / PUB / "traffic.json")))
    pal = meta["palette"]
    solid = np.array([i != 0 and e[3] not in (M_LEAF, M_LAMP, M_CAR) for i, e in enumerate(pal)] + [True] * 64)
    rdir = lambda w: ws / "data/cache/regions" / f"{w.r0}_{w.c0}"  # noqa: E731
    vol = mapstore.MapVolume(fx.cover(), rdir, meta["H"])
    H, D, W = vol.shape

    def walk(p, offs=(0.0,)):
        for (x0, y0, z0), (x1, y1, z1) in zip(p, p[1:]):
            L = np.hypot(x1 - x0, y1 - y0)
            n = max(1, int(L))
            tx, ty = (x1 - x0) / max(L, 1e-6), (y1 - y0) / max(L, 1e-6)
            for k in range(n):
                f = k / n
                for o in offs:
                    yield x0 + (x1 - x0) * f - ty * o, y0 + (y1 - y0) * f + tx * o, z0 + (z1 - z0) * f
    lanes = lambda r: [r["o0"] + 3.0 * i for i in range(r["lanes"])]  # noqa: E731  (the lane centres: web/src/sim/life.ts)
    pts = {"road": [q for r in tr["roads"] for q in walk(r["p"], lanes(r))],
           "ped": [q for p in tr["peds"] for q in walk(p["p"], (-0.85, 0.85) if "side" not in p else (0.85 * p["side"],))]}
    out = {}
    for k, P in pts.items():
        P = np.array(P, np.float32).reshape(-1, 3)
        if not len(P):
            continue
        c = np.clip(P[:, 0].astype(int), 0, W - 1)
        r = np.clip(P[:, 1].astype(int), 0, D - 1)
        zf = np.floor(P[:, 2] + 0.3).astype(int)
        col = np.stack([solid[vol[np.clip(zf + dz, 0, H - 1), r, c]] for dz in range(-3, 5)], 1)  # floor(z) - 3 .. + 4
        sunk = col[:, 3] | col[:, 4]
        hover = ~col[:, 2] & ~col[:, 1] & ~sunk
        res = dict(metres=len(P))
        for name, m in (("sunk", sunk), ("hover", hover)):
            cl = {}
            for x, y, _ in P[m]:
                cl.setdefault((int(x) // 10, int(y) // 10), []).append((x, y))
            worst = sorted(([round(float(np.mean([q[0] for q in v]))), round(float(np.mean([q[1] for q in v]))), len(v)]
                            for v in cl.values()), key=lambda a: -a[2])[:5]
            res[name] = (int(m.sum()), float(m.mean()), worst)
        out[k] = res
    return out


def defect_checks(ws, fx):
    """Check patches from fixtures/road-defects.json and the fixtures' documented fixes on the built map.

    Boxes are half-open [x0, z0, x1, z1] on the project grid. Road and water heights are metres above
    the map base (a road's: its surface, over a bore or a covered passage the street, not the floor under it,
    data/ground.npz g). Deck height is clearance above the water; bridge: a deck over land, its surface above the map
    base. Dry: no water in the box (land the rivers from the terrain model must not take). Every column must have the
    expected surface.
    """
    checks = json.loads((SCRIPTS / "fixtures/road-defects.json").read_text()).get(fx.name, [])
    if not checks:
        return []

    import gzip
    import mapstore
    data = ws / "data"
    with np.load(data / "surface.npz") as s:
        ground, deck = s["gt"], s["deck"]
    with np.load(data / "ground.npz") as g:
        water, street = g["water"], g["g"]  # (street: over a bore or a covered passage its surface, not the floor)
    roads = np.frombuffer(gzip.decompress((data / "qa_roadmask.bin.gz").read_bytes()), np.uint8).reshape(ground.shape)
    meta = json.loads((ws / PUB / "meta.json").read_text())
    vol = mapstore.MapVolume(fx.cover(), lambda w: data / "cache/regions" / f"{w.r0}_{w.c0}", meta["H"])

    bad = []
    for check in checks:
        broken = []
        for patch in check["patches"]:
            x0, z0, x1, z1 = patch["box"]
            if not (fx.col0 <= x0 < x1 <= fx.col0 + fx.W and fx.row0 <= z0 < z1 <= fx.row0 + fx.D):
                raise Failed(f"{check['name']}: patch {patch['box']} is outside {fx.name}")
            r, c = np.ogrid[z0 - fx.row0:z1 - fx.row0, x0 - fx.col0:x1 - fx.col0]
            g = ground[r, c]
            kind = patch["kind"]
            if kind == "road":
                g = street[r, c]
                height, present, top = g, roads[r, c] == 1, g
            elif kind == "deck":
                d = deck[r, c]
                height, present, top = d - g, water[r, c] & np.isfinite(d), np.rint(np.nan_to_num(d))
            elif kind == "water":
                height, present, top = g, water[r, c], g
            elif kind == "bridge":  # a deck over land: its surface, m over the map base
                d = deck[r, c]
                height, present, top = d, np.isfinite(d), np.rint(np.nan_to_num(d))
            elif kind == "dry":  # land, no water: ground of any height
                height, present, top = g, ~water[r, c], g
            else:
                raise Failed(f"{check['name']}: unknown surface {kind!r}")
            # A raster can mark a surface even if the finished volume has a hole in it.
            present &= (top > 0) & (top <= meta["H"]) & (vol[np.clip(top.astype(int) - 1, 0, meta["H"] - 1), r, c] != 0)
            low, high = patch.get("min_m", -np.inf), patch.get("max_m", np.inf)
            failed = ~present | (height < low) | (height > high)
            if failed.any():
                iz, ix = np.argwhere(failed)[0]
                found = f"{height[iz, ix]:.2f} m" if present[iz, ix] else "missing"
                broken.append(f"{kind} at ({x0 + ix}, {z0 + iz}): {found}, expected {low:g}..{high:g} m "
                              f"({int(failed.sum())}/{failed.size} columns fail in {patch['box']})")
        print(f"  defect: {check['name']}: {'FAIL' if broken else 'ok'}")
        if broken:
            bad.append(f"{check['name']}: " + ", ".join(broken))
    return bad


def verify(fx, jobs, ws=None):
    """the hard checks on the fixture's workspace; returns the failures"""
    ws = ws or base(fx, jobs, after=False)
    bad = []
    dbg = ws / "data/debug"
    for name, what in (("floating_left", "pieces debris.support_floating could neither ground nor remove"),
                       ("floating", "floating clumps too big to remove (debris.drop_debris)")):
        items = json.load(open(dbg / f"{name}.json"))
        print(f"  {name}.json: {len(items)}")
        if items:
            bad.append(f"{len(items)} {what}: {items[:5]} (data/debug/{name}.json)")
    report = json.loads((dbg / "report.json").read_text())
    counters = report.get("counters", {})
    if not counters or any(not region for region in counters.values()):
        raise Failed("missing region counters in data/debug/report.json, rebuild the fixture")
    regions = list(counters.values())
    carriageways = [count for r in regions for count in r["carriageways"].values()]
    nbad = sum(carriageways)
    print(f"  carriageway sanity: {len(carriageways)} checks, {nbad} roads painted as pavement")
    if not carriageways:
        bad.append("no carriageway sanity counter in the report")
    elif nbad:
        bad.append(f"{nbad} carriageways painted as pavement")
    openings = [r.get("underpass_open_bed") for r in regions]
    if any(o is None for o in openings):
        bad.append("underpasses: no counter for open walking cells on roads and rail beds")
    else:
        road, rail = (sum(o[key] for o in openings) for key in ("road", "rail"))
        print(f"  underpasses: {road} open walking cells on roads, {rail} on rail beds (0 each)")
        if road or rail:
            bad.append(f"underpasses: {road} open walking cells on roads, {rail} on rail beds")
    for label, key, used, total, lim in (
        ("LoD2 roofs taken", "lod2_roofs", "used", "total", LOD2_SHARE),
        ("canopy heights from the laser", "laser_canopy", "used", "total", LASER_SHARE),
        ("matched OSM outlines moved onto LoD2", "osm_lod2", "moved", "matched", MATCH_SHARE),
    ):
        samples = [r[key] for r in regions if key in r]
        if not samples:
            bad.append(f"{label}: no counter in the report")
            continue
        a, b = sum(s[used] for s in samples), sum(s[total] for s in samples)
        print(f"  {label}: {a} of {b} ({a / max(b, 1):.3f}, at least {lim})")
        if a < lim * b:
            bad.append(f"{label}: {a} of {b}, under {lim}")
    # a crown over a roof is no tower (voxelize.py lod2_roofs' crown_roofs counter): the cells left are those beside
    # LoD2's own higher part, where the surface model's step and the walls' vegetation returns are a cell or two off
    crowns = [r.get("crown_roofs") for r in regions]
    if any(c is None for c in crowns):
        bad.append("crowns over roofs: no crown_roofs counter in the report (voxelize.py lod2_roofs)")
    else:
        left, cells = sum(c["left"] for c in crowns), sum(c["cells"] for c in crowns)
        per = 1e4 * left / max(cells, 1)
        print(f"  crowns over roofs: {left} building cells 6 m or more over their LoD2 roof under a crown "
              f"({per:.1f} per 10 000, at most {CROWN_ROOFS_MAX})")
        if per > CROWN_ROOFS_MAX:
            bad.append(f"crowns over roofs: {left} building cells 6 m or more over their LoD2 roof under a crown "
                       f"({per:.1f} per 10 000, more than {CROWN_ROOFS_MAX})")
    shifts = [r["osm_lod2"]["mean_shift_m"] for r in regions if r.get("osm_lod2", {}).get("mean_shift_m") is not None]
    worst = max((max(abs(dx), abs(dy)) for dx, dy in shifts), default=None)
    print(f"  OSM outlines' mean shift onto LoD2: up to {worst} m (at most {SHIFT_MAX})")
    if worst is None or worst > SHIFT_MAX:
        bad.append(f"OSM outlines' mean shift onto LoD2 {worst} m (more than {SHIFT_MAX}: the grids disagree?)")
    for k, res in surface(ws, fx).items():
        for name in ("sunk", "hover"):
            m, share, worst = res[name]
            lim = SURFACE[k][name]
            print(f"  surface {k}: {res['metres']} m walked, {name} {m} m ({share:.4f}, at most {lim}); worst (x, y, m): {worst[:3]}")
            if share > lim:
                bad.append(f"{k} {name}: {share:.4f} of the metres walked (more than {lim}), worst (x, y, m): {worst}")
    import caps
    rep = caps.report(ws, note=lambda *a: None)
    if not rep or not rep.get("nodes_with_caps"):
        bad.append("no caps section in the fixture's nodes (caps.py, tile_fields.py; data/surface.npz?)")
    else:
        print(f"  caps: {rep.get('ground_capped', 0)} ground, {rep.get('deck_capped', 0)} deck columns, {rep['bytes']} B raw; "
              f"carriageway share {rep['road_share']} (at least {CAPS['road_share']}), roughness p99 {rep['rough_p99_cm']} cm "
              f"(at most {CAPS['rough_p99_cm']}), edge mismatches {rep['mismatch_share']} (at most {CAPS['mismatch_share']})")
        overshoots = rep["roof_ridge_overshoots"]
        print(f"  roofs: {overshoots} written corners more than 0.5 m above a ridge (0)")
        if overshoots:
            bad.append(f"roofs: {overshoots} written corners more than 0.5 m above a ridge")
        if rep["road_share"] < CAPS["road_share"]:
            bad.append(f"caps: carriageway share {rep['road_share']} under {CAPS['road_share']}")
        if rep["rough_p99_cm"] is None or rep["rough_p99_cm"] > CAPS["rough_p99_cm"]:
            bad.append(f"caps: roughness p99 {rep['rough_p99_cm']} cm over {CAPS['rough_p99_cm']}")
        if rep["mismatch_share"] > CAPS["mismatch_share"]:
            bad.append(f"caps: edge mismatches {rep['mismatch_share']} over {CAPS['mismatch_share']}")
    # what passes under a bridge stays open (ground.under_bridge, voxelize.py's under_bridge counter): along every
    # railway and carriageway that a bridge crosses over, no step of 2 m in the ground and nothing in the clearance
    ub = [r.get("under_bridge") for r in regions]
    if any(u is None for u in ub):
        bad.append("ways under bridges: no under_bridge counter in the report (ground.under_bridge)")
    else:
        tot = {k: sum(u[k] for u in ub) for k in ("corridors", "steps", "blocked", "low")}
        worst = [w for u in ub for w in u["worst"]]
        print(f"  ways under bridges: {tot['corridors']} corridors, {tot['steps']} with a ground step of 2 m or more, "
              f"{tot['blocked']} blocked within the clearance (0 each); decks lower than the clearance {tot['low']}")
        if tot["steps"] or tot["blocked"]:
            bad.append(f"ways under bridges: {tot['steps']} with a ground step, {tot['blocked']} blocked "
                       f"(way, col, row, step m, blocked m): {worst[:5]}")
    # a bridge deck does not sag to the ground beside it (voxelize.py's deck_sag counter, "# bridges / decks"): along
    # every bridge way's span, the built deck nowhere SAG_M m or more under the way's own deck level
    sg = [r.get("deck_sag") for r in regions]
    if any(s is None for s in sg):
        bad.append("bridge decks: no deck_sag counter in the report (voxelize.py)")
    else:
        worst = [w for s in sg for w in s["worst"]]
        new = [w for w in worst if w[0] not in DECK_SAG_KNOWN]
        print(f"  bridge decks: {sum(s['ways'] for s in sg)} ways with a span, {len(new)} sagging 2 m or more under "
              f"their own level (0); known (DECK_SAG_KNOWN): {[w[0] for w in worst if w[0] in DECK_SAG_KNOWN]}")
        if new:
            bad.append(f"bridge decks: {len(new)} ways sag 2 m or more under their own level "
                       f"(way, col, row, m, metres): {new[:5]}")
    # a tunnel under a street is a covered passage (tunnels.py, voxelize.py's tunnels counter): along every tunnel=yes
    # carriageway and railway, room over its floor and no hole in the street over it
    tu = [r.get("tunnels") for r in regions]
    if any(u is None for u in tu):
        bad.append("tunnels: no tunnels counter in the report (tunnels.py)")
    else:
        tot = {k: sum(u[k] for u in tu) for k in ("ways", "blocked", "low", "holes")}
        worst = [w for u in tu for w in u["worst"]]
        print(f"  tunnels: {tot['ways']} carriageways and railways, {tot['blocked']} blocked, {tot['holes']} with a hole "
              f"in the street over them (0 each); lower than the vehicle's clearance {tot['low']}")
        if tot["blocked"] or tot["holes"]:
            bad.append(f"tunnels: {tot['blocked']} blocked, {tot['holes']} with a hole in the street over them "
                       f"(way, col, row, least room m, blocked m, holes): {worst[:5]}")
    # a way over water with no bridge tag (scripts/culvert.py, voxelize.py's way_water counter): metres of centreline
    # on water per way; a carriageway or a railway with WET_MAX m or more left on water fails (paths are listed)
    ww = [r.get("way_water") for r in regions]
    if any(w is None for w in ww):
        bad.append("ways over water: no way_water counter in the report (culvert.py)")
    else:
        per = {k: {} for k in ("carried", "left", "hard")}
        for w in ww:
            for k in per:
                for oid, m in w[k].items():
                    per[k][oid] = per[k].get(oid, 0) + m
        left = sorted(((m, oid) for oid, m in per["left"].items()), reverse=True)
        hard = sorted(((m, oid) for oid, m in per["hard"].items() if m >= WET_MAX), reverse=True)
        print(f"  ways over water with no bridge tag: {sum(per['carried'].values())} m carried over on "
              f"{len(per['carried'])} ways; left on water (m, way): {left[:8]}; carriageways and railways with "
              f"{WET_MAX} m or more {len(hard)} (0)")
        if hard:
            bad.append(f"ways over water: {len(hard)} carriageways or railways with {WET_MAX} m or more of centreline "
                       f"on water (m, way): {hard[:5]}")
    bad.extend(defect_checks(ws, fx))
    return bad


# ---------------------------------------------------------------- covers, windows, golden, extent

def covers(fx, jobs, cvs, incremental=True, keep=False):
    home = fx.home / "covers"
    whole = setup(home / "whole", fx)
    build(whole, fx, 1, ["--whole"])
    ref = digest(whole)
    print(f"whole fixture as one region: {len(ref)} outputs", flush=True)
    bad = []
    for i, c in enumerate(cvs):
        args = ["--regions", c] if "x" in c else ["--region-size", c]
        ws = setup(home / c.replace("/", "_"), fx, palette=whole / "scripts" / "palette.json")
        build(ws, fx, jobs, args)
        diff = differ(ref, digest(ws))
        print(f"{c}: {len(diff)} outputs differ from the whole fixture's", diff[:8], flush=True)
        bad += [f"cover {c}: {k}" for k in diff]
        if i == 0 and incremental:
            log = run(ws, fx, "voxelize", args + ["-j", jobs], log="voxelize_again")
            noop = "nothing to do" in log.read_text()
            if not noop:
                bad.append(f"cover {c}: built again with nothing changed (see {log})")
            mt = tile_mtimes(ws)
            build(ws, fx, jobs, args + ["--only", "0_0"])
            diff = differ(ref, digest(ws))
            touched = sorted(k for k, v in tile_mtimes(ws).items() if mt.get(k) != v)
            print(f"{c} again: {'nothing built' if noop else 'BUILT AGAIN with nothing changed'}; region 0_0 built again "
                  f"alone: {len(diff)} outputs differ from the whole fixture's", diff[:8], f"; node files rewritten: "
                  f"{len(touched)}", touched[:5], flush=True)
            bad += [f"cover {c}, region 0_0 again: {k}" for k in diff]
            bad += [f"cover {c}, region 0_0 again: {k} written again with nothing changed" for k in touched]
    if not keep:
        shutil.rmtree(home)
    return bad


def windows(fx, jobs, steps, cvs, keep=False):
    src = base(fx, jobs)
    home = fx.home / "windows"
    bad = []

    def one(step, args, scratch):
        spec = WSTEPS[step]
        if scratch.exists():
            shutil.rmtree(scratch)
        for p in spec["copy"]:
            (scratch / p).parent.mkdir(parents=True, exist_ok=True)
            (shutil.copytree if (src / p).is_dir() else shutil.copy)(src / p, scratch / p)
        for p in spec["link"]:
            (scratch / p).parent.mkdir(parents=True, exist_ok=True)
            (scratch / p).symlink_to((src / p).resolve())
        (scratch / "data").mkdir(exist_ok=True)
        shutil.copy(fx.path, scratch / "fixture.json")
        run(scratch, fx, step, args, scripts=src / "scripts")
        h = {}
        for o in spec["out"]:
            p = scratch / o
            for f in sorted([p] if p.is_file() else p.rglob("*")):
                if f.is_file():
                    h[str(f.relative_to(scratch))] = file_sha(f)
        return h
    for step in steps:
        t = time.time()
        ref = one(step, WSTEPS[step].get("whole", []), home / step / "whole")
        for c in cvs:
            diff = differ(ref, one(step, ["--windows", c] if "x" in c else ["--window-size", c], home / step / c))
            print(f"{step}: {c}: {len(diff)} of {len(ref)} files differ from the whole fixture's", diff[:5], flush=True)
            bad += [f"{step} {c}: {k}" for k in diff]
        print(f"  {step}: {time.time() - t:.0f} s", flush=True)
    if not keep:
        shutil.rmtree(home)
    return bad


def tile_mtimes(ws):
    """{node file: mtime} of the workspace's tiles: a region built again with nothing changed must leave them be
    (tilefile.write, tiles.export_window)"""
    return {str(f.relative_to(ws)): f.stat().st_mtime_ns for f in sorted((ws / PUB / "tiles").rglob("*.bin"))}


def golden(fx, jobs, record=None, compare=None, incremental=False, keep=False):
    ws = setup(fx.home / "golden", fx, fresh=not incremental)
    build(ws, fx, jobs)
    files = digest(ws, inputs=True)
    if not keep and not incremental:
        shutil.rmtree(ws)
    doc = dict(fixture=fx.name, config=fx.cfg, raw=raw_fingerprint(), files=files)
    if record:
        Path(record).mkdir(parents=True, exist_ok=True)
        json.dump(doc, open(Path(record) / "golden.json", "w"), indent=0, sort_keys=True)
        print(f"golden: {len(files)} outputs recorded in {Path(record) / 'golden.json'}")
        return []
    ref = json.load(open(Path(compare) / "golden.json"))
    if ref["config"] != fx.cfg:
        print("golden: recorded on another fixture config: differences may be the config's")
    if ref["raw"] != doc["raw"]:
        print("golden: data/raw changed since the record: differences may be the data's")
    diff = differ(ref["files"], files)
    print(f"golden: {len(files)} outputs, {len(diff)} differ from the record", diff[:12])
    return [f"golden: {k}" for k in diff]


def extent(fx, jobs, other):
    """compare the fixture's volume and tiles with those of a larger (or shifted) fixture where the two maps look the
    same from within region.HALO"""
    import mapstore
    import region
    import tilefile
    import tiles
    fo = Fixture(other)
    wa, wb = base(fx, jobs, after=False), base(fo, jobs, after=False)
    margin = region.HALO

    def same_view(box):
        """box (project r0, r1, c0, c1): in both maps, and each side either on the same map edge in both or at least
        `margin` from both maps' edges"""
        r0, r1, c0, c1 = box
        ok = True
        for f in (fx, fo):
            ok &= f.row0 <= r0 and r1 <= f.row0 + f.D and f.col0 <= c0 and c1 <= f.col0 + f.W
        if not ok:
            return False
        sides = ((r0 - fx.row0, r0 - fo.row0, fx.row0 == fo.row0), (fx.row0 + fx.D - r1, fo.row0 + fo.D - r1, fx.row0 + fx.D == fo.row0 + fo.D),
                 (c0 - fx.col0, c0 - fo.col0, fx.col0 == fo.col0), (fx.col0 + fx.W - c1, fo.col0 + fo.W - c1, fx.col0 + fx.W == fo.col0 + fo.W))
        return all(same or min(da, db) >= margin for da, db, same in sides)

    pals = [json.load(open(w / PUB / "meta.json"))["palette"] for w in (wa, wb)]
    keys = {}
    luts = [np.array([keys.setdefault(tuple(e), len(keys)) for e in p] + [65535] * 64, np.uint16) for p in pals]

    def blocks(f, ws):
        """{(project row, col of the block): where it is} of every 128 m block of the regions' cores"""
        out = {}
        for w in f.cover():
            with np.load(ws / "data/cache/regions" / f"{w.r0}_{w.c0}" / "vol.npz") as z:
                for k in z.files:
                    br, bc = (int(x) * mapstore.VBLOCK for x in k.split("_"))
                    out[(f.row0 + w.r0 + br, f.col0 + w.c0 + bc)] = (ws, w, k)
        return out
    ba, bb = blocks(fx, wa), blocks(fo, wb)

    def load(ref, lut):  # (the block as colour keys)
        ws, w, k = ref
        with np.load(ws / "data/cache/regions" / f"{w.r0}_{w.c0}" / "vol.npz") as z:
            return lut[z[k]]
    stats = dict(same=0, differ=0, edge_same=0, edge_differ=0)
    bad, edge_diff = [], []
    B = mapstore.VBLOCK
    for key in sorted(set(ba) & set(bb)):
        a, b = load(ba[key], luts[0]), load(bb[key], luts[1])
        h = max(a.shape[0], b.shape[0])
        pad = lambda v: np.concatenate([v, np.zeros((h - v.shape[0],) + v.shape[1:], v.dtype)])  # noqa: E731
        eq = a.shape[1:] == b.shape[1:] and np.array_equal(pad(a), pad(b))
        interior = same_view((key[0], key[0] + B, key[1], key[1] + B))
        stats[("" if interior else "edge_") + ("same" if eq else "differ")] += 1
        if not eq:
            n = int((pad(a) != pad(b)).sum()) if a.shape[1:] == b.shape[1:] else -1
            (bad if interior else edge_diff).append((key, n))
    print(f"extent: volume blocks of {B} m in both maps: {stats['same'] + stats['differ']} away from a differing "
          f"edge ({stats['same']} the same, {stats['differ']} differ), {stats['edge_same'] + stats['edge_differ']} "
          f"within {margin} m of one ({stats['edge_same']} the same, {stats['edge_differ']} differ)", flush=True)
    if bad:
        print("  differing (project row, col; voxels):", bad[:10])
    if edge_diff:
        print("  near the edge, differing (project row, col; voxels):", edge_diff[:10])
    failures = [f"extent: volume block at project {k}: {n} voxels differ" for k, n in bad]
    # the tiles: every node's voxel sections (runs as colours) where the node and its apron look the same
    nst = dict(same=0, differ=0)
    for lv in tiles.manifest(fx.D, fx.W):
        s = lv["s"]
        n = tiles.N * s
        for sub in ([str(s), "1f"] if s == 1 else [str(s)]):
            for f in sorted((wa / PUB / "tiles" / sub).glob("*.bin")):
                tx, ty = map(int, f.stem.split("_"))
                r0, c0 = fx.row0 + ty * n, fx.col0 + tx * n
                if (r0 - fo.row0) % n or (c0 - fo.col0) % n or not same_view((r0 - 2 * s, r0 + n + 2 * s, c0 - 2 * s, c0 + n + 2 * s)):
                    continue
                g = wb / PUB / "tiles" / sub / f"{(c0 - fo.col0) // n}_{(r0 - fo.row0) // n}.bin"
                ta, tb = tilefile.read(f, tiles.N), tilefile.read(g, tiles.N) if g.exists() else {}
                diff = []
                for tag in ("cnts", "grnd", "plns", "runs", "room"):
                    x, y = ta.get(tag, b""), tb.get(tag, b"")
                    if tag in ("runs", "room"):  # (their palette entries as colours: the last of the 3 or 4 values)
                        k = 3 if tag == "runs" else 4
                        x, y = (np.frombuffer(v, np.uint16).reshape(-1, k).copy() for v in (x, y))
                        x[:, k - 1], y[:, k - 1] = luts[0][x[:, k - 1]], luts[1][y[:, k - 1]]
                        x, y = x.tobytes(), y.tobytes()
                    if x != y:
                        diff.append(tag)
                nst["differ" if diff else "same"] += 1
                if diff:
                    failures.append(f"extent: tile {sub}/{f.stem} (project row {r0}, col {c0}): {diff} differ")
    print(f"extent: tile nodes away from a differing edge: {nst['same']} the same, {nst['differ']} differ", flush=True)
    return failures


# ---------------------------------------------------------------- main

def main(argv):
    def opt(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default
    flags = ("--fixture", "-j", "--record", "--compare", "--covers", "--other")
    pos = [a for i, a in enumerate(argv) if not a.startswith("-") and (i == 0 or argv[i - 1] not in flags)]
    if not pos:
        print(__doc__)
        return 2
    cmd, rest = pos[0], pos[1:]
    fx = Fixture(opt("--fixture", FIXTURE))
    jobs = int(opt("-j", fx.cfg.get("regions", {}).get("jobs", 2)))
    keep = "--keep" in argv
    t0 = time.time()
    bad = []
    try:
        if cmd == "build":
            base(fx, jobs)
        elif cmd == "verify":
            bad = verify(fx, jobs)
        elif cmd == "golden":
            if not (opt("--record") or opt("--compare")):
                raise Failed("golden needs --record DIR or --compare DIR")
            bad = golden(fx, jobs, opt("--record"), opt("--compare"), "--incremental" in argv, keep)
        elif cmd == "covers":
            bad = covers(fx, jobs, rest or ["2x2"], "--no-incremental" not in argv, keep)
        elif cmd == "windows":
            bad = windows(fx, jobs, rest or list(WSTEPS), opt("--covers", "2x2").split(","), keep)
        elif cmd == "extent":
            bad = extent(fx, jobs, opt("--other", WIDE))
        elif cmd == "all":
            for name, fn in (("verify", lambda: verify(fx, jobs)), ("covers", lambda: covers(fx, jobs, ["2x2"], True, keep)),
                             ("windows", lambda: windows(fx, jobs, list(WSTEPS), ["2x2"], keep)),
                             ("extent", lambda: extent(fx, jobs, WIDE))):
                t = time.time()
                print(f"== {name}", flush=True)
                bad += fn()
                print(f"== {name}: {time.time() - t:.0f} s", flush=True)
        else:
            print(__doc__)
            return 2
    except Failed as e:
        bad.append(str(e))
    peak = max(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    print(f"check {cmd} on {fx.name}: {time.time() - t0:.0f} s, peak RAM of a process {peak / 1024:.0f} MB")
    for b in bad:
        print("FAILED:", b)
    print("ok" if not bad else f"{len(bad)} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
