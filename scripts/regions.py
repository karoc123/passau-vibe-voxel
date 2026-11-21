"""voxelize.py's driver: the map built region by region and put together, rebuilding only what changed.

usage: uv run python scripts/voxelize.py [--regions NXxNY | --region-size METRES | --whole] [-j JOBS]
                                         [--status | --only ROW_COL[+ROW_COL..] | --only x=COL,y=ROW | --force
                                          | --just ROW_COL[,ROW_COL..] | --just x=COL,y=ROW]
  the cover: scripts/map.json's `regions` (size, jobs) unless given; every cover writes the same bytes
  (scripts/region_check.py). --status: which regions are up to date and what changed for the others; --only: build
  these regions again (and whatever else changed), e.g. to iterate on one place; --force: all of them
  --just: build these regions and nothing else (after an edit of voxelize.py, to look at one place: the other regions
  stay as they are, stale ones included, and the steps after them run on that mix); data/cache/regions.stamp is not
  written, so the next build without --just builds what is stale and runs those steps again. Not a build to commit:
  --status shows what is left. Refused when a region not named was never built

A region is a core of the map on window.ALIGN (1024 m) boundaries (window.py) and a halo of region.HALO metres round
it. Each region is built by voxelize.py in a process of its own (VOXEL_REGION, VOXEL_CORE, VOXEL_OUT, VOXEL_OSM in its
environment), which reads its cut of OSM (region_inputs.cut_osm), writes the tiles of its core and leaves in
data/cache/regions/<row>_<col>/ its core's rasters (core.npz), its core's volume (vol.npz: compressed 128 m column
blocks, ~2 MB a km2) and what lies in its core of the lists (out.json).

Before the regions, the feature pass (feature_pass, features.py): each region counts over its core alone what
decides the large features (lawns, untagged car parks and paths spanning region.FMAX or more), the counts are added
up and each such feature decided once (data/cache/features.json), which the regions look up.

Incremental: a region is built again only when the hash of what it reads changed (its windows of data/prep.npz,
lod2.npz, laser.npz, its OSM cut, the raw files it reads, the code it loaded, the map's config, the large features'
decisions it took: region_inputs.region_key, kept in its manifest.json), or the palette registry no longer starts with
the colours it was built with, or its files are gone; the feature pass the same way. The steps below run again when
any region was built or their own inputs changed (data/cache/regions.stamp). Then, here:
- the palette: colours the registry (scripts/palette.json) lacked are added to it, sorted, and the regions that met
  them built again (their ids were provisional)
- put together, row band by row band (mapstore.py: nothing of the map's size in memory): data/ground.npz,
  data/footprints.npz, data/crowns.npz, data/qa_roadmask.bin.gz, data/trees.json (in the map's order, the crowns' owners as
  indices into it), meta.json's lamps and jets, the debug images (whole up to 64 Mpx, else per region) and lists
- the passes over the whole map, network-wide over OSM's vectors and the regions' lists, reading the regions' rasters
  and volumes where they look (mapstore.MapRaster, MapVolume: point lookups, a box round a label): the labels
  (labels.py: the parks', each curated label's top over its whole outline, the decluttering, their radii), the camera
  presets (landmarks.make_views; the ground's median from the regions' histograms), traffic.json
  (traffic.py), the carriageway check summed over the regions. flood.py and boats.py stay whole-map steps of their own.
"""
import gzip
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

import aoi
import mapstore
import region
import window

OUT = Path("web/public/data")
DBG = Path("data/debug")
CACHE = Path("data/cache/regions")
HERE = Path(__file__).resolve().parent


def cover(argv):
    """the regions asked for: --regions NXxNY, --region-size METRES, --whole (one region), else scripts/map.json's"""
    if "--whole" in argv:
        return window.cover(aoi.MAP_D, aoi.MAP_W, None)
    for i, a in enumerate(argv):
        if a == "--regions":
            nx, ny = map(int, argv[i + 1].lower().split("x"))
            return window.split(aoi.MAP_D, aoi.MAP_W, nx, ny)
        if a == "--region-size":
            return window.cover(aoi.MAP_D, aoi.MAP_W, int(argv[i + 1]))
    return window.cover(aoi.MAP_D, aoi.MAP_W, aoi.CONFIG.get("regions", {}).get("size"))


def rdir(w):
    return CACHE / f"{w.r0}_{w.c0}"


FTABLE = Path("data/cache/features.json")  # the large features' decisions (features.py), what the regions look up


def mem_available_mb():
    """MemAvailable of /proc/meminfo, MB (None where there is none)"""
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def plan(argv):
    """(jobs, memory budget MB or None): -j N on the command line: N at once, no budget (as before; check.py passes it);
    else scripts/map.json regions.jobs (a number, or "auto": the cores less 4) as the cap and a budget of
    REGION_MEM_GB, else regions.mem_gb, else 75 % of what is available now"""
    if "-j" in argv:
        return int(argv[argv.index("-j") + 1]), None
    cfg = aoi.CONFIG.get("regions", {})
    jobs = cfg.get("jobs", 1)
    jobs = max(1, (os.cpu_count() or 5) - 4) if jobs == "auto" else int(jobs)
    gb = os.environ.get("REGION_MEM_GB") or cfg.get("mem_gb")
    budget = float(gb) * 1024 if gb else 0.75 * (mem_available_mb() or 8192)
    return jobs, budget


MEM_PER_CELL = 1.7e-3  # MB a region's process peaks at per cell of its box, until it was built once (stats.json)
MEM_FPASS = 1500  # MB, the feature pass's, alike
MEM_FLOOR = 2048  # MB: with less available than this, nothing more is started (the guard)


def estimate(w, fpass):
    """(peak MB with a margin, wall s) of region w's next build: its last build's (stats.json), else from its size"""
    f = (rdir(w) / "fpass" if fpass else rdir(w)) / "stats.json"
    try:
        st = json.load(open(f))
        return 1.1 * st["peak_mb"], st["wall"]
    except (OSError, ValueError, KeyError):
        ra, rb, ca, cb = w.region(region.HALO)
        cells = (w.r1 - w.r0) * (w.c1 - w.c0) if fpass else (rb - ra) * (cb - ca)
        return 1.1 * (MEM_FPASS if fpass else MEM_PER_CELL * cells), cells / 1e6 * (5 if fpass else 60)


def own_peak(result, ru):
    """a region's process's own peak RSS in MB: as it recorded it (voxelize.own_peak_mb, in out.json / fstats.json),
    else its ru_maxrss -- which starts at the driver's size when it forked (2.9 GB after cut_osm) and so overstated
    every small region and feature pass"""
    try:
        return int(json.load(open(result))["peak_mb"])
    except (OSError, ValueError, KeyError, TypeError):
        return round(ru.ru_maxrss / 1024)


def build(ws, jobs, fpass=False, budget=None):
    """voxelize.py over each region in a process of its own, up to `jobs` at once; per region (wall s, peak RSS MB).
    fpass: the feature pass instead (VOXEL_FEATURES: over the region's core alone, the counts of its large features
    into <region>/fpass/fstats.json). budget (MB, or None: `jobs` at once, in order): a region starts while the peaks
    estimated of those running and its own stay within it (one always runs), the longest and largest first, and
    nothing starts while the memory available is under MEM_FLOOR"""
    todo, running, stats = list(ws), {}, {}
    est = {w: estimate(w, fpass) for w in ws}
    if budget is not None:
        todo.sort(key=lambda w: -est[w][0] * est[w][1])
        print(f"{'feature pass' if fpass else 'regions'}: {len(todo)}, up to {jobs} at once within {budget / 1024:.1f} GB "
              f"(estimated peaks {min(e[0] for e in est.values()) / 1024:.1f}-{max(e[0] for e in est.values()) / 1024:.1f} GB)",
              flush=True)

    def admit():
        if len(running) >= jobs:
            return None
        if budget is None:
            return 0
        if not running:
            return 0
        avail = mem_available_mb()
        if avail is not None and avail < MEM_FLOOR:
            return None
        used = sum(est[v[0]][0] for v in running.values())
        return next((i for i, w in enumerate(todo) if used + est[w][0] <= budget), None)

    while todo or running:
        while todo and (i := admit()) is not None:
            w = todo.pop(i)
            ra, rb, ca, cb = (w.r0, w.r1, w.c0, w.c1) if fpass else w.region(region.HALO)
            out = rdir(w) / "fpass" if fpass else rdir(w)
            out.mkdir(parents=True, exist_ok=True)
            env = dict(os.environ, VOXEL_REGION=f"{ra},{rb},{ca},{cb}", VOXEL_CORE=f"{w.r0},{w.r1},{w.c0},{w.c1}",
                       VOXEL_OUT=str(out), VOXEL_OSM=str(rdir(w) / "osm.json"), PYTHONUNBUFFERED="1")
            if fpass:
                env["VOXEL_FEATURES"] = "1"
                (out / "fstats.json").unlink(missing_ok=True)
            else:
                env["VOXEL_FEATURE_TABLE"] = str(FTABLE)
                (out / "manifest.json").unlink(missing_ok=True)  # (stale until it is written again, after the build)
            log = open(out / "log.txt", "w")
            p = subprocess.Popen([sys.executable, str(HERE / "voxelize.py")], env=env, stdout=log, stderr=subprocess.STDOUT)
            # (the Popen kept too: one garbage-collected while running is reaped by subprocess's own cleanup on the next
            # Popen, and os.wait4 then found no child)
            running[p.pid] = (w, time.time(), log, p, out)
            print(f"region {w} ({'feature pass, its core alone' if fpass else f'with its halo rows {ra}-{rb}, cols {ca}-{cb}'}):"
                  " started", flush=True)
        pid, status, ru = os.wait4(-1, 0)
        w, t0, log, _, out = running.pop(pid)
        log.close()
        if status != 0:
            print(Path(log.name).read_text()[-3000:])
            raise SystemExit(f"region {w} failed")
        stats[w] = (round(time.time() - t0, 1), own_peak(out / ("fstats.json" if fpass else "out.json"), ru))
        json.dump(dict(wall=stats[w][0], peak_mb=stats[w][1]), open(out / "stats.json", "w"))  # (what the next build expects)
        print(f"region {w}{' (feature pass)' if fpass else ''}: {stats[w][0]} s, peak {stats[w][1]} MB", flush=True)
    return stats


def feature_pass(ws, jobs, osm_hashes, force=(), budget=None):
    """the large features' decisions (features.py): each region's counts over its core (again where its inputs
    changed, as a region's build), added up -> data/cache/features.json (written when it changed); returns them"""
    import features
    import region_inputs
    todo = []
    for w in ws:
        f = rdir(w) / "fpass" / "fstats.json"
        if w in force or not f.exists() or json.load(open(f)).get("key") != \
                region_inputs.region_key(w, osm_hashes[w], json.load(open(f))["deps"])[0]:
            todo.append(w)
    if todo:
        st = build(todo, jobs, fpass=True, budget=budget)
        print(f"feature pass: {len(todo)} regions, {round(max(v[0] for v in st.values()))} s the longest", flush=True)
        for w in todo:
            f = rdir(w) / "fpass" / "fstats.json"
            d = json.load(open(f))
            d["key"] = region_inputs.region_key(w, osm_hashes[w], d["deps"])[0]
            json.dump(d, open(f, "w"))
    table = features.merge([json.load(open(rdir(w) / "fpass" / "fstats.json"))["stats"] for w in ws])
    s = json.dumps(table, indent=0)
    if not FTABLE.exists() or FTABLE.read_text() != s:
        FTABLE.parent.mkdir(parents=True, exist_ok=True)
        FTABLE.write_text(s)
    return table


# ---------------------------------------------------------------- incremental: which regions are up to date

def core_tiles(w):
    """the node files of the region's core (tiles.py: a node is its core's whose first cell lies in it)"""
    import tiles
    out = []
    for lv in tiles.manifest(aoi.MAP_D, aoi.MAP_W):
        s = lv["s"]
        n = tiles.N * s
        for d in [str(s)] + (["1f"] if s == 1 else []):
            for ty in range(-(-w.r0 // n), -(-w.r1 // n)):
                for tx in range(-(-w.c0 // n), -(-w.c1 // n)):
                    if (OUT / "tiles" / d / f"{tx}_{ty}.bin").exists():
                        out.append(f"{d}/{tx}_{ty}.bin")
    return out


def fresh(w, key):
    """whether region w's outputs are those of a build with this key: its manifest says so, the palette registry
    still starts with the colours it was built with, and its files are there"""
    import region_inputs
    f = rdir(w) / "manifest.json"
    if not f.exists():
        return False
    m = json.load(open(f))
    if m.get("key") != key or region_inputs.palette_sig(m["palette_n"]) != m["palette_sig"]:
        return False
    return all((rdir(w) / n).exists() for n in ("core.npz", "vol.npz", "out.json")) and \
        all((OUT / "tiles" / t).exists() for t in m["tiles"])


def key_of(w, osm_hash, table, deps, used):
    """region w's key (region_inputs.region_key) with the decisions of the large features it looked up"""
    import region_inputs
    return region_inputs.region_key(w, osm_hash, deps, features={f: table.get(f) for f in used})


def write_manifest(w, osm_hash, table):
    import region_inputs
    out = json.load(open(rdir(w) / "out.json"))
    deps, used = out["deps"], sorted(out["features_used"])
    key, parts = key_of(w, osm_hash, table, deps, used)
    n = len(json.load(open(HERE / "palette.json"))["palette"])
    json.dump(dict(key=key, deps=deps, features_used=used, palette_n=n, palette_sig=region_inputs.palette_sig(n),
                   tiles=core_tiles(w), parts=parts), open(rdir(w) / "manifest.json", "w"), indent=0)


def stale_regions(ws, osm_hashes, table, force=()):
    """the regions to build: those forced, never built, or whose inputs or code changed since"""
    out = []
    for w in ws:
        f = rdir(w) / "manifest.json"
        m = json.load(open(f)) if f.exists() else None
        if w in force or m is None or "features_used" not in m or not fresh(w, key_of(w, osm_hashes[w], table, m["deps"], m["features_used"])[0]):
            out.append(w)
    return out


def why_stale(w, osm_hash, table):
    """what changed for region w since its build (for --status)"""
    f = rdir(w) / "manifest.json"
    if not f.exists():
        return "not built"
    m = json.load(open(f))
    if "features_used" not in m:
        return "built before the feature pass"
    _, now = key_of(w, osm_hash, table, m["deps"], m["features_used"])
    diff = [k for k in sorted(now) if json.dumps(now[k], sort_keys=True) != json.dumps(m["parts"].get(k), sort_keys=True)]
    for k in ("rasters", "raw", "code", "features"):
        if k in diff:
            diff[diff.index(k)] = k + ":" + ",".join(x for x in now[k] if now[k][x] != m["parts"][k].get(x))
    return "changed: " + " ".join(diff) if diff else ("palette or files" if not fresh(w, m["key"]) else "up to date")


def pick(ws, spec, flag="--only"):
    """the regions named by --only or --just, '+' or ','-separated: ROW_COL (a region's first map row and column, its
    cache folder's name) or x=COL,y=ROW (the region whose core holds that map cell)"""
    out = []
    for item in re.split(r"[+,](?!y=)", spec):
        if item.startswith("x="):
            c, r = (int(v.split("=")[1]) for v in item.split(","))
            hit = [w for w in ws if w.holds(r, c)]
        else:
            r0, c0 = map(int, item.split("_"))
            hit = [w for w in ws if (w.r0, w.c0) == (r0, c0)]
        if not hit:
            raise SystemExit(f"{flag} {item}: no such region in the cover {[f'{w.r0}_{w.c0}' for w in ws]}")
        out += hit
    return out


def driver_stamp(ws):
    """the hash of what the steps after the regions read: the regions' keys, their own code, the registry, the
    raw OSM (labels, traffic), the config"""
    import region_inputs
    keys = [json.load(open(rdir(w) / "manifest.json"))["key"] for w in ws]
    code = {f: region_inputs.code_sha(HERE / f) for f in ("regions.py", "labels.py", "landmarks.py", "traffic.py",
                                                         "tunnels.py", "underpass.py", "osm.py", "aoi.py", "tiles.py",
                                                         "window.py", "region.py", "passau.py", "mapstore.py",
                                                         "overrides.py", "ways.py")}
    import overrides
    d = dict(keys=keys, code=code, overrides=overrides.tree_sha(), palette=region_inputs.file_sha(HERE / "palette.json"),
             osm=region_inputs.file_sha(f"{aoi.RAW}/osm.json"), config=region_inputs.config_part(),
             env={k: os.environ.get(k) for k in ("FINALDUMP", "TRAFFICDUMP")})
    return region_inputs.sha(json.dumps(d, sort_keys=True).encode())


DRIVER_OUT = [OUT / "meta.json", Path("data/trees.json"), OUT / "traffic.json", Path("data/qa_roadmask.bin.gz"),
              Path("data/ground.npz"), Path("data/footprints.npz"), Path("data/crowns.npz"), Path("data/surface.npz")]


def main(argv):
    import region_inputs
    import tiles
    t_start = time.time()
    jobs, budget = plan(argv)
    ws = cover(argv)
    notes = []

    def note(*a):
        s = " ".join(str(x) for x in a)
        print(s)
        notes.append(s)

    OUT.mkdir(parents=True, exist_ok=True)
    DBG.mkdir(parents=True, exist_ok=True)
    levels = tiles.manifest(aoi.MAP_D, aoi.MAP_W)
    tiles.remove_stale(OUT / "tiles", levels, note, split=True)
    osm_hashes = region_inputs.cut_osm(ws, rdir)
    import sidecar
    for p in region_inputs.RASTERS:  # (uncompressed copies of the map-sized inputs: what the regions read of them)
        sidecar.ensure(p)
    just = pick(ws, argv[argv.index("--just") + 1], "--just") if "--just" in argv else None
    if just is not None and ("--only" in argv or "--force" in argv):
        raise SystemExit("--just goes with neither --only nor --force")
    if just is not None and "--status" not in argv:
        never = [f"{w.r0}_{w.c0}" for w in ws if w not in just and not (rdir(w) / "out.json").exists()]
        if never:
            raise SystemExit(f"--just: regions {never} were never built: run without --just first")
    force = ws if "--force" in argv else (pick(ws, argv[argv.index("--only") + 1]) if "--only" in argv else just or [])
    table = feature_pass(ws, jobs, osm_hashes, force, budget)
    if "--status" in argv:
        for w in ws:
            print(f"region {w.r0}_{w.c0} ({w}): {why_stale(w, osm_hashes[w], table)}")
        return
    todo = stale_regions(ws, osm_hashes, table, force)
    left = []
    if just is not None:  # the named regions alone: the others stay as they are, stale or not
        left = [w for w in todo if w not in just]
        todo = [w for w in todo if w in just]
    print(f"regions: {len(todo)} of {len(ws)} to build", [f"{w.r0}_{w.c0}" for w in todo], flush=True)
    if left:
        print(f"--just: {len(left)} regions are stale and were NOT built: {[f'{w.r0}_{w.c0}' for w in left]}; "
              "run without --just before committing data", flush=True)
    stamp_f = Path("data/cache/regions.stamp")
    if not todo and stamp_f.exists() and stamp_f.read_text() == driver_stamp(ws) and all(p.exists() for p in DRIVER_OUT):
        print(f"nothing to do: every region and the steps after them are up to date ({round(time.time() - t_start, 1)} s)")
        return
    stamp_f.unlink(missing_ok=True)
    stats = build(todo, jobs, budget=budget)
    res = {w: json.load(open(rdir(w) / "out.json")) for w in ws}
    # the palette: colours met that the registry lacks go into it (sorted), and the regions that met them again
    new = sorted({tuple(e) for r in res.values() for e in r["new_palette"]})
    if new:
        reg = json.load(open(HERE / "palette.json"))
        known = {tuple(e) for e in reg["palette"]}
        add = [list(e) for e in new if e not in known]
        note(f"palette: {len(add)} new colours added to scripts/palette.json")
        _write_palette(reg, add)
        again = [w for w in ws if res[w]["new_palette"]]
        stats.update(build(again, jobs, budget=budget))
        res.update({w: json.load(open(rdir(w) / "out.json")) for w in again})
        assert not any(res[w]["new_palette"] for w in ws), "the palette registry still lacks colours"
    for w in stats:
        write_manifest(w, osm_hashes[w], table)
    write_timings(stats, res)
    palette = [tuple(e) for e in json.load(open(HERE / "palette.json"))["palette"]]
    for w in ws:
        notes.append(f"--- region {w}: " + (f"{stats[w][0]} s, peak {stats[w][1]} MB" if w in stats else "up to date, kept"))
        notes.extend(res[w]["notes"])
    # the carriageways' centrelines, summed over the regions (voxelize.carriageway_sanity)
    for stage in res[ws[0]]["sanity"]:
        tot = {}
        for w in ws:
            for k, v in res[w]["sanity"][stage].items():
                tot[k] = tot.get(k, 0) + v
        bad = sorted(((v, k) for k, v in tot.items() if v >= 6), reverse=True)
        if bad:
            raise SystemExit(f"carriageways painted as pavement ({stage}): {bad[:8]}")

    # ---------------------------------------------------------------- rasters
    # (nothing of the map's size in memory: the regions' cores read on demand, the map-sized files written row band by
    # row band, mapstore.py)
    D_, W_ = aoi.MAP_D, aoi.MAP_W
    R = lambda key, dtype=None, **kw: mapstore.MapRaster(ws, rdir, key, dtype, **kw)  # noqa: E731
    g = R("g", np.int32)  # (the ground as int32, as the passes below took it)

    def npz_entry(key, dtype, tail=(), scale=1):
        r = R(key, dtype, scale=scale)
        return (D_ // scale, W_ // scale) + tuple(tail), dtype, (b_ for _, b_ in r.bands())

    mapstore.write_npz("data/ground.npz", dict(g=npz_entry("g", np.int16), rgb=npz_entry("rgb", np.uint8, (3,)),
                                               water=npz_entry("water", bool), b=npz_entry("b", np.int16)))
    mapstore.write_npz("data/footprints.npz", dict(oid=npz_entry("oid", np.int64)))
    # the continuous surfaces under the voxels, for the sloped caps (caps.py, run by tile_fields.py)
    mapstore.write_npz("data/surface.npz", dict(gt=npz_entry("gt", np.int16), deck=npz_entry("deck", np.float32),
                                                roof_z=npz_entry("roof_z", np.float32), roof_gx=npz_entry("roof_gx", np.float32),
                                                roof_gy=npz_entry("roof_gy", np.float32)))
    qa = R("qa", np.uint8)
    with gzip.GzipFile("data/qa_roadmask.bin.gz", "wb", compresslevel=9, mtime=0) as fh:  # mostly zeros: 12 MB -> ~0.3 MB
        for _, band in qa.bands():
            fh.write(band.tobytes())
    from PIL import Image
    for key, name in (("topdown", "topdown"), ("groundcol", "ground")):  # (debug images: the whole map up to 64 Mpx,
        if D_ * W_ <= 64e6:                                              # else one per region in data/debug/<name>/)
            Image.fromarray(R(key).box(0, D_, 0, W_)).save(DBG / f"{name}.png")
        else:
            (DBG / name).mkdir(exist_ok=True)
            for w in ws:
                Image.fromarray(np.load(rdir(w) / "core.npz")[key]).save(DBG / name / f"{w.r0}_{w.c0}.png")
    # the trees in the map's order; the crowns' owners as indices into it
    trees = sorted((t for w in ws for t in res[w]["trees"]), key=lambda t: t["key"])
    index = {t["rec"]["id"]: k for k, t in enumerate(trees)}
    luts = {(w.r0, w.c0): np.array([index.get(i, -1) for i in res[w]["crown_ids"]] + [-1], np.int32) for w in ws}
    cov = mapstore._Cover(ws)
    n_owned = [0]

    def owner_bands():  # (each core's crowns as indices into trees.json, band by band)
        for k, r0 in enumerate(cov.rcuts):
            r1 = cov.rcuts[k + 1] if k + 1 < len(cov.rcuts) else D_
            band = np.full(((r1 - r0) // 2, W_ // 2), -1, np.int32)
            for c0 in cov.ccuts:
                w = cov.at[(r0, c0)]
                band[:, w.c0 // 2:w.c1 // 2] = luts[(w.r0, w.c0)][np.load(rdir(w) / "core.npz")["crowns"]]
            n_owned[0] += int((band >= 0).sum())
            yield band
    mapstore.write_npz("data/crowns.npz", dict(owner=((D_ // 2, W_ // 2), np.int32, owner_bands())))
    note("2 m cells with a crown's owner for phenology:", n_owned[0])
    json.dump(dict(sources={"osm": "OpenStreetMap natural=tree",
                            "bv": "Einzelbäume 3D, Bayerische Vermessungsverwaltung (CC BY 4.0), 2024 flight",
                            "lidar": "a crown in the surface model with no known tree under it (trunk at its top)"},
                   fields=dict(x="grid column", y="grid row", z="ground voxel", h="crown top above ground, m",
                               sp="species or genus (Latin, as tagged)", cm="trunk circumference, cm", h_inv="tagged height, m",
                               drawn="lidar | procedural | none", h_bv="height in the Einzelbäume register, m",
                               con="a conifer, drawn as a cone (species, the species map, or its winter density and "
                                   "brightness in the laser scan): evergreen unless sp or sp_rs is a larch",
                               sp_rs="genus from the forests' species map (DLR Tree Species Germany 2022/2016, "
                                     "CC BY 4.0) where sp is unknown, or 'other broadleaved'"),
                   trees=[t["rec"] for t in trees]),
              open("data/trees.json", "w"), ensure_ascii=False, separators=(",", ":"))
    # the volume: the regions' own (for traffic.py), read where asked for (mapstore.MapVolume)
    Hm = max(r["Hm"] for r in res.values())
    vol = mapstore.MapVolume(ws, rdir, Hm)
    if os.environ.get("FINALDUMP"):  # the finished volume put together, for whole-city checks (traffic.py run alone;
        fv = np.lib.format.open_memmap("data/cache/final_vol.npy", "w+", np.uint16, (Hm, D_, W_))  # a map-sized file)
        for w in ws:
            v = mapstore.load_volume(rdir(w) / "vol.npz", (res[w]["Hm"], w.r1 - w.r0, w.c1 - w.c0))
            fv[:v.shape[0], w.r0:w.r1, w.c0:w.c1] = v
        fv.flush()
        del fv
        np.save("data/cache/final_g.npy", g.box(0, D_, 0, W_))

    # ---------------------------------------------------------------- the passes over the whole map: labels, presets,
    # traffic.json, network-wide over OSM's vectors and what the regions handed over, sampling the rasters
    # above where they need them (point lookups and boxes round a label: never the map's size)
    from osm import OSM
    import labels as labels_mod
    import landmarks
    import traffic
    import trafficpack
    import tunnels
    import underpass
    osm = OSM(f"{aoi.RAW}/osm.json")
    top = R(("g", "b"), np.int32, fn=lambda g_, b_: g_.astype(np.int32) + b_)
    cur = sorted((tuple(k), l) for w in ws for k, l in res[w]["labels"])
    found = {list(landmarks.LABELS)[k[1]]: l for k, l in cur if k[0] == 0}
    views = landmarks.make_views(found, g, median=hist_median([res[w]["g_hist"] for w in ws]))
    labels = labels_mod.assemble([l for _, l in cur], osm, lambda r, c: int(top[r, c]))
    labels_mod.radii(labels, g, top)
    tile_bytes = {}
    for w in ws:
        for s, (tot, nruns, ftot) in res[w]["tiles"].items():
            a = tile_bytes.setdefault(int(s), [0, 0, 0])
            a[0] += tot; a[1] += nruns; a[2] += ftot
    for lv in levels:
        tot, nruns, ftot = tile_bytes[lv["s"]]
        note(f"tiles level {lv['s']}: {lv['nx']}x{lv['ny']} nodes, {nruns} runs, {tot / 2 ** 20:.1f} MB gz"
             + (f", foliage {ftot / 2 ** 20:.1f} MB gz" if lv["s"] == 1 else ""))
    tile_info = dict(N=tiles.N, levels=levels, bytes=sum(v[0] for v in tile_bytes.values()))
    jets = [j for _, j in sorted((tuple(k), j) for w in ws for k, j in res[w]["jets"])]
    lamps = [l for _, l in sorted((tuple(k), l) for w in ws for k, l in res[w]["lamps"])]
    meta = dict(W=aoi.MAP_W, D=aoi.MAP_D, H=Hm, base=aoi.BASE, origin=[aoi.MAP_C0, aoi.MAP_R0], tiles=tile_info, center=[aoi.CX, aoi.CY],
                theta_deg=math.degrees(aoi.THETA), crs="EPSG:25832", jets=jets,
                palette=[list(e) for e in palette], lamps=lamps, labels=labels, views=views,
                sources=dict(osm=osm.timestamp,
                             elevation="Bayerische Vermessungsverwaltung, DOM20 + DGM1 + LoD2 (CC BY 4.0)",
                             ortho="Bayerische Vermessungsverwaltung, DOP20 (CC BY 4.0)",
                             landuse="Bayerische Vermessungsverwaltung, ALKIS Tatsächliche Nutzung (CC BY 4.0)",
                             trees="Bayerische Vermessungsverwaltung, Laserdaten (2021) + Einzelbäume 3D (2024) (CC BY 4.0)",
                             **({"tree_species": "Tree Species Germany 2022/2016, DLR Earth Observation Center (Wegler et al.) "
                                 "(CC BY 4.0)"} if list(Path(aoi.RAW).glob("treespecies_*.tif")) else {})))
    json.dump(meta, open(OUT / "meta.json", "w"))
    # traffic.py over the whole network, on what the regions handed over
    traffic.OPEN_CUT = {o for r in res.values() for o in r["open_cut"]}
    underpass.WALK, underpass.IDS = R("walk", np.int16), {o for r in res.values() for o in r["walk_ids"]}
    tunnels.FLOOR, tunnels.IDS = R("floor", np.int16), {o for r in res.values() for o in r["bore_ids"]}
    skip = np.zeros(len(palette) + 64, bool)
    ids = res[ws[0]]["ids"]
    skip[[i for i, e in enumerate(palette) if e[3] in (3, 5, 11, 23)] + [ids["trunk"], ids["pole"], ids["fence"]]] = True  # (leaf, lamp, car, wood)
    solid = ~skip
    solid[0] = False
    tin = dict(g=g, nd_mean=R("deck_near", np.float32), surf=qa, water=R("twater", bool), solid=solid)
    if os.environ.get("TRAFFICDUMP"):  # what traffic.py takes, to rebuild traffic.json alone (uv run python scripts/traffic.py;
        import pickle                  # the rasters put together: map-sized)
        whole = lambda a: a.box(0, D_, 0, W_) if isinstance(a, mapstore.MapRaster) else a  # noqa: E731
        pickle.dump(dict({k: whole(v) for k, v in tin.items()}, open_cut=traffic.OPEN_CUT, walk=whole(underpass.WALK),
                         ids=underpass.IDS, bore=whole(tunnels.FLOOR), bore_ids=tunnels.IDS), open("data/cache/traffic_in.pkl", "wb"))
    json.dump(trafficpack.pack(traffic.build(note=note, vol=vol, **tin)), open(OUT / "traffic.json", "w"), separators=(",", ":"))
    # debug lists of the regions, one after the other
    for name in ("lod2_reverted", "thin_parts", "floating", "floating_left", "supports"):
        items = []
        for w in ws:
            f = rdir(w) / f"{name}.json"
            if f.exists():
                items += json.load(open(f))
        json.dump(items, open(DBG / f"{name}.json", "w"))
    import resource
    note(f"regions: {len(ws)} ({len(stats)} built), {round(time.time() - t_start)} s in all; per region built (s, peak MB):",
         {str(w): stats[w] for w in stats}, "; the steps after them: peak",
         round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024), "MB")
    json.dump({"notes": notes}, open(DBG / "report.json", "w"), indent=1, ensure_ascii=False)
    if just is None:
        stamp_f.write_text(driver_stamp(ws))
        print("done")
    else:  # (no stamp: the next plain build builds the regions left stale and runs the steps above again)
        print(f"done (--just: the named regions only{f'; {len(left)} regions are stale and were NOT built, run without --just before committing data' if left else ''})")


def write_timings(stats, res):
    """the regions built: per region its wall time, peak RSS and stages (voxelize.stage) into data/debug/timings.json,
    and the stages summed over them printed"""
    if not stats:
        return
    per = {f"{w.r0}_{w.c0}": dict(wall=stats[w][0], peak_mb=stats[w][1], timing=res[w].get("timing", [])) for w in stats}
    json.dump(per, open(DBG / "timings.json", "w"), indent=1)
    tot, peak = {}, {}
    for r in per.values():
        for name, dt, _, pk in r["timing"]:
            tot[name] = tot.get(name, 0) + dt
            peak[name] = max(peak.get(name, 0), pk)
    cpu = sum(tot.values()) or 1
    print(f"stages over the {len(per)} regions built (s summed, share, the largest peak RSS by then):")
    for name, dt in tot.items():
        print(f"  {name:40s} {dt:8.1f} s {100 * dt / cpu:5.1f} %  {peak[name]:6d} MB")


def hist_median(hists):
    """np.median of the map's ground (int), from the regions' histograms of their cores [(lowest value, counts)]"""
    tot = {}
    for lo, counts in hists:
        for k, n in enumerate(counts):
            if n:
                tot[lo + k] = tot.get(lo + k, 0) + n
    vals = sorted(tot)
    n = sum(tot.values())
    cum, lo_v, hi_v = 0, None, None
    for v in vals:
        cum += tot[v]
        if lo_v is None and cum >= (n + 1) // 2:  # the (n-1)//2-th value (0-based)
            lo_v = v
        if cum >= n // 2 + 1:  # the n//2-th
            hi_v = v
            break
    return (lo_v + hi_v) / 2


def tunnelish(t):
    """voxelize.tunnelish"""
    import re

    def num(v):
        m = re.match(r"\s*(-?[0-9]+(?:[.,][0-9]+)?)", str(v))
        return float(m.group(1).replace(",", ".")) if m else None
    lv = num(t.get("level", "0").split(";")[0] or 0)
    return t.get("tunnel") in ("yes", "building_passage", "culvert") or num(t.get("layer", 0)) < 0 \
        or t.get("covered") == "yes" or t.get("indoor") == "yes" or t.get("location") == "underground" \
        or bool(lv and lv < 0)


def _write_palette(reg, add):
    pal = reg["palette"] + add
    s = '{"about": ' + json.dumps(reg["about"], ensure_ascii=False) + ',\n "palette": [\n'
    s += ",\n".join("  " + json.dumps(e) for e in pal) + "\n ]\n}\n"
    (HERE / "palette.json").write_text(s)
