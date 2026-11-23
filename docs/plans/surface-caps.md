# Plan: sloped surfaces as data (`caps` section) — one surface for mesher, car, walkers, drone

Repo: `/home/zink/dev/tmp-voxel-passau/warsaw-vibe-voxel`. This file is self-contained: implement from it alone.
Planning only was done so far; nothing in the repo was changed.

Inputs this plan is based on:

- `scratchpad/sinking/report.md` (read) and its scripts `measure.mjs`, `surface.mjs`, `probe.mjs`, `roads.mjs`
  (directory `/tmp/claude-1000/-home-zink-dev-tmp-voxel-passau/b7ca55d2-1927-44ae-8817-32b6764a94dc/scratchpad/sinking/`).
- `scratchpad/fine-voxels/analysis.md` **does not exist** (directory missing). Its conclusions were taken from the task
  text only: keep 1 m voxels, ship sloped surfaces as data, one "capped column" path for mesher and physics.
- The code as of `main` @ `0c65eb92`.
- Three throw-away probes on the real data (in
  `/tmp/claude-1000/-home-zink-dev-tmp-voxel-passau/b7ca55d2-1927-44ae-8817-32b6764a94dc/scratchpad/heights-plan/`:
  `probe.py`, `probe2.py`, `probe3.py`); their numbers are quoted below and marked "measured". Everything else is an
  estimate and marked so.

Hard constraints (unchanged): `scripts/palette.json` append-only; shaders get no new varyings and no flat varyings
(this plan needs **no shader change at all**); open data only; never push; do not touch port 5173 (use another port
for any dev server); no secrets, synthetic data only in tests; no new dependencies (numpy/scipy are already used).
A full data rebuild is a long, hard-to-undo action on shared data: **ask the user before starting it** (step R).

---

## 0. The idea in five sentences

1. The world stays 1 m voxels. A **cap** replaces the flat top face of one run of one column by a quad with four corner
   heights (1/64 m). That is all a slope is: a *capped column*.
2. The pipeline writes the caps (new node section `caps`) from the exact sources it already has: the cm terrain model
   under roads, the smooth deck profiles of bridges, later the LoD2 roof planes. It computes them on the map's global
   grid, so two neighbouring nodes hold the same numbers for the columns they share (apron) — no seam logic.
3. The client **reads** caps; it infers nothing. One three.js-free module `web/src/core/surface.ts` decodes them and
   answers "how high is the surface here"; the mesher, `world.ts` (walkers, traffic, camera), the car's terrain and the
   drone all call it. Drawn road == driven road by construction.
4. Smoothing happens once, in Python, and is what gets drawn. The car's private smoothed surface
   (`terrain.ts` `drive()`), the ramp inference (`ramps.ts`) and — in phase B — the roof plane fitting
   (`roofs.ts` `slopeBase`/`tidyPlanes`/`tileSeams`/`fit`) are deleted.
5. An edit never recomputes anything: a cap is *live* only while its run still ends where the cap says and has air
   above; otherwise the column is a plain voxel column again.

Two phases: **A** = ground (paved roads, squares, bridge decks, tunnel floors, unpaved lanes): fixes the car.
**B** = roofs: removes the roof inference. A is required, B is optional and decided after A (go/no-go criteria in B4).
Both phases' data is written by the same single full rebuild.

---

## 1. Data format

### 1.1 Section `caps`

New tag **`caps`**, appended after `brik` in both registries (ADR 0004: new tags go last, never reused):

- `scripts/tilefile.py` `SECTIONS`: `Section("caps", "1 (2 4 8: roofs only)", "<layout below>", "tile_fields.py (caps.py)")`
- `web/src/core/tile-sections.ts` `TILE_SECTIONS`: the same entry (`tag`, `levels`, `layout`, `owner`).
  `DECODED_TAGS` then includes it automatically; `decodeTile` must decode it (else it would silently vanish from `extra`).

Layout — `uint16[6 * n]`, little-endian, **planar** (six arrays of `n` values one after the other; `n = bytes / 12`;
planar packs ~2x smaller under gzip than record-major, as `flod`/`fols` already do):

| plane | meaning |
|---|---|
| `dcol[n]` | column index (as `cnts` counts columns: row-major over `S x S`, `S = N + 2`, apron included) **minus the previous record's column**; first record: the column. Records are sorted by column, ties by `ztop` ascending. |
| `dz[n]` | zigzag of (`ztop` − previous record's `ztop`); first: `ztop`. `ztop` = the top (in cells of the level, like `runs`' `z0 + len`) of the run whose top face the cap replaces. |
| `d0[n]`, `d1[n]`, `d2[n]`, `d3[n]` | zigzag of (corner height − `ztop * 64`), heights in 1/64 cell above the volume's floor. Corner order as today's `cornerQ`: 0 = (x, y), 1 = (x+1, y), 2 = (x+1, y+1), 3 = (x, y+1); x east, y south. |

zigzag(v) = `(v << 1) ^ (v >> 15)` on int16. Rules the writer guarantees and the reader may assume (reader ignores a
record that breaks them, never throws):

- at most **two** records per column: one on the run that ends at `grnd[c]` (the *ground cap*) and one on the column's
  last run (the *top cap*: a bridge deck, in phase B a roof). If both would be the same run there is one record.
- phase A: `|corner − ztop*64| <= 56` (±0.875 m): the cap stays above the voxel under the top voxel, which physics
  keeps as a floor. Phase B (roofs): `<= 448` (±7 m, a 75° roof's corner).
- a record whose four deltas are all 0 is not written (a flat cap is no cap).
- a column not written is exactly what it is today: flat voxel top.
- no section at all in a node with no caps (as `room`).

Quantisation 1/64 m (1.6 cm): it is what a vertex can carry today (`QuadBuffer.vertexQ`: whole metres in the position,
6 bits in `vattr.y`), so drawn and collided numbers are bit-identical. No shader change.

Why per column and not one height per grid point: a grid point is shared by four columns that may lie on different
surfaces (road and the wall top beside it, a roof and the street under its eave, two roofs at a step). Per-column
corners need no "which surface does this point belong to" inference in the client; where two neighbours' corners along
a shared edge are equal there is no riser, where they differ the mesher draws the riser between exactly those heights.
Agreement where it should hold is the writer's job and is checked (2.5).

Multiple levels per column: the cap names its run by `ztop`. Road under a bridge = ground cap (`ztop = grnd`), deck
above = top cap (`ztop` = column top). Roof over ground: only the top cap is exposed; the ground under a building gets
none.

### 1.2 Which surfaces get caps

Phase A, level 1 only (as today's ramps; levels 2/4/8 keep flat ground, unchanged):

- **Tier 1 (always):** ground whose top voxel is *paved* (exactly today's `pavedGround` set: paving, asphalt, sett,
  concrete, cycle, gravel, platform, parking, kerb colour, markings; not ballast, not steps) and **bridge decks**
  (a column's last run, top above `grnd`, paved top voxel).
- **Tier 2 (default on, see decision D1):** other open ground that is not a lawn/field (`bare`), not water, not
  `steps`, not masonry (`STONE`, `shore`): dirt tracks, yards, verges. This replaces the car's private "any ground"
  field for the lanes that are unpaved in the data.
- Not capped: lawns, fields, forest floor (they stay voxel terraces for everyone, the car included — D1), stairs
  (`steps`: flat treads stay), water, anything with a voxel standing on it (a pole, a parked car, a wall: the column
  top is not visible; its neighbours' caps simply end at its side, see 3.3).
- Covered ground (road under a bridge, a tunnel's floor) **is** capped if the cell above the ground run is air. The
  old `COVER_CLEAR`/`covered` special case disappears.

Phase B, levels 1, 2, 4, 8: roof columns with a known plane (today's `plns > 0` columns plus the flat ridge cells
beside them, see B1).

### 1.3 Size (measured with `probe3.py`, exactly this encoding, mock heights from the real terrain model)

- ~2.0–2.5 bytes per capped column after gzip.
- Tier 1: dense Altstadt nodes **6.6 KB/node**, rural nodes **1.0 KB/node**. Whole map (1971 level-1 nodes, 18.8 MB
  today for `tiles/1`, 34.8 MB for `tiles/1f`): estimate **+4–6 MB**.
- "All open ground incl. lawns and fields": Altstadt 20 KB/node, rural 36 KB/node → ~+60 MB. **Rejected** for this
  format (D1). If smooth lawns are wanted later, a dense per-point terrain sheet (measured ~8 KB/node, ~+16 MB) is the
  way; not part of this plan.
- Tier 2 and roofs: not measured; estimate tier 2 +1–3 MB, roofs level 1 +3–5 MB, levels 2/4/8 +1 MB. The implementer
  reports the real numbers in step P3 (acceptance: total `caps` bytes <= 12 MB, else come back to the user).

---

## 2. Pipeline

### 2.1 Where

Three small additions; the rules live in a new module that is **not** imported by `voxelize.py`, so tuning them never
forces the ~1 h region rebuild (`tile_fields` over the map takes minutes).

1. `scripts/voxelize.py` — export the continuous values it already computes, before they are rounded
   (append to `CORE_OUT`, near the existing `CORE_OUT["deck_near"]`, ~line 3768; `core.npz` is written from
   `CORE_OUT` automatically):
   - `deck_abs`: float32, `deck_abs - BASE` where `deck` else NaN (`deck_abs` ~line 3148; where the script has no
     profile (`prof is None`) write all-NaN).
   - `roof_z`: float32, the roof surface at the cell centre in m over `BASE`: the float whose rounding gave `zt`
     (`zt = g + topi`, line 2058) on cells where `PLANES > 0` or `ROOF_GX` is finite, else NaN. Add a `note()` with the
     count of cells where `round(roof_z) != zt` (expect ~0; they get no cap).
   - `roof_gx`, `roof_gy`: float32 copies of `ROOF_GX`, `ROOF_GY` (rise per metre east / south; NaN where unknown).
   Nothing else in `voxelize.py` changes. No voxel changes.
2. `scripts/regions.py` — next to `mapstore.write_npz("data/ground.npz", ...)` (~line 324) write
   `data/surface.npz` with `deck`, `roof_z`, `roof_gx`, `roof_gy` (`npz_entry(key, np.float32)`), and add
   `Path("data/surface.npz")` to the driver's output list (~line 249).
3. `scripts/caps.py` (new, ~200 lines, numpy only) + a hook in `scripts/tile_fields.py` `fields_window`
   (tile_fields already reads, extends and rewrites every node; a second read-modify-write step would make the two
   steps invalidate each other's stamp forever, so caps are written **by tile_fields**):
   - per window: `field = caps.fields(region rasters)` once;
   - per level-1 node: `b = caps.node_section(field, sec, r0, c0)`; `sec["caps"] = b` if `b` else `sec.pop("caps", None)`;
   - phase B: the same per level 2/4/8 node via `caps.lod_section(...)`.
   - `HALO` in `tile_fields.py`: raise 32 → **96** (the fallback relaxation below reaches 64 cells; keep it a multiple
     of 32 so the level-8 16 m cells stay aligned). `assert` the reach in `caps.py`.
   - `scripts/build_data.sh`, the `tile_fields` stamp line: add inputs `scripts/caps.py data/surface.npz data/prep.npz
     data/ground.npz`.
   - `scripts/check.py`: add `caps.py` wherever the list of windowed steps' modules is spelled out (grep
     `tile_fields`); `check.py windows tile_fields` must give the same bytes for every cover.

Rasters `caps.fields` reads for the window's region (all exist map-wide; read with `window.npz_region`):
`data/ground.npz` `g` (final voxel ground, int), `water`, `b` (building height, >0 = building), `rgb` (ground colour:
tier decision, see below); `data/prep.npz` `dtm` (1 m terrain model, float m a.s.l.); `data/surface.npz`.

If `data/surface.npz` is missing (data older than the rebuild), `caps.fields` returns `None` and tile_fields writes no
`caps` at all (never a half set). That keeps old data on the legacy client path (4.2).

Paved/tier decision in Python: by the ground colour names of `voxelize.py`'s `C` (tier 1: `paving paving2 asphalt
asphalt_l sett road_paving concrete cycle gravel platform parking kerb` + markings (`M_MARK`); tier 2 adds `dirt dirt2
track soil trambed` and any other `M_SOLID`/`M_SOIL` ground colour that is not `bare`, `steps`, `shore`, `STONE`,
`ballast`). Decide it **from the node's own runs** (palette id of the capped run's top voxel, via `scripts/palette.json`
entries), not from `rgb`, so it matches the shipped voxels exactly. Guard: `web/tools/tile-roundtrip.mjs` gets a check
that every palette id `caps.py` calls tier 1 has `SEM.PAVED` in `core/semantics.ts` and vice versa (the script prints
its id list as JSON on `python scripts/caps.py --paved-ids`).

### 2.2 The ground field (phase A) — "sheet graph diffusion"

Work on *nodes of a graph*, two layers per map column: layer G = the ground surface (integer top `g`), layer K = the
deck surface (integer top `round(deck)`, only where `deck` is finite). A node exists where the layer exists and the
column is not water (G also not where `b > 0`).

1. **Source height** per node (float, m over base):
   G: `dtm - BASE` where `|dtm - BASE - g| <= 0.75`, else `g` and the node is flagged *fallback* (the pipeline moved
   the ground there in whole metres: bridgeheads, tunnel floors, underpasses, snapped retaining walls; or the terrain
   model is interpolated under a bridge). K: `deck` (already a smooth profile); never fallback.
2. **Links** between 4-neighbours, any layer pair (G–G, K–K, G–K: the last is where a deck comes down onto its
   approach road): linked iff both nodes exist and their integer tops differ by at most 1 **and**, when both are G and
   neither is fallback, `|Δdtm| <= 0.6` (a real 1 m wall the terrain model sees stays a step: "kerbs/steps where
   real"). A step of 2 m or more is never linked. `steps`-material columns: exist as nodes for linking nothing (treat
   as absent), so stairs keep their treads.
3. **Smooth**: 16 iterations of `h = (2*h + Σ linked neighbours' h) / (2 + number of links)` (≈ Gaussian σ 2.8 m, but
   it never crosses a wall, a deck edge or water). Then **relax the fallback nodes only**: 48 more iterations in which
   only fallback nodes change (everything else is a fixed boundary): their 1 m staircases become a smooth
   interpolation between the good terrain around them.
   Implementation: plain numpy with shifted arrays, 4 directions x 4 layer pairs per iteration; rows/cols of the
   region, no global labelling → a value depends only on rasters within 64 cells: identical for any window cover.
4. **Corners.** For a node `a` at column `c` and the grid point `p` (one of the column's four corners): the mean of `h`
   over all nodes of the up-to-4 columns around `p` (both layers) whose integer top is within 1 of `a`'s — `a` included.
   `q = round(64 * mean)`, then clamp to `ztop*64 ± 56`. On a normal street (the four columns' tops span <= 1) all four
   take the same number → a continuous surface; across a wall each side takes its own.
5. **Which runs get a record** (per node, vectorised over its `S x S` columns from `cnts/runs/grnd`):
   ground cap if a run ends at `grnd[c]`, no run starts at `grnd[c]` (air above), its top voxel is tier 1/2;
   top cap if the last run's top is above `grnd[c]`, its top voxel is paved (deck rule as `ramps.ts` today),
   and `|deck - top| <= 0.75`. Corners from layer G resp. K of the map column (apron columns outside the map: none).
   Assert `g == grnd` on the node's columns inside the map (note and skip the column otherwise).

Parameters (module constants in `caps.py`, tuned in step P3 without a region rebuild): `SRC_TOL 0.75`, `WALL_TOL 0.6`,
`N_SMOOTH 16`, `N_RELAX 48`, `CLAMP 56` (60 since docs/plans/road-clearance.md; ±56 / ±0.875 m below is that
first value).

Measured on the Altstadt window (`probe2.py`, carriageway cells of `qa_roadmask`, second difference of the surface per
metre, linked triples only): raw voxels p99 100 cm; raw terrain model p99 30 cm; this diffusion at 16 iterations
**p99 ~9 cm**; an approximation of today's car field (3 m box + σ 2 m Gaussian of the voxels) p99 8–22 cm. So the drawn
road becomes about as smooth as the surface the car privately drives on today, while staying within ~8 cm (mean) of the
real terrain. The tail (p99.9 ~1 m) in the probe is real walls plus bridge/tunnel cells the probe did not model; the
implementer re-measures with `caps.py --report` (2.5).

### 2.3 Roofs (phase B writer; written in the same rebuild, read by the client only in phase B)

Per roof cell with finite `roof_z, roof_gx, roof_gy` whose column top in the node is that roof (`top == round(roof_z)`,
roof material on top — as `plane_codes()` requires): the cell's plane is exact. Per grid point, the values of the
up-to-4 adjacent roof cells' planes at that point are grouped and merged with the rule `roofs.ts` `slopeBase` uses
today (port of its `meet`, ~40 lines): cells of one building, or within 1 m of each other, meet; at a ridge or hip the
lowest plane wins, in a valley the highest, else the mean; a cell the result would move more than its span
(0.5 m + half the slope's rise per metre) keeps its own value. Because this runs on the global grid, tile edges agree —
`tileSeams` has no successor. `tidyPlanes`' two rules become writer filters: (1) a steep small helm (mean slope >= 60°,
under 64 columns, set apart by a step or a flat rim) gets no caps (stays voxels); (2) a fragment of <= 3 cells inside
another plane of its building takes that plane where its top fits within 1 m. Flat cells of a building beside a slope
(the flat ridge of a fitted roof) get a level cap at their plane height so the slope runs up to them.

Levels 2/4/8 (`caps.lod_section`): the block's four corners take the level-1 corner values of the block's four corner
columns (corner 0 of the block's first column, corner 1 of its last column in the first row, ...), divided by `s`
(units: 1/64 cell); written only if all four exist and lie within the block top's span. `plns` stays in all levels
(lighting codes, voxel-roof shading).

### 2.4 Kerbs, steps, walls — what stays sharp

- Kerbs have no height in the voxels (a kerb is a ground colour level with the street); nothing to keep.
- Stairs (`steps`): never capped, never linked.
- A drop the terrain model shows (> 0.6 m between adjacent cells) or any 2 m step: not linked → a riser, exactly at
  the cell edge, drawn and collided.
- A 1 m voxel step that is only rounding (the terrain is continuous): linked → a smooth ramp (as today, but true to
  the terrain instead of a 3 m mean in 1/8 m steps).

### 2.5 Writer self-check (`python scripts/caps.py --report`, also printed by tile_fields per window)

Counts: capped columns by kind (ground tier 1 / tier 2 / deck / roof), bytes, corners clamped, columns skipped
(`g != grnd`, deck mismatch), share of `qa_roadmask == 1` cells that carry a cap (expect >= 97 %), **edge mismatches**:
pairs of adjacent capped columns linked by rule 2 whose shared-edge corners differ (expect < 0.5 % of linked edges;
they come from the clamp only), roughness of the capped surface along the ways of `traffic.json` (second difference
per metre: p50, p99). Add to `check.py verify` (`VERIFY`): caps present on the fixture, road share >= 95 %, roughness
p99 <= 12 cm, mismatches <= 1 %.

---

## 3. Client

### 3.1 `web/src/core/surface.ts` (new, ~100 lines, three.js-free; `tools/core-deps.mjs` must stay green)

```ts
export interface CapField {
  S: number;
  z: Uint16Array;   // 2 per column: [ground cap's ztop, top cap's ztop], 0 = none
  q: Int32Array;    // 8 per column: 4 corners (1/64 cell) per slot
  any: boolean;
}
// decode + liveness (3.4): only records whose run still ends at ztop with air above come out
export function capField(N: number, cols: { counts: Uint16Array; runs: Uint16Array; ground: Uint8Array; caps?: Uint16Array | null }, off?: Uint32Array): CapField | null;
export function capSlot(f: CapField, c: number, ztop: number): -1 | 0 | 1;
export function cornerQ(f: CapField, c: number, slot: number, k: number): number;       // falls back to ztop*64 if none
export const diagonal02: (q0: number, q1: number, q2: number, q3: number) => boolean;   // today's rampDiagonal02
// THE function: the surface of column c's run ending at ztop, at (fx, fy) in the cell, in cells; ztop if it has no live cap
export function surfaceAt(f: CapField | null, c: number, ztop: number, fx: number, fy: number): number;
```

`surfaceAt` interpolates over the two triangles the mesher draws (same diagonal rule) — moved from `ramps.ts`
`rampHeight`. Every reader below goes through `surfaceAt`/`cornerQ`; nobody else touches the section.

Plumbing (`caps` rides exactly where `rooms`/`planes` ride today — grep `rooms` to find every site):
`tile-data.ts` (`Columns.caps`, `decodeTile` returns `caps: Uint16Array | null`), `types.ts` `ColumnData`,
`mesher.worker.ts` `copyColumns`/`columnBuffers`/`meshJob`, `stream.ts` (`replaceColumns` keeps the node's L0 `caps`
with the edited columns), `core/tile-cache.ts`, `core/live-edits.ts` `LiveNode.base`, `world.ts`,
`checks/world.ts` (synthetic node files), `tools/tile-roundtrip.mjs` + `scripts/tile_roundtrip.py` (write a
`caps` section with ground, deck and negative deltas; decode and compare).

### 3.2 Readers

- **Mesher** (`mesher.worker.ts`): `meshInto` builds `capField(N, cols, off)` instead of `rampField(...)` (level 1);
  the foliage job's `feet` is the base's `capField`. `meshFaces`' two tests change from "paved column at
  `rp.ground[c]`" to "`capSlot(f, c, pz + 1) >= 0`" (so a road under a deck is drawn sloped too); the side test
  becomes: *the face between two columns that both have a live cap at this level is left to `emitCaps`*, which draws
  the trapezoid between the two columns' corner heights along the edge (nothing if equal). `emitRamps` → `emitCaps`:
  its three parts stay (tops with planar merging; fills between neighbours; a non-capped neighbour's wall face
  continued down to a cap that dips under its voxel top), reading `cornerQ` instead of `rp.h`/`PINNED`. Its
  tile-border **skirt** branch goes: apron columns carry their real caps, so the fill at the border is exact.
  `emitFeet`, `rampBelow`, `emitPrism`'s foot: same change of accessor. Vertex format, face groups, AO: unchanged.
- **`world.ts`**: delete `ramps` WeakMap, `ramp()`, the `paved` mask; add a `WeakMap<ColumnData, CapField | null>` and
  use `surfaceAt`. `surface(x, r, z)`: among the column's live caps the one whose height is within 1.5 of `z`, nearest
  first (so traffic on a deck and traffic under it both land right), else `z`. `groundAt`: ground slot. `top`,
  `topSolid`, `support`: the cap of the run they pick, else its integer top.
- **Car terrain** (`physics/rapier/terrain.ts`): `terrainTile` keeps `iv/off/water` and gets `caps: CapField | null`
  (from `capField` on the base columns). `chunkShapes`: a column with a live ground or deck cap has that run's top
  voxel left out of the voxel shell (the voxel under it stays as the floor) and contributes its quad to **one**
  trimesh for everybody (`WORLD_GROUPS | car`, `FIX_INTERNAL_EDGES`, friction 0.9). `groundAt(x, z, top)` =
  highest interval top <= `top`, through `surfaceAt`; the `car` argument goes (`car.ts` callers updated). `solidTop`:
  the open-top-voxel case for capped columns, no `car` flag.
- **Drone** (`nav/voxel-collision.ts`): keeps sweeping voxel boxes (a cap is within ±0.875 m of its voxel top; the
  drone is not a ground vehicle). Only `surface(x, z)` (where it settles / what the HUD reads) takes the cap through
  `surfaceAt` for the run it picks. (Decision D5 if exact drone-on-slope contact is wanted later.)
- **Walkers / people / traffic / camera**: all through `World` — no further change.
- Roofs are **not** collided as slopes in either phase (physics keeps voxel roofs); only drawn (phase B).

### 3.3 Things that stand on capped ground

No new rule: a column with a voxel standing on its ground run has no live cap (liveness: air above). Its neighbours'
caps end at its side; where a neighbour's cap dips below the standing column's voxel top, the existing "wall face goes
on down to the ramp" part of `emitCaps` closes the gap; where it rises above, the foot is buried a few cm. Unlike
today the road no longer bends to meet every pole. Trunks of the foliage tile: `emitFeet` as today.

### 3.4 Liveness = the edit rule (see 5)

`capField` keeps a record iff, in the columns it is given (L0 or edited): a run ends exactly at `ztop`; no run starts
at `ztop` (the cell above is air; the foliage tile does not count); and the column is solid from
`floor(min corner / 64)` up to `ztop`. O(runs of the column), done once per field build.

### 3.5 What is deleted, what stays

Deleted in phase A (after the rebuild, step A8):

| what | lines (est.) |
|---|---:|
| `web/src/ramps.ts` whole file (`rampField`, `PINNED`, `COVER_CLEAR`, `ramped`, `rampHeight`) — accessors live on in `core/surface.ts` | −130 |
| `terrain.ts`: `field()`, `ramps/ramped/car/carRamped/top`, the `DRIVE` block and `kernel`, `drive()`, `pointQ()`, `around()`, the car-only trimesh (`dverts/didx`), the not-car `top` voxel collider, `car` flags | −130 |
| `world.ts`: `ramps`, `ramp()`, `paved` mask | −10 |
| `mesher.worker.ts`: three `rampField` call sites, border skirt in `emitRamps`, `PINNED` handling | −25 |
| `tools/rapier-car.mjs` `--set` for `DRIVE`, `scenarios.ts` `DRIVE` re-export | −10 |
| added: `core/surface.ts` | +100 |

Deleted in phase B (step B5): `roofs.ts` `slopeBase` (~150, replaced by ~50 reading caps), `tidyPlanes` (~77),
`tileSeams` (~77), `fit` (~25), the tile-edge skirt in `emitEdge` (~15); `mesher.worker.ts` `SectionMemo.slopes`,
`slopeChange`, `ROOF_REACH` and the whole-node `slopeBase` pass in `meshSections` (~40). ≈ −330.

Total client: ≈ −300 (A) −330 (B) + 100 new. Python: ≈ +200 (A) +120 (B), in one module with its own report.

Stays: `chamfer.ts` (diagonal walls in plan — unrelated to heights), the emitting half of `roofs.ts` (`emitTops`,
`emitEdge`, `eaveSteps`, `emitFill`), `roofPlanes()`/`plns` (lighting of roofs, voxel and sloped), `wallAngle`,
`emitCaps`/`emitFeet`, `car.ts`' step wedges (real steps: stairs, platforms, lawn terraces), `G_CAR_ONLY` (the wedges'
group), `SEM.PAVED` (still read by `car.ts onRoad` etc.).

---

## 4. Migration — small steps, each green on the gates

Gates (run in `web/` unless noted): `npx tsc --noEmit`; `node tools/rapier-car.mjs` (42); `node tools/collision.mjs`
(16); `node tools/world-smoke.mjs`; `node tools/section-check.mjs`; `node tools/mesh-golden.mjs check <file>`
(record a golden from untouched `main` first: `write /tmp/.../golden-main.json` in the scratchpad);
`node tools/core-deps.mjs`; `node tools/tile-roundtrip.mjs`; repo root: `uv run python scripts/check.py build
--fixture scripts/fixtures/<name>.json` for `altstadt`, `altstadt_wide`, `hals`, `kachlet`, `schalding`;
`uv run python scripts/palette_check.py`.

Principle: **a node with a `caps` section takes the new path, a node without takes the legacy path, whole.** Today's
`web/public/data` has no caps, so every real-data gate keeps running the legacy code byte-identically until the
rebuild. The new path is exercised on fixture builds (they do contain caps once P1–P3 are in). A switch
`CAPS.use` (exported from `core/surface.ts`, default `true`; `?caps=0` in the viewer, `CAPS=0` env in the tools)
forces the legacy path on data that has caps, for A/B measurement. Both the legacy path and the switch are removed in A8
(done: neither `?caps=0` nor `CAPS=0` exists any more).

Tools on fixture data: add `tools/data-dir.mjs` (`export const dataDir = process.env.VOXEL_DATA ?? <web>/public/data`)
and use it in `mesh-golden`, `rapier-car`, `collision`, `world-smoke`, `section-check`, `contact` (new). Fixture data
is at `data/check/<fixture>/base/web/public/data` (no `tiles.tris`, no `streetlamps.json` — the tools above do not
need them; if one does, make it optional).

### Step 0 — car drawn on its wheels: **already in `main`** (`b24a8f5d`)
`drive-world.ts drawn()` uses `RapierCar.ride` (mount 0.2 + mean suspension length + wheel radius), not the constant
`build.ride` 0.84; the commit reports drawn wheels within 0.3 cm (median) on a flat street. Nothing to ship. Re-measure
it once with the new tool in A1 so the baseline records it.

### A1 — measurement tool and baseline (no behaviour change)
`web/tools/contact.mjs` from `scratchpad/sinking/measure.mjs` + `surface.mjs` (see 6). Run on `main` data, legacy code;
commit the numbers as `web/tools/baselines/contact-legacy.json`. Gates: all (nothing changes).

### A2 — `core/surface.ts`, legacy field behind the same interface (no behaviour change)
Create `core/surface.ts` (3.1). Make `rampField` (kept, moved to `core/caps-legacy.ts`, marked for deletion) return a
`CapField` (per-column corners = today's `cornerQ` values; slot 0 or 1 by whether the surface is a deck). Port the
mesher, `world.ts`, `terrain.ts` to the accessors only (`cornerQ`, `capSlot`, `surfaceAt`). The car's second field
(`car`) stays as it is, also as a `CapField`. Gates: all; `mesh-golden` **byte-identical** to `golden-main.json` is the
target — if a handful of faces differ where a free point's height happened to equal the voxel top, document them in
the commit and re-record. `rapier-car` 42/42 with unchanged numbers.

### P1 — registry + decode + round trip (no data written yet)
`tilefile.py` `SECTIONS`, `core/tile-sections.ts`, `tile-data.ts` decode, `Columns.caps` plumbing (3.1 list),
`tile_roundtrip.py`/`.mjs`. Gates: all; `tile-roundtrip` proves both registries agree and a caps section survives
read → write → decode.

### P2 — voxelize exports + `data/surface.npz` (pipeline code only; **do not run the full build**)
2.1 items 1–2. This touches `voxelize.py`, so the next real build rebuilds every region — it would anyway (larch
skeletons `1ba36efb`, Schalding piers `e24d07eb`, bridge lamps `0c65eb92` are waiting). Gates: `check.py build` on the
five fixtures; `check.py covers` on `altstadt` (same bytes for 1 region and 2x2); voxel sections of the fixture nodes
unchanged against a build from `main` (`check.py golden --record` on main, `--compare` here: only `core.npz`-derived
new files and `surface.npz` may differ).

### P3 — `caps.py` + tile_fields hook (phase A ground + decks, phase B roofs behind `caps.ROOFS = True`)
2.1 item 3, 2.2, 2.3, 2.5. Gates: fixtures build; `check.py windows tile_fields` (same bytes for every cover);
`check.py verify` with the new caps checks; `caps.py --report` numbers in the commit message (sizes per kind, road
share, mismatches, roughness). Tune `N_SMOOTH`/tolerances here — minutes per run, no region rebuild.
Phase B's writer can land later than A's as long as it lands **before step R**. (It did not: see Phase B's Done.)

### A3 — mesher reads caps (fixture data shows the new path)
`meshInto`: `cols.caps && CAPS.use ? capField(...) : legacy`. `emitCaps` generalisation (3.2: caps not at the column
top, no border skirt on the new path). New check in `tools/section-check.mjs` or a small `tools/caps-check.mjs`:
for 20 fixture nodes, every vertex of every cap top equals `cornerQ` (bit-exact), and for each pair of neighbouring
nodes the vertices on the shared border coincide (no crack: compare the two meshes' border vertices). Gates: all on
main data (legacy, byte-identical); on fixture data: `tsc`, `section-check`, the new check, a visual pass
(`tools/shoot.mjs` on a dev server on a port other than 5173 pointed at fixture data: a sloped street, a bridge with
its approach, a road under a bridge, a tunnel mouth, a square beside a retaining wall).

### A4 — `world.ts` reads caps
3.2. Gates: all; on fixture: `collision.mjs`, `world-smoke.mjs`; traffic and people stand on the drawn surface
(spot check: `life.ts` positions vs `surfaceAt` on a deck and under it).

### A5 — car terrain reads caps
3.2: with caps, `terrainTile` builds no legacy fields; `chunkShapes` one trimesh; no `drive()`. Synthetic scenarios
(`scenarios.ts synthMap`): give them caps the way the pipeline would — add `capsFromHeight(h: (x, z) => number)` (the
scenario's analytic ground at the grid points, clamped ±56/64 of each column's top; ~15 lines in `scenarios.ts`) for
the scenarios that are *roads* (`ramp_street`, `bridge`, `bus_ramp`, `slope*`, `crest*`, `ramp_landing`,
`flat_chunk_borders`); scenarios that test real steps (`terrace*`, `kerb_paved_diag`, `steer_step`, `cliff*`, `garage`)
get none. Run the 42 with `CAPS=0` (legacy: must be unchanged) and with caps: all must pass; where a pass criterion
encodes the old private smoothing (e.g. a `jerk` bound), re-derive it from the new run and say so in the commit.
Gates: all; `contact.mjs` on fixture data, caps vs `CAPS=0` (acceptance numbers in 6);
`node tools/rapier-car-bench.mjs` (chunk build time: budget unchanged 2 ms/frame, slowest chunk not worse than +30 %).

### A6 — drone + remaining readers
`voxel-collision.ts surface()`; grep for any leftover import of `caps-legacy` outside the legacy branch. Gates: all.

### R — the one full rebuild (ask the user first)
Precondition: P1–P3 (incl. the roof writer), A1–A6 merged; fixtures green; `caps.py --report` on fixtures accepted.
`sh scripts/build_data.sh` (≈1 h+; all regions rebuild: larch, piers, lamps, surface exports), then `tile_fields`
(caps), `world_id`, `tris`, `lamps` run as part of it. After it: every real-data gate now runs the **new** path.
Expected, intentional changes: `mesh-golden` (re-record; review the diff as screenshots, not hashes), `meta.json`
`tiles.tris`/`bytes`/`world.buildId`, `rapier-car --road/--roads` wobble numbers. Record
`web/tools/baselines/contact-caps.json`. If a rule turns out wrong afterwards: edit `caps.py`, rerun
`FORCE=tile_fields sh scripts/build_data.sh` — minutes, not a region rebuild. Only a mistake in the three exported
rasters (P2) would need the regions again; that is why P2 exports raw values and decides nothing.

### A7 — acceptance on the real map
Run 6 on the full data. If green → A8. If ride quality fails: tune `caps.py` (R's cheap rerun), not the client.

### A8 — delete the legacy path
3.5 phase A list, `core/caps-legacy.ts`, `CAPS.use`, `?caps=0`. Update the comments that describe ramps
(`terrain.ts` header, `car.ts` header, `mesher.worker.ts`), README's data section, ADR 0004's tag list, commit ADR 0005
(8). Gates: all (golden recorded in R must stay byte-identical through the deletion).
**Done** on branch `a8-legacy` (ADR: `docs/adr/0005-surface-caps.md`). Differences from the above: `tools/contact.mjs`
was never built (`tools/surface-gap.mjs` is the acceptance tool; its baseline re-recorded on the caps data);
`caps-check.mjs` compares against the node without its caps (voxels) instead of the legacy path; the roofs' inference
(phase B) stays; `PAL_GROUND` and `RULES.groundForCar` went too; `formatVersion` was not bumped.

### Phase B — roofs (optional; data already there after R)
- **B1** `roofs.ts`: `slopeBaseFromCaps(N, T, cols.caps, planes, bidAt)` returning today's `SlopeBase` shape
  (`hq` from the caps, `reg` by flood fill over equal `plns` code + building for merging and lighting, `nq` = the
  cell's `plns` code, or at a merged corner the code of the cell whose plane the height equals; `pure` = corners equal
  the cell's own plane; no `seam`). `emitTops` merges by coplanar corners (as `emitCaps` does) instead of `planeQ`.
  Switch per node as in A3. Levels 2/4/8 the same with their own caps.
- **B2** `meshSections`: a roof edit touches only its columns' caps (liveness) → drop `SectionMemo.slopes`,
  `slopeChange`, `ROOF_REACH`; sections within `INFLUENCE` of the edit re-mesh.
- **B3** checks: `section-check` (sections == whole node), border-vertex check across nodes at all levels (no cracks
  where `tileSeams` used to bend planes), T-junction count on the 4 Altstadt tiles of `164ca18d` not worse.
- **B4 go/no-go** (user decides on screenshots: Altstadt roofs near, the same from 1.5 km at levels 2 and 4, the Dom,
  a street of dormers): go if no roof looks worse than today and `tiles.tris` at levels 2/4/8 is within +5 %.
  No-go → keep today's roof code, set `caps.ROOFS = False`, rerun `tile_fields` (drops the roof records), done.
- **B5** delete the roof inference (3.5 phase B list). Gates: all; golden re-recorded once in B1's switch-over.

**Done** (B1-B5, branch `roofs`, 2026-11-22; the real map not rebuilt -- the committed data has no `roof` section and
draws voxel roofs until `tile_fields.py` runs again, see below). Differences from the plan, code reality and intent
first:

- **The roof writer did not exist** behind `caps.ROOFS = False` (only the flag and P2's rasters). Written now:
  `caps.region_roofs`, `roof_fields`, `roof_section`, `encode_roof`/`decode_roof`; `ROOFS = True`.
- **A section of its own, `roof`** (after `caps`, levels 1 2 4 8), not slot 1 of `caps`: the car, walkers, world and
  drone read `caps` and must not get roofs (drawn only, 3.2); the caps keep their +-56 rule. Corners as differences
  (corner 0 from the west neighbour's corner 1, 1 from 0, 2 from 1, 3 from 0): on the map 3.6 instead of 5.6 MB
  gzipped at level 1. Liveness: the record's run is still the column's last (no "solid down to the lowest corner":
  nothing stands on a roof's cap).
- **Eligibility** (2.3 said `top == round(roof_z)`): voxelize.py rebuilds some roofs after `roof_z` (the Dom's: 2 m
  off; rows a metre off), so a cell takes its plane moved by the median whole-metre offset of itself and its 8
  neighbours (up to 3 m), and is in if its own offset is within a metre of that. Its voxel may then lie under or over
  the cap: the mesher hides it. Holes (no plane of its own, 3 or 4 sides in its roof; a fitted roof's cells whose
  distance to the eaves has no direction) take the neighbours' mean plane where their top fits within a metre.
  Slopes under 10 degrees (no plane code) are level at their voxels' top, as the client's flat regions were.
- **The meet** as 2.3 / `slopeBase`, but a corner's span is measured from its own plane, not from the voxels' top.
- **`tidyPlanes` has no successor**: with the exact planes the Dom's towers and the old town's helms came out clean
  (the crumpled cones were the fits'); fragments are LoD2's own small planes. Level cells get a record only next to a
  sloped one of their building (8 neighbours): one surface for the merges (as voxel tops beside the slope, the
  slope's corners lay along the voxel faces' edges: roof T-junctions in the four Altstadt nodes of 164ca18d: 106 with the inferred roofs; from the caps 124 without these records, 71 with them).
- **Tops reading the caps cannot be merged by an exact plane** (each corner its plane rounded): `emitTops` merges
  cells of one plane code whose corners lie within 1/64 m of the plane through the rectangle's corners and that meet
  without steps, and draws the rectangle through the corners of its outline (the ladder, at the cells' own corners).
  At level 1 a merge stops at its 16-column section's end also when the node is meshed whole, and the ladder takes the
  points on a section's edge, so whole and sectioned meshes are the same (`section-check`). Cost: level 1 +0.5 % on
  the Altstadt fixture (no cut: +0.0 %).
- **The node-border skirt stays** (3.5 listed it with the inference): its reason now is a neighbouring node not
  shown (as `capEdges` keeps one), not two estimates; it is sunk 1/64 m.
- **B2** as planned: no memo, `bids`/`roofsChanged` gone (stream.ts, sections.ts, the tools), an edit re-meshes the
  sections within `INFLUENCE`; `section-check` (with its roof carves) passes on fixture and map data with roofs.
- `caps-check.mjs` skips roof-lit tops in its ground-cap planarity test and compares the `roof` sections of every
  pair of neighbouring nodes at every level; `tile-roundtrip` writes and decodes a `roof` section and tests
  `roofField`'s liveness.

Numbers. Altstadt fixture (`check.py build`, tile_fields with the writer): every node's voxel and `caps` sections
byte-identical, only `roof` added (167 of 344 nodes); `check.py windows tile_fields --covers 2x2,1024` and `verify`
ok. Triangles (tris.mjs, against the inferred roofs on the same voxels): L1 +0.34 %, L2 +3.8 %, L4 +3.4 %, L8 +4.0 %
(B4: within +5 %). Gzipped nodes: L1 +0.68 MB, L2 +0.23, L4 +0.06, L8 +0.01. The committed map data in a scratch copy,
`tile_fields.py` rerun (40 windows, 63 s): `roof` +5.6 MB gzipped (L1 +3.9, L2 +1.3, L4 +0.33, L8 +0.05; with the
ground caps (~10.6 MB) past the 12 MB of P3's acceptance: for the user), triangles L1 +0.8 %, L2 +1.5 %, L4 +1.5 %,
L8 +0.3 %, 1c +1.6 %. Screenshots (fixture, before/after): the Dom's nave roof one plane instead of terraces, the
old town's roofs from 1.5 km alike; left: a few small creases where a corner's span kept its own (the Dom's south
aisle, its towers).

---

## 5. Edits (L1 / L2)

Rule: **a cap is live only while the run it names still ends at `ztop`, has air directly above, and is solid down to
the cap's lowest corner** (3.4). Otherwise the column is a plain voxel column. Nothing is recomputed, nothing is
stored, nothing is added to an op:

- `core/columns.ts`, `core/layers.ts`: **no change**. `effectiveColumns` returns columns; the node's L0 `caps` array
  is carried beside them untouched (as `planes`/`rooms` are); every reader builds its `CapField` from *(columns,
  caps)* and the liveness test drops what an edit invalidated. Same result in the viewer, in Node tools and on a
  future server; dropping L2 gives the L0 caps back by itself.
- Dig a crater in a road: the dug columns' runs end lower → their caps are dead → flat crater floor; the rim columns
  are untouched → still capped; the mesher's generic side rule draws the riser between them. No crack possible.
- Build on a road: a run now starts at `ztop` → dead cap under the block; the block's side faces reach down to the
  neighbours' caps (3.3).
- Repaint the top voxel: the run still ends at `ztop` → the slope stays (wanted).
- Remove a block again / L2 reload: the cap is live again.
- Section re-meshing (ADR 0003): a cap change affects its column and its four neighbours' side fills — inside the
  existing `INFLUENCE` of 6; no new reach.
- Checks: extend `tools/edit-roundtrip.mjs` (liveness cases above on a synthetic node) and `tools/world-smoke.mjs`
  (its crater is on a flat road: add one on a sloped street of the fixture; car rests in it; after dropping L2 the
  wheels are back on the cap within 2 cm).
- Not in this plan, reserved in the ADR: player-made slopes (an op kind that writes an L1 cap) and bricks (a
  brick-refined cell drops its column's cap by the same liveness idea).

Stricter alternative (decision D3): "any op that touches a column kills its caps for good" needs a touched-columns
bitmap returned by `effectiveColumns` and passed to every reader — more plumbing, and a repaint flattens the street.

---

## 6. Acceptance measurement (new): `web/tools/contact.mjs`

Built from `scratchpad/sinking/measure.mjs` (drives `scenarios.ts Sim` along `traffic.json` ways with pure pursuit,
samples every step) and `surface.mjs`. Routes named by **project-grid** coordinates (so main data and fixtures resolve
the same streets): one flat Altstadt street (the report's `altstadt_flat_60`), the three steepest paved roads of
`rapier-car.mjs --roads`, two bridges end to end including both approaches (Marienbrücke, Schanzlbrücke or the ones
inside the fixture), one road under a bridge, one tunnel; each at 0 (parked), 30 and 50 km/h; car and bus.

Per route and speed:

1. **Contact vs drawn**: for every wheel in contact, wheel-ray hit height − `surfaceAt` of the drawn surface at that
   (x, z) (the same function the mesher's vertices are checked against in A3). Pass: p99 |d| <= 2 cm and max <= 3 cm on
   flat, ramps and decks. (Legacy baseline, from the report: flat mean 1.2 cm; ramps mean 8–13 cm with 20–33 % beyond
   5 cm; decks down to −50 cm.)
2. **Drawn wheel vs drawn road** (what the user sees): bottom of the drawn wheel (`drive-world.drawn()` pose) −
   drawn surface: median within ±1 cm, p95 within ±2 cm.
3. **Ride quality, not worse than today**: pitch jitter (RMS pitch rate, the `wobble` of `scenarios.ts`), heave (RMS
   vertical acceleration of the body), share of steps with a wheel off the ground, minimum speed held. Pass: each
   <= 1.10 x the legacy value for the same route and speed (`contact-legacy.json` from A1 on main data; before R the
   comparison is caps vs `CAPS=0` on the same fixture).
4. Output: one line per route + a JSON; exit code 1 on a failed threshold. Thresholds live at the top of the tool.

Plus the standing gates: `rapier-car` 42/42, `rapier-car --roads` wobble table not worse (mean) than before R.

---

## 7. Risks and open decisions (plain terms)

Decisions for the user:

- **D1 — what gets smooth.** Recommended: roads, squares, bridges, tunnels and unpaved lanes/yards (tiers 1+2).
  Lawns, fields and forest floor stay 1 m terraces *for everything, including the car* (today the car secretly glides
  over them while floating/sinking up to half a metre; afterwards it bumps over them, helped by the existing step
  wedges, but what you see is what you hit). Smooth lawns for everyone would cost ~60 MB more data in this format, or
  a second, denser terrain format (~16 MB) later. OK to accept bumpy lawns for now?
- **D2 — roofs (phase B).** The roof data is written in the same rebuild either way; switching the client over is a
  separate, optional step judged on screenshots (B4). Do it right after A, or park it?
- **D3 — edit rule.** Recommended: "a slope survives as long as its top block is untouched and nothing is put on it"
  (no bookkeeping, 5). Alternative: any touch kills the slope for good.
- **D4 — how smooth vs how true.** Default smoothing is ~3 m wide; measured it leaves the road within ~8 cm of the
  surveyed terrain and about as smooth as the car's hidden surface today. More smoothing = softer ride, less true
  (and can be changed later in minutes).
- **D5 — drone and roofs keep colliding with blocks** (±0.5–0.9 m off the drawn slope). Fine for now?
- **D6 — when to run the one full rebuild** (≈1 h+, new build id; it also brings the pending larches, Schalding
  piers and bridge lamps).

Risks:

- **Terrain model is not a clean road surface everywhere** (measured: 2 % of Altstadt road cells disagree with the
  voxels by > 0.75 m — under bridges, in tunnels, at lifted bridgeheads). Those fall back to smoothing the voxel steps
  (2.2 step 3). Residual risk: visible soft waves there. Mitigation: the report's roughness number per route; tune in
  minutes.
- **More triangles at level 1**: real heights are rarely coplanar, so capped tops merge less than today's 1/8 m
  ramps. Estimate +10–25 % triangles on dense level-1 nodes (not measured). Check `tools/tris.mjs` after R; if the
  phone budget suffers: snap near-level stretches (all four corners within 2/64 of one height) to that height in
  `caps.py` so they merge.
- **Physics cost**: one trimesh with internal-edge fixing per chunk for all capped ground instead of voxels + a
  wheels-only mesh (~1 ms per chunk noted in today's code). Gate: `rapier-car-bench.mjs` in A5.
- **Scenario thresholds** tuned to the old private smoothing may need re-deriving (A5) — say so per scenario.
- **Clamp lips**: where the surface would leave ±0.875 m of its voxel a corner is clamped and a small riser appears.
  Counted by the writer's report; expected rare (steep banks, not roads).
- **Bridge ends**: deck and approach are one linked sheet (2.2 G–K links); the `bridge` routes of `contact.mjs` are
  the test. If a lip remains, fix in `caps.py`.
- **Level 2/4/8 roofs from sub-sampled corners** may look blunter than today's fitted planes → B4 is a go/no-go.
- **Paved rule in two languages** (`materials.ts pavedGround` vs `caps.py`): guarded by the id-list comparison in
  `tile-roundtrip.mjs`.
- **A second full rebuild** is needed only if P2's exported rasters are wrong. Mitigation: fixtures are built and
  inspected with them before R.
- The `fine-voxels/analysis.md` this plan was to build on was not available; its line estimates were re-derived from
  the code (3.5).

---

## 8. ADR draft — `docs/adr/0005-surface-caps.md`

```markdown
# 0005 Sloped surfaces are data: the `caps` section

Status: accepted (phase A: ground; phase B: roofs -- see the end). Code: `scripts/caps.py` (writer, in
`scripts/tile_fields.py`), `web/src/core/surface.ts` (reader); checks: `web/tools/contact.mjs`,
`web/tools/tile-roundtrip.mjs`, `scripts/check.py verify`.

## Context

The world is 1 m voxels; a street on a slope is a staircase. The viewer smoothed it three times over, each on its own:
the mesher's ramps (`ramps.ts`: a 3 m mean of the paved columns' tops, per tile, with a shrinking window at tile
edges), the car's own surface (`physics/rapier/terrain.ts`: a second field over all ground, Gaussian-smoothed again,
held within 0.2 m of the first, 0.5 m on decks), and the roofs' planes (`roofs.ts`: regions, fits, seams between
tiles). The drawn road was too rough to drive on, so the car drove on something else: wheels 10-20 cm off the road on
ramps, up to 50 cm under a bridge deck. Every reader that stands on the ground had to repeat the inference, and each
tile only saw one column of its neighbour. Voxels of 0.2 m were considered and rejected (data and meshing cost).

## Decision

- **A cap** replaces the top face of one run of one column by a quad with four corner heights in 1/64 m. Node section
  `caps` (registry: after `brik`): planar uint16, per record the column (delta), the run's top `ztop` (delta, zigzag)
  and the four corners less `ztop * 64` (zigzag). At most two per column: on the run ending at the ground, and on
  the column's last run (a deck, a roof). A column without a record is a plain voxel column.
- **The pipeline writes them** from the exact sources, on the map's grid, so neighbouring nodes hold the same numbers
  for the columns they share: the terrain model under paved and unpaved ways, the bridges' deck profiles, (phase B)
  the roofs' planes. Smoothing for driving happens here, once (an edge-stopping diffusion that never crosses a wall,
  water or a deck's edge; ground the pipeline moved in whole metres is relaxed between the terrain around it), and
  what is smoothed is what is drawn. The rules are in `scripts/caps.py`, run by `tile_fields.py`: changing them is a
  rerun of that step, not of the regions.
- **The client reads them** through `core/surface.ts` (`capField`, `cornerQ`, `surfaceAt`), three.js-free: the mesher
  draws the quad and the risers between neighbours' corners; `world.ts`, the car's Rapier terrain and the drone's
  surface query take the same heights. There is no second surface for the car.
- **Edits.** A cap is live while its run still ends at `ztop`, the cell above is air and the column is solid down to
  the cap's lowest corner; else the column is voxels. `effectiveColumns` is unchanged and the L0 `caps` ride beside
  the columns; dropping L2 restores them by itself. Player-made slopes (an L1 op that writes a cap) and bricks are
  reserved, not built.
- **Distance levels** (2, 4, 8 m): no ground caps (as before); roof caps from the level-1 corners at the blocks'
  corners (phase B).
- **Not capped:** lawns, fields, stairs, water, anything with a voxel standing on it. They are voxels for every
  reader, the car included.

## Consequences

- Wheel contact and drawn road agree to the quantisation (gate: `tools/contact.mjs`, p99 <= 2 cm on flat, ramps and
  decks; ride quality within 10 % of the old private surface).
- Removed: `ramps.ts`, the car's field and Gaussian in `terrain.ts`, (phase B) `slopeBase`, `tidyPlanes`,
  `tileSeams`, `fit`, the roofs' tile-edge skirts and the roof memo of sectioned re-meshing. Kept: `chamfer.ts`
  (walls at an angle in plan), the roofs' emitters, `plns` (lighting), the car's step wedges (real steps).
- A build without `data/surface.npz` writes no caps; such data cannot be shown by a client after the legacy path was
  removed (format note for `meta.json world.formatVersion`: bump it with the rebuild).
- +~5-10 MB of level-1 node data on this map (measured ~2.0-2.5 bytes per capped column).
- The cap's height is limited to +-0.875 m of its voxel top (ground) so the voxel below stays a floor for physics;
  roofs +-7 m, drawn only -- roofs collide as voxels.
```

(If `formatVersion` is bumped in R: `scripts/world_id.py` and wherever the viewer compares it — check before doing
it; if anything persistent keys on it, leave it and drop that sentence from the ADR.)

---

## 9. Order at a glance

`A1` baseline tool → `A2` accessor refactor (no change) → `P1` registry/decode → `P2` voxelize exports → `P3` caps
writer (ground, decks, roofs) → `A3` mesher → `A4` world → `A5` car → `A6` drone → **`R` one full rebuild (ask
first)** → `A7` acceptance on the map → `A8` delete legacy + ADR → (`B1`–`B5` roofs, optional).
Every step before `R` leaves the shipped data on the unchanged legacy path; every step is one mergeable commit.
