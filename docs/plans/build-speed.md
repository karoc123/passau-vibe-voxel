# Plan: a faster data build (full rebuild ~45 min -> ~15 min, typical incremental change ~12 min -> ~5 min)

Repo: `/home/zink/dev/tmp-voxel-passau/warsaw-vibe-voxel`, `main` @ `23e8107e`, working tree clean.
This file is self-contained: implement from it alone. Analysis only was done; nothing in the repo was changed.

Scratch directory of this analysis (probes you can rerun, each takes seconds, single core):
`/tmp/claude-1000/-home-zink-dev-tmp-voxel-passau/b7ca55d2-1927-44ae-8817-32b6764a94dc/scratchpad/build-speed/`
(`probe_export.py`, `probe_wallmode.py`, `probe_sidewalls.py`, `probe_misc.py`, `probe_river.py`, `sim.py`).
Run them from the repo root with `OMP_NUM_THREADS=1 .venv/bin/python <probe>`.

Marking used below: **measured** = from the logs of the last full build or from a probe; **estimate** = derived, not
measured. Every estimate must be replaced by a measurement in step S0 before you rely on it.

Hard constraints (unchanged, from the project and the organisation's policy):

- The build must write **byte-identical** `web/public/data` and the same arrays in `data/*.npz` for unchanged inputs.
  `web/public/data` is committed (4752 files) and reproduces byte for byte today, so `git status --porcelain
  web/public/data` printing nothing after a rebuild is the strongest gate there is.
- No new dependencies (everything below needs only numpy/scipy/stdlib and node's stdlib).
- `scripts/palette.json` append-only; no secrets; synthetic data only in tests; never push.
- A full rebuild of the real map is long and rewrites shared data: **ask the user before starting it** (step V3).
  Do not touch CI/infrastructure.

---

## 1. Where the time goes (last full build, 2026-11-20 22:21 -> 23:07, all 40 regions built)

Machine: WSL2, i7-13700H (6 P-cores + 8 E-cores, 20 threads), 39 GB RAM (36 GB available), 10 GB swap.
`scripts/map.json`: `regions: {size: 1024, jobs: 4}`. Map 9344 x 3456 cells, 40 regions (10 x 4; the last column is
128 wide, the last row 384 high).

### 1.1 Wall clock per stage (measured from file mtimes, stamps and `data/debug/report.json`)

| stage | wall | share | parallelism |
|---|---|---|---|
| prep / lod2 / laser (`build_data.sh`, only when `data/raw` changes) | ~4 min (lod2 43 s, laser 142 s; prep's start not logged) | (not counted below) | serial, 1 core each |
| `regions.py` start: `cut_osm` (load 23 MB OSM, project, cut 40 x) | 32 s | 1.3 % | 1 core |
| feature pass (40 x `voxelize.py` with `VOXEL_FEATURES`, 13-17 s each) | 131 s | 5.3 % | 4 jobs |
| **regions (40 x `voxelize.py`)** | **1924 s = 32.1 min** | **77.5 %** | 4 jobs of 20 threads, RAM-bound |
| driver tail in `regions.py` (ground/footprints/crowns.npz, labels, traffic.json, meta.json) | 56 s | 2.3 % | 1 core |
| post steps places..phenology (8 steps) | 96 s (flood 43 s, phenology 20 s, zones 10 s, boats 7 s, ...) | 3.9 % | serial |
| `tile_fields.py` (whole map as one window, rewrites all 4633 node files) | 57 s | 2.3 % | 1 core |
| `web/tools/tris.mjs` (4633 mesh jobs + 1971 foliage jobs) | 188 s | 7.6 % | 1 core |
| lamps, world_id | ~2 s | | |
| **total without prep/lod2/laser** | **~41.5 min** | | |

The critical path is one chain: fpass -> regions -> driver tail -> post steps -> tile_fields -> tris. Average CPU use
during the region phase is 4 of 20 threads; during the 6.5 min after it, 1 of 20.

### 1.2 Per region (sum over the 40 regions: 7642 s CPU; from the `[ n s]` notes in `data/cache/regions/*/log.txt`)

| stage inside `voxelize.py` | sum | share |
|---|---|---|
| start to first note: imports, **inflating prep/lod2/laser.npz up to the region's last row**, `ground_walls` | 625 s | 8.2 % |
| ground classes, roads, water, buildings, roofs | 613 s | 8.0 % |
| natural ground, cemeteries, building details | 199 s | 2.6 % |
| vegetation (canopy, crowns, branches) | 507 s | 6.6 % |
| furniture, bridges, vehicles, landmarks, underpasses, tunnels | 161 s | 2.1 % |
| `debris.drop_debris` | 516 s | 6.8 % |
| the block between the notes "final height" and "river colours" (lines ~3654-3698) | 568 s | 7.4 % (unexplained, see P4) |
| `debris.support_floating` (two rounds) | 841 s | 11.0 % |
| plane codes | 61 s | 0.8 % |
| **tail after the last note: `tiles.export_window`, rasters, core.npz, vol.npz** | **3551 s** | **46.5 %** |

Worst region `2048_7168` (Altstadt): 316 s, of which 142 s tail. Peak RSS per region: 1.6-2.2 GB (bottom row),
3.1-4.2 GB (top row), 3.8-5.3 GB (interior rows).

Findings that drive the plan:

1. **`tiles.wall_mode` is ~1/3 of the whole build.** Measured on a real 288 x 288 x 162 Altstadt window
   (`probe_export.py`): `tiles.downsample` with `wall_ids` costs 0.72 s / 1.15 s / 5.9 s at levels 2 / 4 / 8, without
   them 0.14 / 0.13 / 0.11 s. Scaled to a region's export box (1056 x 1056): ~94 s per full region, i.e. ~2600-2900 s of
   the 3551 s tail. `wall_mode` loops `s^3` times (512 at level 8) over *every* block, and the underground fill counts
   as a wall material, so 80 % of the blocks take the slow path; `side_walls` then reads the result only at blocks
   that are solid and face open air (147 of 27216 blocks at level 8 in the probe).
2. **RAM, not CPU, limits parallelism.** 4 jobs x <= 5.3 GB = 21 GB of 36 GB available. `sim.py` reproduces the
   measured 32.1 min exactly and gives 21.8 min for 6 jobs in order (peak 28.9 GB), 19.9 min for a 28 GB budget.
   The peak is roughly 1.5 GB per million region cells: the volume is 0.46 GB of that, the rest is ~100 full-region
   float64 temporaries that the module-level script never frees (estimate; S0 measures it).
3. **Every region re-inflates the map-sized inputs from the start of each array.** `window.npz_rows` seeks forward in
   a deflate stream (`prep.npz`: 2.9 GB raw, `orto` alone 2.3 GB; inflate measured 230 MB/s): a bottom-row region
   inflates ~4 GB before it starts (~15 s), a top-row one ~1.5 GB. The feature pass pays the same again: its 13-17 s
   per region are almost only this.
4. The halo makes the regions compute 2.85 x the map's area (92 M cells for 32 M). Larger regions would cut that
   (2048 m: 1.62 x) but need 2.1 x the RAM per process, so fewer run at once: no net gain on this machine. The halo
   itself (384 m) is a correctness contract (`scripts/region.py`). **Not touched.**
5. Synthesis before the back end is cheap: everything up to the vegetation is ~19 % of a region, up to the debris
   pass ~27 %. A disk checkpoint between early stages can save at most that, and costs about as much to write
   (see "Rejected").
6. After the regions, `tile_fields.py` rewrites every node file whether it changed or not (`tilefile.write` always
   writes), so `stamp.py`'s folder signature (names, sizes, mtimes) of `tiles/` changes and `tris.mjs` re-meshes all
   4633 nodes (188 s) even when one region changed. Any edit under `web/src` (the stamp's input is the whole folder)
   does the same.
7. `region_inputs.region_key` hashes whole dependency modules. Editing a function only the driver uses
   (`mapstore.MapRaster`, `region_inputs` itself, `landmarks.make_views`, `window.py`'s readers) rebuilds all regions.

---

## 2. Targets

| scenario | today | after P1-P8 (required part) | stretch (with P9, P12) |
|---|---|---|---|
| full rebuild of all regions (a change in `voxelize.py`, `landmarks.py`, `overrides.py`, ...), cached `data/raw` and prep | ~42 min (the user's "45-60 min" with prep or a busy machine) | **~15 min** (fpass 0.7 + regions ~11-12 + driver 1 + post ~1.7) | ~12 min |
| one object / override changed (1-4 regions) | ~12 min (regions ~5, cut 0.5, driver 1, post 5.7) | **~5 min** | ~4 min |
| `caps.py` tuned (surface caps, after that plan lands) or a post-step input changed | ~5 min (tile_fields + all of tris) | **~1-1.5 min** | |
| nothing changed | ~40 s (cut_osm) | ~40 s | ~8 s (P11) |

The region phase estimate: per-region CPU 7642 s -> ~4300 s (P1 -2700, P2 -450, P3 -250; P4 unknown, not counted),
run 6 at once under a 28 GB budget: `sim.py` gives 11.4 min ideal; +15-25 % for E-cores/hyper-threads/thermal on this
laptop CPU is already in the "11-12". If S0 shows the contention is worse, say so in the report rather than raising
the job count.

---

## 3. Verification protocol (applies to every step)

**V0, before the first code change** (records what "identical" means; ~15 min, light):

```sh
cd /home/zink/dev/tmp-voxel-passau/warsaw-vibe-voxel
G=<your scratch dir>/golden
uv run python scripts/check.py golden --record $G/altstadt                                        # ~5 min
uv run python scripts/check.py golden --record $G/hals --fixture scripts/fixtures/hals.json       # hills, a weir, forest: ~7 min
( cd web && node tools/mesh-golden.mjs write $G/mesh.json )
# digest of the real map's outputs that are not in git (data/*.npz arrays, data/*.bin, trees.json, qa mask):
PYTHONPATH=scripts uv run python -c "import json,check; json.dump(check.digest(check.ROOT), open('$G/map-digest.json','w'))"
git status --porcelain web/public/data   # must print nothing now; if it does, stop and tell the user
```

Check first that no other agent is running a fixture build in `data/check/` (`pgrep -af 'check.py|voxelize.py'`);
the fixture workspaces are shared.

**V1, after each step** (the step's own gates are listed with it): `check.py golden --compare $G/altstadt` and
`--compare $G/hals` (add `--incremental` only for a quick first look; the final compare of a step is from scratch).

**V2, for the steps that touch region-local logic or windowed steps** (P1, P2, P7): `uv run python scripts/check.py
covers` and `uv run python scripts/check.py windows tile_fields tiles_lod`, plus
`uv run python scripts/tile_roundtrip.py`, `( cd web && node tools/tile-roundtrip.mjs )`,
`( cd web && node tools/mesh-golden.mjs check $G/mesh.json )`.

**V3, once, at the end (ask the user first):** one full `sh scripts/build_data.sh` on the real map. Then
`git status --porcelain web/public/data` must print nothing, and the digest above, taken again, must equal
`$G/map-digest.json`. This run is also the measurement of the new timings: report the table of section 1.1 again.
The code changes of P1/P2/P5 change the regions' code hash, so this rebuild happens anyway; do it once, after all of
P1-P8 are in, not once per step.

A note on what the gates do *not* cover: `data/debug/*` and `data/cache/**/out.json` are not hashed anywhere. Keep
the `note()` texts and their order unchanged anyway (`check.py verify` parses them), and put timings only into
`print` lines and new, separate files.

---

## 4. Steps, in the order to implement

Ranking (gain per effort, risk): **P1 > P6+P7 > P5 > P3 > P2 > P8 > P10 > P4 > P9 > P11 > P12.**
The order below is the order of work (measure first, then the cheap big wins).

### S0. Instrument (30 min of work; no output changes)

- `scripts/voxelize.py`: a helper `stage(name)` next to `note()` that **prints** (does not append to
  `report["notes"]`) the seconds since the last stage and `resource.getrusage(RUSAGE_SELF).ru_maxrss`, and collects
  `(name, seconds, maxrss_mb)` into `RESULT["timing"]`. Call it at ~15 boundaries: after the rasters are loaded
  (line ~199), after `cellcol`/`lum` (~280), after OSM, before "buildings" (~971), "natural ground" (~1826),
  "vegetation" (~2186), "fountains" (~2824), "bridges" (~3050), before/after `drop_debris` (~3651), after the Hm
  crop, after the river block (~3698), before/after `support_floating`, after `plane_codes`, after
  `tiles.export_window` (and inside `export_window`: per level, `downsample` vs node writing, as prints), after
  `np.savez`, after `save_volume`.
- `scripts/regions.py`: after the builds, write `data/debug/timings.json` (per region: wall, peak, its `timing` list)
  and print the per-stage sums; write `<rdir>/stats.json` `{wall, peak_mb}` per built region (P5 reads it).
- Run one fixture build (`check.py build`, ~5 min) to get the first table. Two questions it must answer:
  1. Which statement between the notes "final height" and "river colours" costs ~6.5 us per region cell (20 s on an
     interior region, 568 s in all)? It scales with the region's area, not with its water (a region with 674 water
     cells pays it too). My probes of the obvious candidates on real data found them all cheap (`nanmedian` 0.1 s,
     erosion/dilation 0.01 s, `np.unique(axis=0)` 0.3 s), so time it line by line.
  2. At which stage is the RSS peak, and which arrays hold it (use `tracemalloc` on one fixture region if the stage
     table does not make it obvious).

Verify: golden compare (nothing may change; `out.json` is not hashed).

### P1. `tiles.downsample`: the wall mode only where `side_walls` reads it

Gain: **~95 s per full region, ~2700 s CPU in all = ~11 min of the 32 min region phase at 4 jobs** (measured:
7.4 s -> 0.38 s on the probe window, 20 x; output identical at levels 2, 4, 8 with the cascade). Also makes
`tiles_lod.py` and `check.py windows` several times faster. Effort: ~1 h. Risk: low.

What: in `scripts/tiles.py` `downsample`, stop filling `wmode` per band. After the loop over the bands (when `out` is
complete), compute the mask of the blocks `side_walls` can change, and the mode only for those:

```python
def side_walls(out, vol, s, is_wall):
    solid = out != 0
    face = ...                      # exactly today's loop over the four sides (np.roll, edge rows/cols cleared)
    zi, yi, xi = np.nonzero(solid & face)
    # in chunks of ~20000 blocks (bounded memory):
    #   f[n, k] = the block's s^3 voxels in wall_mode's order k = dz*s*s + dy*s + dx, 0 beyond vol (as np.pad gave)
    #   w = is_wall[f]; nw = w.sum(1); nz = (f != 0).sum(1)
    #   best/bestn by the same loop over k as wall_mode (same strict `n > bestn`, so the same tie-break)
    #   wm = np.where((nw > 0) & (2 * nw >= nz), best, 0)
    #   out[zi, yi, xi] = wm where wm != 0
```

A working reference is `downsample_fast` in `probe_sidewalls.py` (it gathers with clipped indices and an `ok` mask;
it calls `tiles.downsample(..., None, finer)` for pass 1, which is what the new code does inline). Nothing outside
`tiles.py` uses `wall_mode` or `side_walls` (grepped; `window.py` only mentions `side_walls` in a comment), so
`wall_mode` can go.

Why it is identical: `side_walls` writes `out[k] = wmode[k]` only where `k = solid & face & (wmode != 0)`; a block's
`wmode` depends only on its own `s^3` voxels; the face mask is computed from the complete `out` in both versions.

Verify: `probe_sidewalls.py` adapted to call the new function on a window (seconds); `uv run python
scripts/tiles_lod.py --check` on the real map (rebuilds level 8 through the cascade into `data/tiles_lod/` and
compares voxel sections with the committed tiles: must report all identical; it writes nothing under
`web/public/data`); V1; V2 (`windows tiles_lod`, `covers`).

### P2. `debris._owned`: label only the layers that can hold a piece

Gain: estimate 10-15 s (`drop_debris`) + 15-20 s (`support_floating`) per interior region, ~450 s CPU in all (-6 %).
Effort: ~2 h. Risk: low-medium (connectivity code; the fixtures cover it, `check.py covers` proves region-locality).

Today each of the ~196 block boxes (194 x 194 columns) is labelled over the full height (230 layers in
`drop_debris`, which runs before the Hm crop; 160-230 in `support_floating`), three passes per region. Measured:
~0.07 s per box per pass for `ndimage.label`, plus `occ_of`.

What (all inside `_owned`, the callers' logic unchanged):

1. Top: `ztop` = the last layer of `vol[:, ra:rb, ca:cb]` with any voxel; pass `sub[:ztop + 1]` to `occ_of`
   (`drop_debris`'s `occ_of` broadcasts `zz`: slice it to `sub.shape[0]`). Empty layers hold no component.
2. Bottom, generic and exact: after `occ` is made, let `e` = the number of leading layers of `occ` that are empty and
   `f` = the number of leading layers that are completely solid. Label `occ[z0:]` with `z0 = e` if `e > 0`, else
   `z0 = max(f - 1, 0)`; add `z0` to every `zs.start`.
   - Empty leading layers (the `drop_debris` case: `occ` is empty below `g - 1`): components are unchanged.
   - Full leading layers (the `support_floating` case: the slab): layer `f - 1` is one connected sheet, joined to
     layer 0 through the full layers under it. A component touches layer `f - 1` if and only if it is the component
     that contains layer 0 today; every other component lies wholly above and is unchanged.
3. `support_floating` skips a piece with `zi.min() == 0` ("the ground and what stands on it"). With the cut, that
   piece's lowest layer is `z0`, not 0. Give `_owned` a parameter `floor=False`; with `floor=True`
   (`support_floating`) and `f > 0`, a piece whose slice starts at the cut's first layer is skipped **at the point
   where it would have been yielded** (after the corner, edge and `n_big` checks, in the same order as today, so
   `n_big` and with it the note's text stay the same). With `f == 0` nothing is cut at the bottom and the caller's
   own test works as before.

Verify: V1 with both fixtures (hals has the hills; add `--fixture scripts/fixtures/kachlet.json` if you have a
record for it: bridges and a lock), `check.py covers`, `check.py verify` (nothing floating left). The notes
`floating debris removed: ...` / `floating: N components ...` in the fixture's `data/debug/report.json` must be the
same strings as before (diff the file against a copy taken at V0).

### P3. Decompressed, memory-mapped sidecars of the map-sized inputs

Gain: ~6-15 s per region build (avg ~10 s, ~400 s CPU) and ~10 s of each feature-pass run (13-17 s -> ~4 s): about
-1.5 min wall on the feature pass at today's 4 jobs and -5 % on the regions. Effort: ~2 h. Risk: low (the arrays are
the same bytes; a fallback keeps today's path).

What:

- `scripts/region_inputs.py` (or a small new `scripts/sidecar.py`; if it is a new module that `voxelize.py` imports
  it becomes a region dependency, which is fine): `ensure(path)` writes, for each array of `data/prep.npz`,
  `data/lod2.npz`, `data/laser.npz`, an uncompressed `data/cache/inputs/<npz name>/<key>.npy` by streaming
  (`window.npz_rows` band by band into `np.lib.format.open_memmap`), plus a `stamp.json` with the npz's size and
  `st_mtime_ns` (the convention `raster_blocks` already uses). Write to a temp name and `os.replace`. ~4.3 GB of
  disk (696 GB free); one pass costs ~25 s and happens only when an input file changed.
- `scripts/regions.py` `main`: call `ensure` for the three files before the feature pass.
- `scripts/region.py` `load_npz`: when the sidecar's stamp matches the file, `np.load(sidecar, mmap_mode="r")` and
  return `np.ascontiguousarray(a[r0:r1, c0:c1])` (the same box arithmetic as now); else today's stream. The region
  key is unchanged (it hashes blocks of the npz's contents).
- `voxelize.py` line ~277: add `del orto, z` after `cellcol` is made (`orto` is used nowhere else; 240 MB per
  region). Check `dsm`/`d4` the same way.
- `scripts/check.py`: its workspaces link `data/prep.npz` etc.; the sidecars land in each workspace's own
  `data/cache/inputs/` (small for fixtures). Make sure `setup()`'s cleaning of a fresh workspace does not trip over
  the new folder.

Optional follow-up (only if S0 shows the 2.4 s `np.median` over `orto` matters): store `cellcol` itself as a uint8
sidecar (the median of 25 uint8 samples is one of them; `probe_misc.py` shows `np.partition(...)[..., 12]` equal to
`np.median`), so a region never reads `orto`.

Verify: V1 (the fixture builds go through the same loader). Compare one region's arrays from both paths in a
one-off assert while developing.

### P4. The unexplained 20 s per region (lines ~3654-3698)

Gain: up to 568 s CPU (-7 %) if it turns out to be an accident (an array copied, a slow path of a numpy routine).
Effort: unknown until S0 names the line; stop after 1 h if it is inherent. Risk: depends on the fix; anything that
changes values is out (the river colours are visible output).

### P5. Memory-aware scheduling in `regions.build`

Gain: region phase x ~0.65 on top of P1-P3 (`sim.py`: 18.3 min at 4 jobs -> 11.4 min under a 28 GB budget, before
contention); feature pass 131 s -> ~30 s (with P3: ~15 s). Effort: ~2 h. Risk: low for the outputs (regions are
independent processes; their order changes nothing but the debug report), medium for the machine (swap if the
estimates are wrong; see the guard).

What, in `scripts/regions.py` `build(ws, jobs, fpass)`:

- Estimated peak per region: `<rdir>/stats.json` from its last build (S0), else `1.7 GB x region cells / 1e6`
  (interior regions measured 3.8-5.3 GB for 3.2 M cells), +10 % margin. Feature pass: 1.5 GB each until measured
  (`build` already returns its peak; store it in `fpass/stats.json`).
- Budget: `REGION_MEM_GB` in the environment, else `regions.mem_gb` in `scripts/map.json`, else 75 % of
  `MemAvailable` from `/proc/meminfo` when the build starts. Job cap: `-j N` when given on the command line
  (then exactly today's behaviour, no budget: `check.py` passes `-j`), else `regions.jobs` if it is a number, else
  (`"auto"`) `os.cpu_count() - 4`. Change `scripts/map.json` to `"jobs": "auto"`; `regions` is not part of the
  region key (`region_inputs.config_part`), so this rebuilds nothing.
- Admission: start a waiting region while `running + its estimate <= budget` and the cap allows; always allow one.
  Order: largest estimate x last wall time first, then whatever still fits (small regions fill the gaps and the
  tail). Print the plan (`N at once, budget X GB`).
- Guard: while children run, if `MemAvailable` falls under 2 GB, start nothing new (do not kill).
- Keep `os.wait4` and the stats; write `stats.json` after each success.

Verify: outputs: V1 is unaffected (`-j` given); the real proof is V3. Behaviour: run the feature pass alone on the
real map (`uv run python scripts/voxelize.py --status` runs it and stops; ~0.5 min) and watch `free -g`.

### P6. Node files are rewritten only when their bytes change

Gain: enables P8's incremental tris; unchanged tiles keep their mtime (deploys by rsync and git's stat cache stop
touching 100 MB per build). ~0 min by itself. Effort: ~2 h. Risk: medium (two writers of the same files:
`tiles.export_window` and `tile_fields.py`; read the cases below).

What:

- `scripts/tilefile.py`: keep `write(path, sections)` exactly as it is (`gzip.GzipFile(Path(path), "wb",
  compresslevel=9, mtime=0)`): the gzip header it writes depends on how the file object is given, so do not swap in
  `gzip.compress` or a `BytesIO` without a byte compare against a file written today. Compare **uncompressed
  payloads** instead. New `write_changed(path, sections) -> written: bool`: if the file exists and
  `unpack(gunzip(file))` equals `sections` (same tags, same bytes), leave it; else `write`.
- `scripts/tiles.py` `export_window`: for each node, read the existing file if any; if its **voxel sections** (the
  tags this function owns: `cnts`, `grnd`, `runs`, `plns`, `room`; a tag missing on one side is a difference) equal
  the new ones, leave the file as it is (it keeps the sections `tile_fields.py` added, which are still right: their
  inputs did not change, or `tile_fields`' stamp reruns it). Otherwise write the voxel sections alone, as today.
  The same for `1f/`.
  The stats (`tot`, `ftot`) are today `stat().st_size` of the file just written, i.e. of the voxel-only file. Keep
  that number: when a file is skipped, the size the voxel-only file would have had (write it to a temp file in the
  region's cache folder with `tilefile.write`, `stat`, remove: ~20 ms a node; or record the voxel-only size per node
  in a small JSON beside the region's `out.json` when the node is written and read it back when it is skipped).
  These numbers go into the notes and into `meta.json` `tiles.bytes` as `regions.py` writes it.
- `scripts/tile_fields.py` `fields_window`: `tilefile.write_changed(f, sec)`; for `1f/` skip the rewrite when the
  file already is a container (repack and compare the payload).
- `meta.json` `tiles.bytes`, a latent inconsistency to close while here: `regions.py` writes the voxel-only sum,
  `tile_fields.py` overwrites it with the real sizes, but when the driver reruns and `tile_fields` is up to date
  (e.g. only `labels.py` changed) the voxel-only sum stays. Move the final value to the step that runs every build:
  `scripts/world_id.py` (it reads `tiles/` anyway) sets `tiles.bytes` to the sum of the level folders' file sizes
  when it differs (same formula as `tile_fields.main`), and `stamp.py`'s `#-tiles.tris,tiles.bytes,world` already
  keeps it out of every signature. On the normal full path the value is the one `tile_fields` writes today.

Verify: V1, V2 (`windows tile_fields tiles_lod`, tile-roundtrip both ways). Then on a fixture workspace: build, note
the mtimes of `web/public/data/tiles/**`, force one region (`--only 0_0`) and run the after-steps: **no** file's
mtime may change, and the digest is the same. `check.py covers` already has this scenario (region 0_0 built again
alone): extend it by the mtime assertion.

### P7. `tile_fields.py` over windows, in parallel

Gain: 57 s -> ~10-15 s now; more once the surface caps make it heavier (see section 5). Effort: ~1 h. Risk: low
(the step is windowed by design and `check.py windows tile_fields` proves any cover writes the same bytes).

What: `main`: `-j N` (default `min(8, cpu_count // 2)`) and a default cover of 1024 m windows when `-j > 1`
(`wmod.cover(D, W, 1024)`); `multiprocessing.Pool` (fork) over the windows, each calling `fields_window`; sum the
returned counts in window order; print the windows' notes in window order (collect them, do not let them
interleave). Each window streams its rows from `data/zones.bin`, `flood.bin`, `foliage.bin` (gzip, 64 MB raw: fine).
`build_data.sh` needs no change (the default does it); `check.py` runs the step through its own `run()`: keep
`--windows`/`--window-size` working as they do.

Verify: `check.py windows tile_fields`, V1.

### P8. `tris.mjs`: parallel, and only the nodes whose inputs changed

Gain: full run 188 s -> ~30-40 s (8 processes); after a change to a few regions ~10-20 s; after an edit under
`web/src` that the mesher does not import: seconds. Effort: ~3 h. Risk: low-medium (a stale cache entry would write
a wrong triangle count into `meta.json`; the key below is content-based and the check is cheap).

What, in `web/tools/tris.mjs`:

- A job = one `(level, tx, ty)` (for level 1 the base job and, if `1f/` exists, the foliage job, as now). Wrap
  `load` so that it records every file a job reads (name and a sha256 of its compressed bytes).
- Key of a job = sha256 over: the job's id, the recorded files' hashes, `JSON.stringify(ctx)` (N, W, D, palette
  flags), and a code hash = sha256 of the contents of the static import closure of `src/mesher.worker.ts` and
  `src/tile-request.ts` (follow relative `import ... from './x'` / `export ... from` specifiers to `.ts` files;
  `web/tools/core-deps.mjs` may already walk imports: reuse it if it does) plus `tools/tris.mjs` itself and
  `web/package-lock.json` (the vite/esbuild that transpile it). If the closure walk meets anything it cannot
  resolve, fall back to hashing every file under `web/src`.
  Which files a job reads is not known before it runs: store per job `{files: [...names], key, result}`; a cached
  entry is valid when the key recomputed over **the stored file list** matches. (The list of files a job reads is a
  function of the request, hence of the job id and the code, both in the key.)
- Cache: `data/cache/tris.json` (repo root `data/`, not under `web/public`): `{code, jobs: {"1/3_4": {...}}}`.
  `--no-cache` ignores it. Write it atomically.
- Parallel: the parent computes which jobs are stale, splits them into K shards (K = `min(8, cpus/2)`,
  `--jobs K`), spawns K `node tools/tris.mjs --worker` children (each does its own `runnerImport`), sends jobs and
  receives results over stdout/IPC as JSON, then assembles `tris` **in exactly today's construction order** (the
  `for s of levels` loop creating `tris[s]`, then `'1f'`, `'1c'`) so `JSON.stringify(meta)` gives the same bytes.
- `scripts/build_data.sh`: the stamp line stays as it is (inputs `web/tools/tris.mjs web/src $P/tiles $M`): when it
  fires, the cache makes the run cheap.

Verify: on the real data, without rebuilding anything: `cp web/public/data/meta.json` aside, run the new `tris.mjs
--no-cache` and then again with the cache (second run: 0 jobs meshed): `git status --porcelain
web/public/data/meta.json` prints nothing both times. Then touch one tile's content in a **copy** of the data dir
(`node tools/tris.mjs <dir>` takes a directory) and check only that node (and those that read it) are meshed.
`mesh-golden.mjs check` is unaffected but run it.

### P9. Lower the regions' peak RAM (stretch; lets P5 run 8 at once)

Gain: `sim.py`: peak x 0.75 -> 9.0-9.5 min region phase instead of 11.4 (ideal numbers). Effort: 2-4 h, bounded by
what S0 shows. Risk: low (a `del` of a name that is used later fails loudly in the fixture build).

What: with S0's RSS-per-stage table, find where the peak is. Candidates (estimates): the ~100 full-region
float64/bool temporaries kept alive as module globals (26 MB each at 3.2 M cells); `orto` (P3); the volume allocated
at `H` = 230 while `Hm` is ~160; `topz = Hm - 1 - np.argmax(vol[::-1] != 0, axis=0)` (a 0.5 GB bool temporary; do it
in z-bands or reuse `plane_codes`' loop); `np.unique(vol[core])` (a sort of 170 M values: `np.flatnonzero(np.bincount(
vol_core.ravel(), minlength=65536))` gives the same set faster and without the copy). Free what a section no
longer needs with `del` at the section's end. Do not change dtypes of anything that feeds arithmetic (float32 vs
float64 changes results).

Verify: V1, V2 (`covers`).

### P10. The eight independent post steps side by side

Gain: 96 s -> ~45 s (flood.py is the longest). Effort: ~1 h. Risk: low-medium (shell job control; a shared cache
file).

What: in `scripts/build_data.sh`, run `places`, `flood`, `boats`, `terrain`, `zones`, `objects`, `windows`,
`climate`, `phenology` as background jobs, each into its own log under `data/cache/logs/`, then `wait` for each pid,
print the logs in the fixed order and exit non-zero if any failed (`set -e` does not see background failures).
None of them writes `meta.json` (checked: `flood.py`, `zones.py`, `terrain.py` only read it) and none reads
another's output; `tile_fields` (needs `zones.bin`, `flood.bin`, `foliage.bin`, `windows.bin`) stays after them.
Before that, make `region_inputs.file_sha`'s cache write atomic and tolerant: it rewrites
`data/cache/inputs/files.json` from several processes at once (write a temp file, `os.replace`; on a JSON error
when loading, start empty). Also `lod2` can run beside `prep -> laser` at the top of the script (saves ~40 s when
`data/raw` changed).

Verify: V3 (the fixtures do not go through `build_data.sh`); before that, run the script on the real map when
everything is up to date (every step prints "up to date") and once with `FORCE=places,boats,objects` (three cheap
steps, in parallel) and check `git status --porcelain web/public/data`.

### P11. `cut_osm` only when its inputs changed (optional)

Gain: ~30 s on every invocation, including "nothing to do". Effort: ~1 h. Risk: low-medium (a wrong skip means a
stale OSM cut, i.e. a wrong region; key it on contents).

What: `region_inputs.cut_osm`: a record `data/cache/inputs/osm_cut.json` with a key over `file_sha(osm.json)`,
`overrides.tree_sha()`, the cover (each window's box), `OSM_MARGIN`, `OVERRIDE_REACH`, `region.HALO`,
`code_sha(landmarks.py)`, `code_sha(overrides.py)`, `code_sha(region_inputs.py)`, and the returned `{window: hash}`.
When the key matches and every `<rdir>/osm.json` and `osm.sha` exists, return the stored hashes. `overrides.check`
then does not print its warnings: print one line saying so.

### P12. Region code hashed per reachable definition (optional; fewer accidental full rebuilds)

Gain: no minutes on a planned change to `voxelize.py`; it removes the 15-45 min rebuild after edits that cannot
affect a region: driver-only functions in shared modules (`mapstore.MapRaster`/`MapVolume`/`write_npz`, most of
`region_inputs.py`, `window.py`'s readers, `landmarks.make_views`, `tiles.export`/`remove_stale`/`manifest`,
`interiors._test`, the traffic-side functions of `tunnels.py`/`underpass.py`). Effort: ~4 h. Risk: medium
(under-invalidation is silent: a region that should have been rebuilt is kept).

What, in `region_inputs.py`:

- `code_sha(path)` stays for `voxelize.py` (whole tree) and as the fallback.
- New `code_sha_used(path, used)`: split the module's top level into named definitions (functions, classes,
  assignments by target name) and everything else (imports, `if`/`for`/expression statements: always included).
  Start from `used` (the names other region modules take from it) and from the always-included statements; add
  every top-level name that occurs as an `ast.Name` in an included statement, until nothing changes. Hash the
  `ast.dump` of the included statements in source order, docstrings stripped as today.
- `used` per module: scan the ASTs of all modules in `deps` for `import M [as A]` with attribute uses `A.name`, and
  `from M import a, b`. If a module object is used in any other way (passed as a value, `getattr`, `import *`,
  `importlib`), use the whole-module hash for it.
- `region_key` uses these hashes for the `code` part. Add `python scripts/region_inputs.py --explain` printing per
  dependency which top-level names are in and out, and a test with synthetic modules (a used function, an unused
  one, a constant reached through a used function, a module-level statement).
- Changing the key scheme must not rebuild the map: add `voxelize.py --rekey`, which for every region whose
  manifest is fresh under the **old** key writes the new key into its manifest (keep the old function for that one
  purpose), and say in the README when to use it.
- Known limit, state it in the docstring: `tilefile.SECTIONS` is one statement, so appending a section (the caps
  plan does) still rebuilds the regions.

Verify: the unit test; `--status` before and after an edit to a driver-only function (no region stale) and to a
used one (all stale); `check.py covers` (its "built again: nothing may be built" part).

---

## 5. The upcoming surface caps (`docs/plans/surface-caps.md`) and this plan

What that plan adds to the build: four float32 rasters per region in `core.npz` (`deck_abs`, `roof_z`, `roof_gx`,
`roof_gy`: +16 MB per region, uncompressed `np.savez`, negligible time), `data/surface.npz` written by the driver
(4 x 129 MB raw through `mapstore.write_npz`, mostly NaN: estimate +10-20 s in the driver tail), and `caps.py` inside
`tile_fields.py` with `HALO` 32 -> 96 and a relaxation per window ("minutes" over the map by that plan's own
estimate). It needs one full region rebuild (it edits `voxelize.py`, `tilefile.py`).

Consequences:

- Do **P1, P3, P5 before** the caps rebuild: that rebuild is then ~12 min instead of ~36. The order that costs the
  fewest full rebuilds: (1) this plan's P1-P8, (2) V3 = full rebuild #1, proves byte identity and measures,
  (3) the caps work, (4) its full rebuild #2 (step R of that plan), which legitimately changes `tiles/` and
  `meta.json`. Do not merge the two rebuilds: #1 must reproduce the committed data, #2 must not.
- P7 matters more with caps: `tile_fields` becomes the place where caps are tuned, and each tuning run rewrites
  only the level-1 nodes whose `caps` bytes changed (P6) and re-meshes only those (P8). Tuning loop: ~1-1.5 min
  instead of ~5+.
- With P7's default cover of 1024 m windows, `caps.fields` runs per window with HALO 96; that plan already requires
  the same bytes for any cover (`check.py windows tile_fields`).
- `tile_fields`' stamp gets `scripts/caps.py data/surface.npz data/prep.npz` as inputs: `prep.npz` is 2.4 GB, but
  `region_inputs.file_sha` caches by size and mtime, so the stamp costs nothing. If `caps.py` reads `prep.npz`'s
  `dtm` per window through `window.npz_region`, it has the inflate-from-the-start cost of finding 3 (~0.5 s per
  window for `dtm`): let it use P3's sidecar loader instead.
- P8's cache key is the node file's bytes, so a `caps` section is covered without further work. The code hash
  covers `web/src/core/surface.ts` once the mesher imports it (the import closure).
- P12's known limit applies: adding `caps` to `tilefile.SECTIONS` rebuilds all regions even though no voxel
  section changes. That rebuild is needed anyway for the `voxelize.py` change, so nothing is lost.
- P6: `caps` is owned by `tile_fields`; `export_window` compares only its own five tags, so a region rebuild that
  changes no voxel leaves the node, caps included, untouched.

---

## 6. Considered and rejected (do not implement without asking)

- **Disk checkpoints between stages of `voxelize.py`** (terrain/buildings cached, later stages rerun). Everything
  before the vegetation is ~19 % of a region today (~34 % after P1-P3, since the back end shrinks), so a change to
  lamps or tree skeletons could save at most that. The checkpoint is the whole module namespace (the volume, ~100
  rasters, feature lists with shapely geometries, the palette object): 2-3 GB per region, 80-120 GB for the map
  uncompressed, or ~20 s per region to compress, which is the saving. It also needs the 3800-line script split into
  stage files with separate code hashes. High effort and risk for <= 1/3 on a subset of changes. Use `--only
  ROW_COL` to iterate on one place (~3 min after P1-P3) and the ~15 min full rebuild afterwards.
- **Re-export without synthesis** (a region's tiles rebuilt from a cached final volume when only `tiles.py`
  changed): after P1 the export is ~10 % of a region; `tiles_lod.py` already rebuilds levels 2/4/8 from `tiles/1`.
- **Larger or smaller regions, a smaller halo**: see finding 4. `window.ALIGN` (1024) is the smallest region.
- **Lower gzip level for node files**: level 9 costs 17 ms a node (measured), and the bytes would change.
- **Starting post steps while regions still build**: every post step reads a map-sized file the driver writes
  after the last region (`ground.npz`, `footprints.npz`, `meta.json`); P10 and P7/P8 take the same minutes with far
  less machinery.
- **Threads inside a region** (BLAS/numexpr): the hot code is `scipy.ndimage` and fancy indexing, single-threaded;
  processes are the unit, RAM the limit.

---

## 7. Summary table

| # | change | files | saving (full rebuild) | effort | risk |
|---|---|---|---|---|---|
| S0 | stage timings + RSS, `stats.json` | `voxelize.py`, `regions.py`, `tiles.py` | (measures) | 0.5 h | none |
| P1 | wall mode only at facade blocks | `tiles.py` | ~11 min at 4 jobs (-35 % region CPU, measured 20 x on the kernel) | 1 h | low |
| P2 | z-crop in `_owned` | `debris.py` | ~2 min at 4 jobs (-6 %, estimate) | 2 h | low-medium |
| P3 | mmap sidecars of prep/lod2/laser | `region.py`, `region_inputs.py`, `regions.py`, `voxelize.py` | ~1.5 min (fpass) + ~1.5 min (regions) at 4 jobs | 2 h | low |
| P4 | the unexplained 20 s block | `voxelize.py` | up to ~2 min at 4 jobs | <= 1 h to decide | unknown |
| P5 | RAM-aware job admission, `jobs: auto` | `regions.py`, `map.json` | region phase x ~0.65, fpass 131 -> ~20 s | 2 h | low (outputs), medium (machine) |
| P6 | write node files only when changed; `tiles.bytes` by `world_id.py` | `tilefile.py`, `tiles.py`, `tile_fields.py`, `world_id.py` | enables P8; stable mtimes | 2 h | medium |
| P7 | `tile_fields` parallel over windows | `tile_fields.py` | ~45 s (more with caps) | 1 h | low |
| P8 | `tris.mjs` parallel + per-node cache | `web/tools/tris.mjs` | ~2.5 min full, ~3 min incremental | 3 h | low-medium |
| P9 | free region temporaries (peak RAM) | `voxelize.py` | ~2 min more via P5 (estimate) | 2-4 h | low |
| P10 | post steps side by side | `build_data.sh`, `region_inputs.py` | ~50 s | 1 h | low-medium |
| P11 | cache `cut_osm` | `region_inputs.py` | 30 s per run | 1 h | low-medium |
| P12 | per-definition code hash, `--rekey` | `region_inputs.py`, `regions.py` | avoids accidental full rebuilds | 4 h | medium |

Report at the end: the new table of section 1.1 from the V3 run, the job count and budget that P5 chose, the peak
of `free -g` during the regions, which estimates above turned out wrong, and whether P4 found its line.
