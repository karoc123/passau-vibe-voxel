"""voxelize.py's driver: the map built region by region and put together.

usage: uv run python scripts/voxelize.py [--regions NXxNY | --region-size METRES] [-j JOBS]
  (the whole map as one region by default; every cover writes the same bytes, scripts/region_check.py)

A region is a core of the map on window.ALIGN (1024 m) boundaries (window.py) and a halo of region.HALO metres round
it. Each region is built by voxelize.py in a process of its own (VOXEL_REGION, VOXEL_CORE, VOXEL_OUT in its
environment), which writes the tiles of its core and leaves in data/cache/regions/<row>_<col>/ its core's rasters
(core.npz), its core's volume (vol.npy) and what lies in its core of the lists (out.json). Then, here:
- the palette: colours the registry (scripts/palette.json) lacked are added to it, sorted, and the regions that met
  them built again (their ids were provisional)
- stitched: data/ground.npz, data/footprints.npz, data/crowns.npz, qa_roadmask.bin.gz, trees.json (in the map's
  order, the crowns' owners as indices into it), meta.json's lamps and jets, the debug images and lists
- the global context passes, on the whole map for now (WP6b-2 must make them region by region or network-wide
  passes over what the regions hand over): the labels (labels.py: the parks', each curated label's top over its whole
  outline, the decluttering, their radii), the camera presets (landmarks.make_views), the tram paths and traffic.json
  (traffic.py: the network over data/cache/vol.npy, the regions' volumes put together, read as a memory map), the
  carriageway check summed over the regions. flood.py and boats.py stay whole-map steps of their own.
"""
import gzip
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

import aoi
import region
import window

OUT = Path("web/public/data")
DBG = Path("data/debug")
CACHE = Path("data/cache/regions")
HERE = Path(__file__).resolve().parent


def cover(argv):
    for i, a in enumerate(argv):
        if a == "--regions":
            nx, ny = map(int, argv[i + 1].lower().split("x"))
            return window.split(aoi.MAP_D, aoi.MAP_W, nx, ny)
        if a == "--region-size":
            return window.cover(aoi.MAP_D, aoi.MAP_W, int(argv[i + 1]))
    return window.cover(aoi.MAP_D, aoi.MAP_W, None)


def rdir(w):
    return CACHE / f"{w.r0}_{w.c0}"


def build(ws, jobs):
    """voxelize.py over each region in a process of its own, up to `jobs` at once; per region (wall s, peak RSS MB)"""
    todo, running, stats = list(ws), {}, {}
    while todo or running:
        while todo and len(running) < jobs:
            w = todo.pop(0)
            ra, rb, ca, cb = w.region(region.HALO)
            env = dict(os.environ, VOXEL_REGION=f"{ra},{rb},{ca},{cb}", VOXEL_CORE=f"{w.r0},{w.r1},{w.c0},{w.c1}",
                       VOXEL_OUT=str(rdir(w)), PYTHONUNBUFFERED="1")
            rdir(w).mkdir(parents=True, exist_ok=True)
            log = open(rdir(w) / "log.txt", "w")
            p = subprocess.Popen([sys.executable, str(HERE / "voxelize.py")], env=env, stdout=log, stderr=subprocess.STDOUT)
            running[p.pid] = (w, time.time(), log)
            print(f"region {w} (with its halo rows {ra}-{rb}, cols {ca}-{cb}): started", flush=True)
        pid, status, ru = os.wait4(-1, 0)
        w, t0, log = running.pop(pid)
        log.close()
        if status != 0:
            print((rdir(w) / "log.txt").read_text()[-3000:])
            raise SystemExit(f"region {w} failed")
        stats[w] = (round(time.time() - t0, 1), round(ru.ru_maxrss / 1024))
        print(f"region {w}: {stats[w][0]} s, peak {stats[w][1]} MB", flush=True)
    return stats


def stitch(ws, key, dtype, tail=(), scale=1):
    """a map-sized raster from the regions' cores (core.npz[key])"""
    out = np.zeros((aoi.MAP_D // scale, aoi.MAP_W // scale) + tuple(tail), dtype)
    for w in ws:
        a = np.load(rdir(w) / "core.npz")[key]
        out[w.r0 // scale:w.r1 // scale, w.c0 // scale:w.c1 // scale] = a
    return out


def main(argv):
    import tiles
    t_start = time.time()
    jobs = int(argv[argv.index("-j") + 1]) if "-j" in argv else 1
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
    stats = build(ws, jobs)
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
        stats.update(build(again, jobs))
        res.update({w: json.load(open(rdir(w) / "out.json")) for w in again})
        assert not any(res[w]["new_palette"] for w in ws), "the palette registry still lacks colours"
    palette = [tuple(e) for e in json.load(open(HERE / "palette.json"))["palette"]]
    for w in ws:
        notes.append(f"--- region {w}: {stats[w][0]} s, peak {stats[w][1]} MB")
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
    g = stitch(ws, "g", np.int16)
    b = stitch(ws, "b", np.int16)
    np.savez_compressed("data/ground.npz", g=g, rgb=stitch(ws, "rgb", np.uint8, (3,)), water=stitch(ws, "water", bool), b=b)
    np.savez_compressed("data/footprints.npz", oid=stitch(ws, "oid", np.int64))
    qa = stitch(ws, "qa", np.uint8)
    with gzip.GzipFile(OUT / "qa_roadmask.bin.gz", "wb", compresslevel=9, mtime=0) as fh:  # mostly zeros: 12 MB -> ~0.3 MB
        fh.write(qa.tobytes())
    from PIL import Image
    Image.fromarray(stitch(ws, "topdown", np.uint8, (3,))).save(DBG / "topdown.png")
    Image.fromarray(stitch(ws, "groundcol", np.uint8, (3,))).save(DBG / "ground.png")
    # the trees in the map's order; the crowns' owners as indices into it
    trees = sorted((t for w in ws for t in res[w]["trees"]), key=lambda t: t["key"])
    index = {t["rec"]["id"]: k for k, t in enumerate(trees)}
    owner = np.full((aoi.MAP_D // 2, aoi.MAP_W // 2), -1, np.int32)
    for w in ws:
        lut = np.array([index.get(i, -1) for i in res[w]["crown_ids"]] + [-1], np.int32)
        a = np.load(rdir(w) / "core.npz")["crowns"]
        owner[w.r0 // 2:w.r1 // 2, w.c0 // 2:w.c1 // 2] = lut[a]
    np.savez_compressed("data/crowns.npz", owner=owner)
    note("2 m cells with a crown's owner for phenology:", int((owner >= 0).sum()))
    json.dump(dict(sources={"osm": "OpenStreetMap natural=tree",
                            "bv": "Einzelbäume 3D, Bayerische Vermessungsverwaltung (CC BY 4.0), 2024 flight",
                            "lidar": "a crown in the surface model with no known tree under it (trunk at its top)"},
                   fields=dict(x="grid column", y="grid row", z="ground voxel", h="crown top above ground, m",
                               sp="species or genus (Latin, as tagged)", cm="trunk circumference, cm", h_inv="tagged height, m",
                               drawn="lidar | procedural | none", h_bv="height in the Einzelbäume register, m",
                               con="a conifer (species, or its winter density in the laser scan): evergreen"),
                   trees=[t["rec"] for t in trees]),
              open(OUT / "trees.json", "w"), ensure_ascii=False, separators=(",", ":"))
    # the volume put together (for traffic.py; FINALDUMP: for scripts/floating.py), a memory map
    Hm = max(r["Hm"] for r in res.values())
    vol = np.lib.format.open_memmap("data/cache/vol.npy", "w+", np.uint16, (Hm, aoi.MAP_D, aoi.MAP_W))
    for w in ws:
        v = np.load(rdir(w) / "vol.npy", mmap_mode="r")
        vol[:v.shape[0], w.r0:w.r1, w.c0:w.c1] = v
    vol.flush()
    vol = np.load("data/cache/vol.npy", mmap_mode="r")
    if os.environ.get("FINALDUMP"):  # the finished volume, for whole-city checks (scripts/floating.py)
        np.save("data/cache/final_vol.npy", vol)
        np.save("data/cache/final_g.npy", g.astype(np.int32))

    # ---------------------------------------------------------------- global context passes (whole map, WP6b-2)
    from osm import OSM
    import labels as labels_mod
    import landmarks
    import traffic
    import tunnels
    import underpass
    osm = OSM()
    gi = g.astype(np.int32)
    top = gi + b
    cur = sorted((tuple(k), l) for w in ws for k, l in res[w]["labels"])
    found = {list(landmarks.LABELS)[k[1]]: l for k, l in cur if k[0] == 0}
    views = landmarks.make_views(found, gi)
    labels = labels_mod.assemble([l for _, l in cur], osm, lambda r, c: int(top[r, c]))
    labels_mod.radii(labels, gi, top)
    # tram routes for the animated trams: merged open-air tram tracks, sampled every metre with ground z
    from shapely.ops import linemerge
    tram_lines = linemerge([l for oid, t, l in osm.lines_with("railway", ("tram",)) if not tunnelish(t)])
    tram_lines = list(getattr(tram_lines, "geoms", [tram_lines]))
    trams = []
    for ln in sorted(tram_lines, key=lambda l: -l.length):
        if ln.length < 180:
            continue
        path = []
        for d in np.arange(0, ln.length, 2.0):
            p = ln.interpolate(d)
            c, r = min(max(int(p.x), 0), aoi.MAP_W - 1), min(max(int(p.y), 0), aoi.MAP_D - 1)
            path.append([round(p.x, 1), round(p.y, 1), int(gi[r, c])])
        trams.append(path)
    note("tram paths:", len(trams), "total km", round(sum(len(p) for p in trams) * 2 / 1000, 2))
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
    meta = dict(W=aoi.MAP_W, D=aoi.MAP_D, H=Hm, base=aoi.BASE, tiles=tile_info, center=[aoi.CX, aoi.CY],
                theta_deg=math.degrees(aoi.THETA), crs="EPSG:25832", trams=trams, jets=jets,
                palette=[list(e) for e in palette], lamps=lamps, labels=labels, views=views,
                sources=dict(osm=res[ws[0]]["osm_timestamp"],
                             elevation="Bayerische Vermessungsverwaltung, DOM20 + DGM1 + LoD2 (CC BY 4.0)",
                             ortho="Bayerische Vermessungsverwaltung, DOP20 (CC BY 4.0)",
                             landuse="Bayerische Vermessungsverwaltung, ALKIS Tatsächliche Nutzung (CC BY 4.0)",
                             trees="Bayerische Vermessungsverwaltung, Laserdaten (2021) + Einzelbäume 3D (2024) (CC BY 4.0)"))
    json.dump(meta, open(OUT / "meta.json", "w"))
    # traffic.py over the whole network, on what the regions handed over
    traffic.OPEN_CUT = {o for r in res.values() for o in r["open_cut"]}
    underpass.WALK, underpass.IDS = stitch(ws, "walk", np.int16), {o for r in res.values() for o in r["walk_ids"]}
    tunnels.FLOOR, tunnels.IDS = stitch(ws, "floor", np.int16), {o for r in res.values() for o in r["bore_ids"]}
    skip = np.zeros(len(palette) + 64, bool)
    ids = res[ws[0]]["ids"]
    skip[[i for i, e in enumerate(palette) if e[3] in (3, 5, 11, 23)] + [ids["trunk"], ids["pole"], ids["fence"]]] = True  # (leaf, lamp, car, wood)
    solid = ~skip
    solid[0] = False
    tin = dict(g=gi, nd_mean=stitch(ws, "deck_near", np.float32), surf=qa, water=stitch(ws, "twater", bool), solid=solid)
    if os.environ.get("TRAFFICDUMP"):  # what traffic.py takes, to rebuild traffic.json alone (uv run python scripts/traffic.py)
        import pickle
        pickle.dump(dict(tin, open_cut=traffic.OPEN_CUT, walk=underpass.WALK, ids=underpass.IDS, bore=tunnels.FLOOR,
                         bore_ids=tunnels.IDS), open("data/cache/traffic_in.pkl", "wb"))
    json.dump(traffic.build(note=note, vol=vol, **tin), open(OUT / "traffic.json", "w"), separators=(",", ":"))
    # debug lists of the regions, one after the other
    for name in ("lod2_reverted", "thin_parts", "floating", "floating_left", "supports"):
        items = []
        for w in ws:
            f = rdir(w) / f"{name}.json"
            if f.exists():
                items += json.load(open(f))
        json.dump(items, open(DBG / f"{name}.json", "w"))
    note(f"regions: {len(ws)}, {round(time.time() - t_start)} s in all; per region (s, peak MB):",
         {str(w): stats[w] for w in ws})
    json.dump({"notes": notes}, open(DBG / "report.json", "w"), indent=1, ensure_ascii=False)
    print("done")


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
