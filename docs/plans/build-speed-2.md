# Plan: build speed, round 2 (full build 18:43 -> ~11 min; a `voxelize.py` edit: 13.5 min -> 3 min to look, ~8.5 min to finish)

Follows `docs/plans/build-speed.md` (deleted; in git at `b5483793`) (S0, P1, P2, P3, P5, P6+P8, P10, P11 done). Analysis only: nothing but this file
was changed, no build was started. Numbers marked **measured** are from the two full builds' logs
(`data/bs/rebuild.log`, 2026-11-21 20:29-20:48, with prep/lod2/laser; `data/bs/rebuild2.log`, 22:33-, without them),
`data/debug/timings.json`, the regions' `stats.json` / file times, or from probes of a few seconds on one core
(kept in the session's scratchpad, described where used so they can be redone). **estimate** = derived.

Machine: WSL2, 20 threads (6 P-cores + 8 E-cores), 39 GB RAM (35 GB available), 10 GB swap. Python 3.14.2,
numpy 2.5.4.

Constraints as before: `web/public/data` byte-identical for unchanged inputs, the arrays of `data/*.npz` the same,
no new dependencies (nothing below needs one), `scripts/palette.json` append-only, never push, ask before a full
rebuild of the real map.

Direction: **remove work, do not add caches.** Six of the nine steps below delete or shrink a computation; one adds
a process pool to a step that is windowed already; one adds a command-line switch. No new cache, no new key scheme.

---

## 1. Where the time goes now

### 1.1 Full build from scratch (measured, `rebuild.log`: 18:43 = 1123 s wall, 4170 s CPU = 3.9 cores on average)

| stage | wall | share | note |
|---|---|---|---|
| `prep.py` | 196 s | 17 % | 1 core; `lod2.py` (37 s) runs beside it |
| `laser.py` | 125 s | 11 % | 1 core, after prep (needs its `dtm`) |
| `regions.py` before the regions: `cut_osm` ~30 s, sidecars + block hashes ~60 s, feature pass ~15 s | ~107 s | 10 % | 1 core but the feature pass; only after an input changed |
| **regions (40 x `voxelize.py`)** | **~400 s** (2524 s summed, 6.3 at once) | **36 %** | RAM-bound: budget 28 GB, mean peak 3.4 GB, the large ones 4-5.1 GB |
| driver tail (map rasters 9 s, labels + traffic 18 s) | 27 s | 2 % | 1 core |
| post steps side by side (flood 28 s the longest) | 28 s | 2 % | |
| **`tile_fields.py`** | **202 s** | **18 %** | 1 core, the whole map as one window |
| `world_id`, `tris.mjs` (34 s), lamps | 36 s | 3 % | |

`rebuild2.log` (prep/lod2/laser and the OSM cuts up to date): feature pass 26 s, regions 472 s wall (2792 s summed,
5.9 at once; take 400-470 s as the range of the region phase), driver tail 27 s, post steps 29 s, `tile_fields`
209 s, tris 37 s: **13:27 in all (808 s)** -- this run is what an edit to `voxelize.py` costs today.

### 1.2 Inside the regions (measured, run 1: 2494 s summed over 40 regions)

| stage (`voxelize.py` `stage()`) | sum | share |
|---|---|---|
| **river colours** | **463 s** | **18.6 %** |
| vegetation | 401 s | 16.1 % |
| support_floating | 354 s | 14.2 % |
| ground classes, roads, water | 212 s | 8.5 % |
| tiles.export_window | 197 s | 7.9 % |
| rasters, cell colours, OSM | 164 s | 6.6 % |
| buildings | 153 s | 6.1 % |
| drop_debris | 145 s | 5.8 % |
| natural ground, cemeteries | 131 s | 5.2 % |
| fountains, beds, furniture | 90 s | 3.6 % |
| qa, deck_near, topdown | 61 s | 2.5 % |
| plane codes | 48 s | 1.9 % |
| everything else | 75 s | 3.0 % |

---

## 2. Findings

### F1. P4 found: "river colours" is 460 s of line-number lookups for warnings that are thrown away

`scripts/voxelize.py:3747-3752`:

```python
_blk = np.where(_open[..., None], cellcol, np.nan).reshape(D // _B, _B, W // _B, _B, 3)
with np.errstate(all="ignore"):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        _bc = np.nanmedian(_blk, axis=(1, 3))
```

`np.nanmedian` over a short axis goes through `numpy/lib/_nanfunctions_impl.py` `_nanmedian_small`, which ends with

```python
for i in range(np.count_nonzero(m.mask.ravel())):
    warnings.warn("All-NaN slice encountered", RuntimeWarning, stacklevel=5)
```

one `warnings.warn` **per all-NaN slice**: per 8 m block and colour channel without open water, i.e. 3 x 50176 =
150 000 calls in a full region with no river (118 000 in a top-row region). The filter ignores them, but before
CPython looks at the filter it resolves the warning's location: the line number of the frame at `stacklevel=5`,
which is the frame that called `np.nanmedian` -- **the module body of `voxelize.py`**. A line number is found by
decoding the code object's line table from its start; `voxelize.py`'s module body is one code object of 147 KB of
bytecode with a 59 KB line table, and line 3752 sits at offset 147 074 of 147 298, the very end. Every ignored
warning walks the whole table: ~90 us.

Evidence:

- 118 000 x 90 us = 10.6 s predicted for region `0_1024`, 10.9 s measured; 132 000 x 90 us = 11.9 s for
  `1024_2048` (572 000 water cells), 13.9 s measured. It scales with the area without open water, as the previous
  plan observed ("a region with 674 water cells pays it too").
- Probe (one core, 2 s; scratchpad `bs2/big.py`): a script of 3700 trivial module-level lines (line table 18.7 KB)
  followed by the same call on a 896 x 896 all-NaN block array: **1.07 s at module level, 0.09 s for the same call
  inside a function** (37 632 warnings: 28 us each; x 59.2 / 18.7 for the real line table = 89 us). The same call at
  the top of a short script: 0.13 s. This is why every probe of the block in isolation found it cheap.
- The rest of the block (erosion/dilation, `np.where`, EDT, filters, `np.unique(axis=0)`, the lerp) is 0.3-0.6 s
  per full region (probe `bs2/river.py`).

The same trap is open to anything that asks for the caller's line in a module-level loop (`warnings.warn` from
numpy, scipy or shapely, even when filtered). The only other candidate today is `np.nanpercentile(..., axis=1)` at
`voxelize.py:3142` (once per bridge way, a warning per all-NaN row: thousands, not hundreds of thousands: leave it).

### F2. `tile_fields.py`: 57 s before the caps, 202 s with them, 12 GB at its peak, one core

`caps.fields` (`scripts/caps.py:126`) runs over the whole map as one window (32.3 M cells): 64 rounds
(`N_SMOOTH + N_RELAX`, `caps.py:181-184`) of `step()` (`caps.py:168`), each summing 16 neighbour terms (two layers
x two layers x four directions), each term a `_shift` copy, an `np.where` and a sum over map-sized float64 arrays
(258 MB each); then 8 x 16 label rounds (`caps.py:207`) and 8 x 8 corner sums on int64/float64 arrays of the same
size. That is ~3000 passes over 258 MB arrays that are allocated and freed each time: ~145 s (**measured** as the
difference to the 57 s the step took before the caps; 209 s in run 2). The build's `Maximum resident set size`,
12.08 GB in both runs, is this step's (run 2 ran no prep; the largest region peaks at 5.1 GB).
12 of the 16 neighbour terms involve the deck layer K, which exists on 63 000 of the 32.3 M columns.

The step is windowed by design (`fields_window`, `tile_fields.py:131`; `HALO = 96`) and `check.py windows
tile_fields` already proves every cover writes the same bytes (run of 2026-11-21: 2x2 and 1024, 0 of 345 differ).
It simply is not run that way: `main` (`tile_fields.py:216-221`) takes the whole map unless told otherwise.
This is the deferred P7; the caps made it 3.5 x more valuable.

### F3. The 20 cm orthophoto is carried through the build to make one 1 m raster

`orto` (17280 x 46720 x 3 uint8, 2.42 GB) is 83 % of `data/prep.npz`. Its only reader in the build is
`voxelize.py:295`, `cellcol = np.median(orto.reshape(D, 5, W, 5, 3), axis=(1, 3))` (`scripts/look.py:60`, a
developer's tool, is the only other reader). For that:

- `prep.py:80` deflates it: 50 MB/s, ratio 0.85 (**measured** on 48 MB of the real array) = **48 s** for a 15 %
  smaller file;
- `regions.py` inflates it twice more on a fresh `prep.npz` (`sidecar.ensure` and
  `region_inputs._npz_blocks`), hashes it and writes a 2.4 GB sidecar: most of the ~60 s before the feature pass;
- every region and every feature pass takes the median of its own box, halo included: **2.1 s per full region
  (measured on the real ortho)**, ~85 s summed over the regions and as much again, summed, over the feature passes
  (2.85 x the map's area each, because of the halos).

The median of 25 uint8 samples is one of the samples: `cellcol` is exactly a uint8 raster of 97 MB (probe:
`np.median(...)` equals `np.partition(...)[..., 12]`, all values integral).

### F4. `prep.py` and `laser.py` are a serial 321 s chain, most of it avoidable (estimates; they have no timers)

- `prep.py` (196 s): 48 s is the ortho's deflate (F3). The ortho's resampling (`prep.py:78`, `resample` line 52:
  `ndimage.map_coordinates(order=1)` per channel, 807 Mpx x 3, plus float64 coordinate grids) is most of the rest:
  a synthetic probe gives ~55 s for the coordinates and ~100-150 s for the sampling (pessimistic: the whole step
  takes less), one core. The row bands are independent.
- `laser.py` (125 s): per sheet (40 sheets, 504 M points in the map) it makes **nine arrays of the whole map**
  (seven `np.bincount(..., minlength=D * W)`, `laser.py:70-80`; `top`, line 81; and in `percentile_per_cell`,
  called twice with the same points, a full-map count, cumsum and result each) for a sheet that covers 1 km2 of
  the 32 km2. Probe with 12 M points: the full-map bookkeeping costs ~1.2 s a sheet more than the same counts over
  the sheet's own box: ~45 s over 40 sheets. `percentile_per_cell` also sorts the same points twice (`laser.py:87`).
  LAZ decoding is already parallel (laspy picks `lazrs`' parallel backend).

### F5. The regions are RAM-bound, and their peak is a debug image

26 of the 40 regions peak in the stage "qa, deck_near, topdown" (**measured**, `timings.json`): on average
+642 MB over their peak before it (4256 MB), 15 %. The statement is `voxelize.py:3892`,
`topz = Hm - 1 - np.argmax(vol[::-1] != 0, axis=0)`: a bool copy of the volume (0.4-0.5 GB) for
`data/debug/topdown.png`. The other 14 report the driver's own size instead of theirs (next point).

The scheduler's estimates are inflated after a run that cut OSM: a child's `ru_maxrss` (`regions.py:173`) starts
at the parent's resident size at `fork`, and the driver held 2.9 GB after `_cut_osm` in run 1 -- every small region
and every feature pass reported "peak 2925 MB" (real: 0.7-2.1 GB, run 2) and was scheduled as 3.2 GB in run 2.

### F6. What a `voxelize.py` edit costs today, and why

`region_key` hashes `voxelize.py` whole (its syntax tree), so all 40 regions and feature passes are stale:
feature pass 0.4 min + regions 6.7-7.9 min + driver 0.5 min + post steps up to 0.5 min (content-stamped: only
those whose inputs' bytes changed) + `tile_fields` 3.5 min (its stamp includes the tiles folder: any changed node
reruns it over the whole map) + tris (0.6 min when every node changed, seconds otherwise) = **13:27 measured
(run 2)**, to look at one street corner.
`--only ROW_COL` does not help: it builds the named regions "and whatever else changed", i.e. all of them.

### F7. The fixtures' "steps after it" are 70-77 s of a 2.3 min golden, and serial

`check.py build` (`check.py:203-212`) runs the nine `AFTER` steps one after the other; `build_data.sh` has run the
first eight side by side since P10. Five of them load the whole of `data/raw/osm.json` whatever the fixture's size
(2-7 s each on the map), then `tile_fields`. Measured (queue log of 2026-11-21): altstadt voxelize 67 s + after
71-77 s, hals 46 + 70, kachlet 60 + 75. The three goldens were also run one after the other (6.5 min) though each
has its own workspace.

---

## 3. Steps, in order of gain per effort

| # | change | files | saving, full build | saving, `voxelize.py` edit | effort | risk to bytes |
|---|---|---|---|---|---|---|
| A1 | `nanmedian` of the river blocks inside a function | `voxelize.py` | regions -17 % CPU: ~-70..80 s | the same | 10 min | none |
| A2 | `tile_fields` over 1024 m windows, in parallel | `tile_fields.py` | 202-209 -> ~35 s | the same | 1 h | low (proved by `check.py windows`) |
| B1 | `--just ROW_COL`: build the named regions only | `regions.py` | - | 13.5 min -> ~3 min to look | 30 min | none (a switch) |
| A3 | `cellcol` made in `prep.py`; the ortho out of `prep.npz` | `prep.py`, `voxelize.py`, `look.py` | ~-110 s (prep -48, before the regions ~-45, regions ~-15, feature pass ~-4) | ~-20 s | 1 h | low |
| A4 | `prep.py`: the ortho's row bands in a process pool | `prep.py` | ~-90 s (estimate) | - | 1 h | none (same function per band) |
| A5 | `laser.py`: counts over each sheet's own box, one sort | `laser.py` | ~-50 s (estimate) | - | 1 h | low |
| A6 | `topz` layer by layer; the child's own peak (`VmHWM`) | `voxelize.py`, `regions.py` | regions' peak -15 %: ~-30 s (estimate) | the same | 30 min | none (debug image, scheduling) |
| B2 | `check.py`: the after-steps side by side; fixtures side by side | `check.py` | - | golden 2.3 -> ~1.6 min each, three at once | 30 min | none |
| M1 | timers where there are none | `prep.py`, `laser.py`, `regions.py` | (measures) | | 30 min | none |

Implement A1, A2, B1 first (two hours, the bulk of both targets); A3-A5 together (they all rerun prep or laser
once); A6, B2, M1 whenever.

### A1. The river blocks' median in a function (P4) -- done (branch bs2, see 8.)

Where: `scripts/voxelize.py:3748-3752`. What: move the call into a small function defined just above, with a
comment saying why:

```python
def _block_median(blk):
    # in a function, not at module level: numpy warns once per all-NaN block (150 000 a region), and each warning,
    # ignored or not, looks up its caller's line -- at the end of this module's body ~90 us (docs/plans/build-speed-2.md F1)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmedian(blk, axis=(1, 3))


_bc = _block_median(_blk)
```

Saving: the stage 463 s -> ~40 s summed (0.4 s of warnings + ~0.5 s of real work per full region): **-17 % of the
regions' CPU, ~-70..80 s of the region phase** (400-470 s). Risk: none -- the same call with the same arguments. (Computing the
median only for the blocks with an open cell would also drop the remaining 0.4 s, but needs the result's dtype
reproduced by hand; not worth it.)

Verify: `check.py golden --compare` on altstadt and kachlet (rivers, weir) from a record taken before; the note
`river colours from the ortho: N shades over M water cells` unchanged; the `[stage] river colours` line of a
region's `log.txt` shows ~1 s.

### A2. `tile_fields.py` over windows, in parallel (P7) -- done, with the second half (see 8.)

Where: `scripts/tile_fields.py:216-226` (`main`). What, as the previous plan's P7:

- `-j N` (default `min(8, os.cpu_count() // 2)`); when no cover is given on the command line and `N > 1`, the
  default cover is `wmod.cover(D, W, 1024)`.
- `multiprocessing.Pool(N)` (fork) over the windows, each calling `fields_window` with a `note` that collects;
  the parent prints the notes and sums the counts **in window order**, then writes `meta.json` once as now.
  Windows write disjoint node files (a node belongs to the window that holds its first cell).
- `--windows` / `--window-size` keep working as they do (`check.py windows` passes them); `-j 1` with no cover is
  today's run.
- `build_data.sh` needs no change.

Saving: **202 s -> ~35 s** (estimate: the 40 windows' regions with `HALO` 96 cover 44.6 M cells for the map's
32.3 M, so ~57 + 145 x 1.38 = ~255 s of CPU over 8 processes, plus the windows' own reads). Peak RAM 12 GB in one
process -> under 1 GB per window. In the developer loop the same 2.8 min are saved on every run that changes a node.

Optional second half, only if the step still takes over 30 s after that: in `caps.fields`, skip what is empty --
in `nbrs` (`caps.py:160-165`) leave out a term whose mask has no True, in the label rounds an edge whose link mask
has none, in the corner sums a node layer that does not exist in the window. Most windows have no deck at all, so
12 of the 16 terms and half the label work go. Exact: a skipped term added `+0.0` (the only difference is the sign
of a zero, which the rounding to 1/64 m removes). Six lines; `check.py windows tile_fields` and the golden decide.

Also while there: `caps.region_fields` (`caps.py:328`) reads `dtm` through `window.npz_region`, which inflates
`prep.npz`'s `dtm` from its start for every window; `sidecar.load("data/prep.npz", "dtm")` (memory-mapped, falls
back to the stream when there is no fresh copy) is one line and the same bytes.

Verify: `uv run python scripts/check.py windows tile_fields` (covers against the whole fixture), golden compare;
on the real data after the next build `git status --porcelain web/public/data` (the nodes' bytes) -- or, without a
build, run the new `tile_fields.py` on the committed data: P6 makes it rewrite nothing when the bytes are the same,
so `git status` must stay empty.

### B1. `voxelize.py --just ROW_COL[+ROW_COL]`: the named regions and nothing else -- done (see 8.)

Where: `scripts/regions.py:338-345`. What: like `--only` (same `pick`), but `todo` is the picked regions alone;
the others stay as they are, stale manifests included. Print loudly what was left
(`--just: 39 regions are stale and were NOT built; run without --just before committing data`), refuse when a
region that is not picked has never been built (no `out.json`), and **do not write `data/cache/regions.stamp`** at
the end, so the next plain build rebuilds the rest and reruns the driver. The feature pass runs as always (all 40
after a code change: 26 s). In `build_data.sh` nothing changes but one line: `uv run python scripts/voxelize.py
${JUST:+--just $JUST}`.

`JUST=2048_7168 sh scripts/build_data.sh` then costs (estimates from the measured parts): feature pass 0.4 min +
one region ~1.2 min (after A1; alone on a P-core) + driver 0.5 min + post steps <= 0.5 min + `tile_fields` 0.6 min
(A2) + tris seconds (P8's cache: only the changed nodes) = **~3 min**, on the real map with its real surroundings,
viewable in the normal viewer. `x=COL,y=ROW` picks the region by a map cell, as `--only` does.

What it is not: a build. The data on disk is a mix of two code versions until the plain build ran, and
`--status` says so. That is the whole design: no second key, no cache to invalidate, the existing incremental
logic finishes the job.

Verify: `check.py covers` already builds region `0_0` again alone and compares everything; add the same with
`--just` after touching `voxelize.py` in the workspace's copy (append a comment-free no-op statement so the hash
changes): the outputs must equal the whole fixture's, the other regions must report stale, and a following plain
build must build them and leave the outputs unchanged.

### A3. `cellcol` once, in `prep.py`; the ortho out of `prep.npz`

Where: `scripts/prep.py:78-80`, `scripts/voxelize.py:216` and `:295-296`, `scripts/look.py:60`.

- `prep.py`: after the ortho is resampled, `cellcol = np.median(orto.reshape(D, 5, W, 5, 3), axis=(1, 3))` in row
  bands, as uint8 (assert it is integral); `np.savez_compressed("data/prep.npz", dsm=dsm, dtm=dtm, cellcol=cellcol)`;
  the ortho itself to `data/orto.npy` (`np.save`, uncompressed, 2.4 GB written in a few seconds), for `look.py`.
- `voxelize.py`: `cellcol = z["cellcol"].astype(np.float32)`; the `orto` lines go.
- `look.py`: `np.load("data/orto.npy", mmap_mode="r")[r0 * S:r1 * S, c0 * S:c1 * S]`.
- `build_data.sh`: add `data/orto.npy` to prep's `-o` list (a missing file reruns prep).

Saving on a full build: prep -48 s (no deflate of the ortho; +~20 s for the map's median, less with A4's pool),
the sidecar and block-hash passes over 2.4 GB gone (~-45 s before the feature pass), every region -2.1 s
(~-85 s summed, ~-15 s wall), every feature pass the same (~-4 s wall); 2.4 GB less sidecar on disk, 240 MB less
in each region's first stage. On a `voxelize.py` edit: the ~-20 s of the regions and feature passes.

Risk: low. The values are the same floats (the median of 25 bytes is one of them). It changes `prep.npz`'s arrays,
so every region's key: one full rebuild (which A1 causes anyway). `check.py golden` with `inputs` hashes
`prep.npz:orto`: records taken before lack `prep.npz:cellcol` -- compare with a record taken before but expect
exactly those two keys to differ, nothing under `web/public/data`.

### A4. `prep.py`: the ortho's row bands in a process pool

Where: `scripts/prep.py:52-67` (`resample`) and line 78. What: for the ortho only, `multiprocessing.Pool(8)`
(fork; the mosaic is a module global the workers read, never write) over row bands of 256 rows (not 1024: the
float64 grids of a band are ~0.8 GB then instead of 3 GB); `imap` in order, each result written into `out`. A3's
median can run in the same worker on its band (a band of 256 rows is a multiple of 5 only if cut at 255/260: use
bands of 250).

Saving: **estimate ~-90 s** (the resampling of 2.4 G samples on one core today; M1's timer in `prep.py` gives the
real number first -- if it is under 40 s, drop this step). Risk: none for the values (each output pixel is
interpolated from its own coordinates; the band it is computed in does not enter). RAM: 8 x ~0.8 GB beside the
mosaic; prep runs beside `lod2.py` only.

Verify: the arrays of the new `prep.npz` equal the old ones (`np.array_equal` per key, `dsm`, `dtm`, and
`cellcol` against the median of the old `orto`); then `voxelize.py --status` must say every region is up to date
apart from the A3 key change (do A4 before A3, or compare the block hashes in
`data/cache/inputs/prep.npz.blocks.json` for `dsm` and `dtm`).

### A5. `laser.py`: each sheet's counts over its own box

Where: `scripts/laser.py:54-88`. What: per sheet, after `c, r` are cut to the map, take the box
`r0, r1, c0, c1 = r.min(), r.max() + 1, c.min(), c.max() + 1`, the local index
`(r - r0) * (c1 - c0) + (c - c0)`, and do every `np.bincount`, `top`, and `percentile_per_cell` over
`(r1 - r0) * (c1 - c0)` cells; add / maximum / `np.where` into `out[k].reshape(D, W)[r0:r1, c0:c1]`. In
`percentile_per_cell`, sort once and take both quantiles (return a function of `q`, or pass both).

Saving: **estimate ~-45 s** for the boxes (probe: ~1.2 s a sheet) and ~-10 s for the second sort. Risk: low:
each cell's counts, sums (same order of points per cell: `bincount` adds in input order), maxima and ranked
values are those of the same points; the uint16 wrap-around of `+=` is per cell.

Verify: every array of the new `laser.npz` `np.array_equal` to the old one; `voxelize.py --status`: all up to date.

### A6. The regions' peak: `topz` layer by layer, and the child's own peak

Where: `scripts/voxelize.py:3892`; `scripts/voxelize.py` `stage()` (line 75) and `scripts/regions.py:173-174`.

- `topz = np.full((D, W), Hm - 1); for z in range(Hm): topz[vol[z] != 0] = z` (an empty column gives `Hm - 1`
  as `argmax` of nothing did). It only feeds `CORE_OUT["topdown"]`, the debug image.
- `stage()` also reads `VmHWM` from `/proc/self/status` (the process's own high-water mark, reset by `exec`) into
  `RESULT["peak_mb"]`; `regions.py` writes that into `stats.json` when the region's `out.json` has it, else
  `ru_maxrss` as now (the feature pass exits before `out.json`: let it write `fstats.json`'s peak the same way, or
  leave it -- its 1.5 GB default is right).

Saving: the 26 large regions' peak -15 % (642 of 4256 MB, measured) -> the 28 GB budget holds ~7 instead of ~6:
**estimate ~-30 s of the region phase** (the seventh process lands on an E-core: less than 1/7). Risk: none for
the tiles.

Not further: the rest of the peak is the volume at its full height (1.5 GB at `H` = 230) and ~1.8 GB of rasters
and features kept alive by the module namespace. Freeing those is a `del` hunt through 3900 lines for a few
percent; the machine has six fast cores and six regions already run at once. **Drop the rest of P9.**

### B2. `check.py`: after-steps side by side; fixtures side by side -- done (see 8.)

Where: `scripts/check.py:203-212`. What: run `AFTER[:-1]` (places ... phenology) in a
`concurrent.futures.ThreadPoolExecutor` over `run(ws, fx, s)` (each is a subprocess with its own log), then
`tile_fields`; raise the first `Failed`. They read nothing of each other (that is what `build_data.sh` relies on).

Saving: **the 70-77 s after a fixture's voxelize -> ~30 s** (estimate: the longest of the eight, then
`tile_fields`; less after A2 if `check.py` lets `tile_fields` use its default `-j`).

No code: fixtures have a workspace each (`data/check/<name>/`), so `golden --compare` on altstadt, hals and
kachlet can run as three shell jobs at once (3 x `-j 2` regions, ~4 GB each: fits): **6.5 min -> ~2.5 min**
for the three. Say so in `check.py`'s docstring where the runtimes are listed.

### M1. Timers where there are none (do with the step that needs them)

- `prep.py`, `laser.py`: a `print` of the seconds after each phase (mosaics, each resample, the save; per sheet
  read vs counted). Decides A4 and A5's real numbers.
- `regions.py` `main`: the seconds of `cut_osm`, the sidecars, the map rasters, labels, `traffic.build` (file
  times say rasters 9 s, the rest 18 s; nothing to do there now).
- (`voxelize.py` vegetation, `debris.py` support_floating: profiled and made faster, see 8.3.)

---

## 4. The developer loop after this round

| what changed | command | today | after |
|---|---|---|---|
| `voxelize.py` (or any module a region loads), looking at one place | `JUST=ROW_COL sh scripts/build_data.sh` (B1) | 13.5 min | **~3 min** |
| the same, before committing data | `sh scripts/build_data.sh` | 13.5 min | **~8-9 min** (feature pass 0.4, regions ~5.3-6.2, driver 0.5, post 0.5, tile_fields 0.6, tris up to 0.6) |
| the same, on a small place without the real map | `uv run python scripts/check.py build --fixture scripts/fixtures/haissengasse.json` (1024 x 1024 m = one region without a halo) | ~1.5 min | **~1 min** (region ~25 s after A1, after-steps ~30 s with B2) |
| an override file (`scripts/overrides/`) | `sh scripts/build_data.sh` (keyed per region since before) | 1-4 regions + driver + 3.5 min tile_fields | 1-4 regions + ~1.5 min |
| `caps.py` or its constants | `sh scripts/build_data.sh` | 3.5 min + tris | **~40 s** + tris for the changed nodes |
| a post step's script | `sh scripts/build_data.sh` | that step (+ tile_fields 3.5 min if it feeds it) | that step (+ ~35 s) |

Which check for which change (cheapest that proves it):

| change | check | cost after B2 |
|---|---|---|
| a refactor that must not change a byte | `check.py golden --compare` on altstadt, hals, kachlet, side by side | ~2.5 min |
| a visible change in `voxelize.py` | `check.py build` + `check.py verify` on the fixture that has the thing (haissengasse: one region) | ~1-2 min |
| anything region-local in new code (does a core depend on its cover?) | `check.py covers` | ~5 min (was 6: run it once per change of that kind, not per edit) |
| a windowed step (`tile_fields`, `zones`, `terrain`, `tiles_lod`) | `check.py windows STEP` | seconds to ~3 min |

A fixture that is exactly one 1024 m region is the cheap "just this place" loop that already exists; what it does
not have is the real surroundings (its edge is a map edge). `--just` has them. Between the two there is no need
for a third mechanism.

---

## 5. Amdahl: what dominates afterwards

Full build from scratch, estimates from the measured parts (run 1 = 1123 s):

| stage | now | after A1-A6 | share after |
|---|---|---|---|
| prep | 196 s | ~70 s | 10 % |
| laser | 125 s | ~70 s | 10 % |
| before the regions (OSM cuts, sidecars, hashes, feature pass) | ~107 s | ~60 s | 9 % |
| **regions** | ~400 s | **~310 s** | **45 %** |
| driver tail | 27 s | 27 s | 4 % |
| post steps | 28 s | 28 s | 4 % |
| tile_fields | 202 s | ~35 s | 5 % |
| world_id, tris, lamps | 36 s | 36 s | 5 % |
| **total** | **18:43** | **~11 min** | |

The `voxelize.py` rebuild (run 2 = 808 s) by the same sums: ~510-530 s, of which the regions ~375 s.

After this round the regions are again ~45 % of a full build and ~70 % of a `voxelize.py` rebuild, and inside
them (2494 s -> ~1950 s summed) vegetation (21 %), support_floating (18 %), ground classes (11 %) and the export
(10 %) lead (the first two then roughly halved, 8.3: ~-300 s summed). The region phase is bound by 39 GB / ~4 GB a
region = 6-7 at once on 6 fast cores, so its floor on this machine is ~5 min; more speed there needs the stages
themselves to get cheaper (M1 first) or a machine with more RAM and P-cores, not more scheduling.
The serial chain prep -> laser (140 s after A3-A5) only matters when `data/raw`, `aoi.py` or `map.json` change.

---

## 6. Considered, not worth it

- **P12, a per-definition code hash.** It cannot help the case that matters: `voxelize.py` is one module body, so
  any edit is reachable from everything. It would spare a full rebuild only after edits to driver-only functions
  in shared modules, at the price of an AST reachability analysis whose mistakes are silent (a region kept that
  should have been rebuilt), plus `--rekey`. With B1 an unwanted full rebuild costs 3 min to look and 8-9 to
  finish. **Drop it.**
- **Checkpoints between `voxelize.py`'s stages / a cached volume to re-export from.** As rejected before; A1 makes
  the stages after the vegetation cheaper still, so there is even less behind a checkpoint.
- **`tile_fields` only for the windows whose inputs changed.** A cache key per window over seven map files' rows.
  After A2 the whole step is ~35 s; P6 already keeps unchanged nodes' bytes and times, P8 re-meshes only changed
  nodes. Not worth a key.
- **Storing `prep.npz` uncompressed and deleting `sidecar.py`.** Tempting after A3 (Python >= 3.12 seeks in stored
  zip members), but `lod2.npz` and `laser.npz` compress 5-14 x and the sidecars work. No gain left once the ortho
  is out.
- **Hashing stamped steps' `.py` inputs by syntax tree** (`stamp.sig` -> `region_inputs.code_sha`), so a comment
  in `aoi.py` does not rerun prep and laser: two lines, but it changes every step's recorded signature and so
  reruns every step once, and `aoi.py` is rarely edited. Only together with A3-A5's rerun, if at all.
  (The rerun of prep/lod2/laser after P10 was this kind of one-off: `A` became `map.json#-regions`, a different
  signature for the same file.)
- **The rest of P9**, see A6. **More jobs**: the budget, not the job cap, limits the regions (5.9-6.3 at once of
  16 allowed).
- **A parallel pool over the laser sheets.** Each worker would hold ten map-sized arrays or need a merge protocol
  for the percentiles; A5 removes the cost instead.

---

## 7. Order of work and gates

1. Record goldens (altstadt, hals, kachlet; side by side) on the current `main`. A1, A2 (+ `check.py windows
   tile_fields`), B1, A6, B2: golden compare after each; `check.py covers` once after B1.
2. A4, A5 (arrays equal to today's `prep.npz` / `laser.npz`, `--status` all up to date), then A3 (expected input
   key change only; outputs equal).
3. One full `sh scripts/build_data.sh` on the real map (ask first): `git status --porcelain web/public/data` must
   print nothing; report the table of 1.1 again, the `[stage] river colours` sum, `tile_fields`' time, the
   regions' "at once" figure (summed walls / phase wall, from the `stats.json` files), and which estimates above
   were wrong.

---

## 8. Done: A1, A2, B1, B2 (branch `bs2`, 2026-11-21; no full build of the real map yet); A3-A6 (8.2)

Goldens recorded on `main` (a90289bd) for altstadt, hals, kachlet, then compared after the changes: **0 of 459 / 301 /
459 outputs differ** (the three as shell jobs side by side, `-j 2` each). `check.py windows tile_fields --covers
2x2,1024`: 0 of 345 differ; `check.py verify` on altstadt ok.

- **A1** as planned (`_block_median`). Fixture regions' `[stage] river colours`, summed: altstadt 28.8 -> 2.4 s,
  kachlet 26.8 -> 2.0 s, hals 10.4 -> 0.7 s (-92 %, as F1 predicted). The other stages' fixture times are not
  comparable before/after (the record ran beside other jobs).
- **A2**: `tile_fields.py -j N` (default `min(8, cores / 2)`), windows of 1024 m when no cover is given, a fork pool,
  notes printed and counts summed in window order; `-j 1` without a cover is the old whole-map run (`check.py windows`
  takes its reference that way). The plan's estimate of ~35 s did not hold for the pool alone: `caps.fields` is
  memory-bound, so 8 processes ran 2.5 x slower each (on the committed map data, in a copy: one window after the other
  200 s CPU; `-j 4` 74 s, `-j 8` 64-68 s, `-j 12` 62 s wall). With the second half -- in `caps.fields` the smoothing's
  16 neighbour terms added in place over their overlap (`np.add(..., where=m)`, no `_shift` copies), terms, label
  edges and corner sums of nodes that hold nothing skipped; the same values but the sign of a zero -- and `dtm` from
  `prep.npz`'s sidecar where fresh: **the map's `tile_fields` 220 s / 12.2 GB -> 39 s / 0.64 GB** (wall, peak RSS of a
  process; measured on the committed data in a scratch copy, the machine not idle). Every node file byte-identical to
  the committed ones; `meta.json` equal as JSON (tris.mjs writes it in its own format later).
- **B1**: `voxelize.py --just ROW_COL[,ROW_COL..]` (also `+`, and `x=COL,y=ROW`), `JUST=... sh scripts/build_data.sh`;
  refused with `--only`/`--force` or when a region not named was never built; loud about what it left stale; no
  `regions.stamp`. Checked on the altstadt workspace: a no-op edit of `voxelize.py`, `--just 0_0` built that region
  only (no node file rewritten), `--status` listed the other three as `changed: code:voxelize.py`, a plain build then
  built those three and wrote the stamp, a third run did nothing, and after the steps that follow, every output equal
  to the golden of `main`. README "Incremental" says how to use it.
- **B2**: `check.py build` runs the eight steps after voxelize side by side, then `tile_fields`: the steps after it
  72-80 -> 49-58 s per fixture (three fixtures at once); a golden compare ~2 min each, the three side by side ~2.2 min.

Still to confirm on the next full build of the real map: `git status --porcelain web/public/data` empty, the summed
`[stage] river colours` (~460 s -> ~40 s expected), the region phase's wall, and `tile_fields` in the build (~40 s).

### 8.2 Done: A3, A4, A5, A6 (+ M1 for prep and laser; branch `bs3` on `main` 383d2cce, 2026-11-21; no full build yet)

Goldens recorded on `main` 383d2cce for altstadt, hals, kachlet and the same fixtures built on `bs3` (six jobs side by
side, `-j 2` each): **459 / 301 / 459 outputs, 2 differ in each, exactly the expected two** -- `data/prep.npz:orto`
gone, `data/prep.npz:cellcol` new; nothing under `web/public/data`, no other array. The fixtures' new `orto.npy`
equals the old `prep.npz:orto`, their `cellcol` the median of it (`np.array_equal`). `check.py verify` on altstadt
ok; palette_check, `overrides.py check`, `interiors.py --test`, `sh -n scripts/build_data.sh` ok.

On the real map (full inputs, run into a scratch folder, one at a time, the machine otherwise idle; M1's timers):

| step | before | after | |
|---|---|---|---|
| `prep.py` | **212 s**, 12.0 GB peak: dsm 23, dtm 2, orto mosaic 32, **orto resample 87**, **`prep.npz` written 67** | **104 s**, 11.5 GB: dsm 20, dtm 2, orto mosaic 31, resample + cells' colours 19 (8 processes), `prep.npz` 30, `orto.npy` 1 | arrays: dsm, dtm equal; `orto.npy` equal to the old `orto`; `cellcol` equal to its 5 x 5 median; `orto_preview.jpg` the same bytes |
| `laser.py` | **125 s**, 3.6 GB: sheets read 47, **counted 68**, written 10 | **87 s**, 3.1 GB: read 46, counted 30, written 10 | all ten arrays equal |

- **A3** as planned, the median taken in A4's workers on bands of 250 rows (whole cells; asserted integral);
  `prep.npz` 466 MB (dsm, dtm, cellcol); `data/orto.npy` 2.4 GB uncompressed, in prep's `-o` list; `look.py` reads a
  box of it memory-mapped; `voxelize.py` refuses a `prep.npz` without `cellcol` ("rerun scripts/prep.py").
  `sidecar.ensure` now deletes a copy of an array the `.npz` no longer has (else the old `orto.npy`, 2.4 GB, stays in
  `data/cache/inputs/prep.npz/`).
- **A4**: the ortho's row bands in `multiprocessing.get_context("fork").Pool(8)`, written into anonymous shared
  memory (`mmap`), no pickling of results. 87 s -> 19 s with the medians. What is left of prep is serial: the ortho's
  mosaic (31 s, rasterio reads with `Resampling.average`) and deflating dsm + dtm (~30 s). Not done here.
- **A5** as planned (`count()` per sheet over its points' box, `percentiles_per_cell` one sort for both). The rest is
  LAZ decoding (46 s, already parallel in `lazrs`). On a fixture laser takes as long as before (~80-130 s): it reads
  all 40 sheets whatever the window.
- **A6**: `topz` layer by layer; `voxelize.own_peak_mb()` reads `VmHWM`, into the stage timings and `out.json` /
  `fstats.json` `peak_mb`; `regions.py` writes that into `stats.json` (falls back to `ru_maxrss`). Fixture regions
  (altstadt, main -> bs3): the stage "qa, deck_near, topdown" no longer sets the peak (0_0: 2650 -> 2433 MB at that
  stage, the region's peak 2650 -> 2500; 0_1024 2676 -> 2559; the thin ones 1121 -> 1016, 1069 -> 978), the stage
  0.96 -> 0.48 s; feature passes report their own 475-598 MB instead of the inherited 609 everywhere.

Still to confirm on the next full build of the real map (it reruns prep and laser once, as A3 changes prep's outputs,
and then every region and feature pass: `prep.npz`'s arrays changed): `git status --porcelain web/public/data` empty;
prep ~105 s and laser ~90 s in the build's log; the time before the feature pass (no 2.4 GB sidecar to copy and hash);
the regions' `stats.json` peaks (the large ones ~-15 % expected) and how many ran at once; `data/cache/inputs/prep.npz/`
without `orto.npy`; `look.py` on one building (reads `data/orto.npy`).

### 8.3 Done: vegetation and support_floating (handoff R7, 2026-11-25; no full build needed: outputs unchanged)

Profiled per statement (cProfile, and a timer around each statement of `vegetation`) on altstadt's region `0_0` and on
two regions of the real map (`1024_4096`, forest; `2048_7168`), run alone into scratch folders from the real inputs:

- `voxelize.py` `vegetation`: the leaves filled for all canopy cells' columns at once (was one pass over every canopy
  cell per height); the branches' voxels (`put`/`seg`) collected per batch of trees and drawn by `_put_wood` in numpy
  (a tree only writes into its own cells, so only the first of a voxel asked for twice counts -- same result as one by
  one); the crowns' reach in 16 directions for 256 trees at a time; `trees.register` (the Einzelbäume CSV) and the
  OSM matching as array operations; `species_map.grid` warps the files' pixel index once instead of each file
  (both files share one grid; checked equal to the per-file warp over the whole map).
- `debris.py` `support_floating`: the per-piece numbers (`_piece_stats`) for all pieces at once (round one has
  40 000-140 000 pieces, a numpy loop each was a third of the pass); in round two `occ` is `sub != 0` instead of a
  gather through the table; the boxes' empty top layers are not labelled. The labelling of the 2.3x-overlapping boxes
  (`ndimage.label`, `find_objects`) is what is left (~60 %): one label per region instead would change the logged
  count of big pieces and need ~1 GB of labels.

| region (one at a time, machine otherwise lightly loaded) | vegetation | support_floating |
|---|---|---|
| real `1024_4096` (forest, the slowest) | 17.2 -> 8.8 s | 13.7 -> 8.1 s |
| real `2048_7168` | 10.4 -> 6.2 s | 10.8 -> 7.5 s |
| altstadt fixture `0_0` | 4.4 -> 2.6 s | 4.9 -> 3.5 s |

Estimate for a full build: of the regions' ~1880 s summed (`timings.json`), vegetation 378 -> ~190 s and
support_floating 333 -> ~200 s, ~-17 % of the region phase. Proof: `check.py golden --compare` on haissengasse and
altstadt, 0 of 262 / 460 outputs differ; on the three regions above, every file of the region's folder (`vol.npz`,
`core.npz` arrays, `out.json` with all notes and trees, the debug lists) and every tile written the same bytes as
`main`'s. Region peaks unchanged within noise (the "palette, lists" stage's `np.unique` peaks ~250 MB higher or not
from run to run, with `main`'s code as well).
