# 0003 Re-mesh cost of an edit

Status: accepted -- steps 1, 3 and 2 (sections) done, see the end. Measured with `web/tools/mesh-profile.mjs` (20 Altstadt nodes round 63_21, node 22, warm JIT; the
phase split with timers in a throw-away copy of `mesher.worker.ts`, the mesher itself unchanged).

## Context

An edit (`dig.ts`, `stream.ts replaceColumns`) re-meshes every touched 1 m node whole. `tools/remesh-bench.mjs` gave
~65 ms mean / ~115 ms max per node for meshing, against an estimate of ~10 ms. The estimate assumed a thin surface;
the Altstadt's nodes are tall: zmax mean 50, max 94 cells, so `meshTile`'s dense volume is 130 x 130 x ~52 cells
(up to 3.2 MB) and the greedy passes scan it six times. Warm, one node meshes in **~41 ms mean / 80-90 ms max**
(~11 600 quads). And an edit pays more than that: the foliage job meshes the foliage tile (~29 ms) **and the base tile
again** for its cover (~45 ms), so a touched node with foliage costs **~115 ms**, a crater over a node corner ~4x that.

## Where the time goes (ms per node, mean)

| phase | ms | share |
|---|---:|---:|
| dense fill (offsets, zmax, alloc, fill) | 0.7 | 2 % |
| rampField, colTop/topX/topY, roofPlanes, chamferWalls + slopeRoofs, wallTop | 3.9 | 9 % |
| greedy pass x: scan + face keys (AO, wallAngle, ramps) / emitMerged | 8.5 / 5.3 | 33 % |
| greedy pass y: scan + face keys / emitMerged | 7.6 / 4.6 | 29 % |
| greedy pass z: scan + face keys / emitMerged | 5.4 / 2.8 | 20 % |
| emitRamps + emitFeet | 0.9 | 2 % |
| byFacing (buffer packing) | 2.0 | 5 % |

The sampling profile agrees: `meshFaces` self 19 ms (the scan, `faceAO` inlined), `emitMerged` 12 ms, `wallAngle`
3 ms, garbage ~1 ms. The dense fill is not the problem; the cost is proportional to the volume scanned (x and y passes
walk every cell up to the row's tallest column) and to the faces found. `emitMerged` scans the whole nu x nv mask of
every non-empty slice and allocates arrays per quad.

What-ifs, the same `meshJob` on cut-down columns (`mesh-profile.mjs`):

| meshed | ms mean / max |
|---|---:|
| whole node (128 x 128) | 41 / 80 |
| whole node, dense z band ground ± 8 m only | 18 / 28 |
| sub-node 64 x 64 | 8.1 / 17 |
| sub-node 48 x 48 (a 32 section + 8 cells of context) | 4.0 / 9.6 |
| sub-node 32 x 32 | 1.8 / 4.3 |
| sub-node 16 x 16 | 0.5 / 1.6 |
| sub-node 32 x 32, z band 16 cells | 1.1 / 2.2 |

## Proposal

1. **Don't mesh the base twice per edit** (`stream.ts`, no mesher change). With a foliage tile, the base job's plain
   mesh is replaced by the foliage job's cover as soon as both are in. On an edit, skip the plain base job (keep the
   old mesh until the cover arrives; mesh the plain one lazily only if the foliage tile is freed first). Expected:
   ~115 → ~75 ms per node with foliage (−35 %), trivially safe.
2. **Re-mesh only dirty sections.** Mesh an edited node as 4 x 4 sections of 32 x 32 columns (own geometries, own
   face groups/cuts) and re-mesh only the sections an edit touches. The section must be meshed with context beyond
   its apron (ramps' smoothing, `wallAngle` ±2 cells, chamfer legs, roof planes 3 x 3 and slopes per building), so
   the mesher needs an "emit window" inside a larger read window (e.g. section + 8 cells); a 32-section read with
   8 cells of context costs about the 48 x 48 case, ~4 ms mean / ~10 ms max; a crater of r 4 m touches 1-4 sections.
   Expected: ~41 → ~4 ms per touched section, ~4-16 ms per touched node for the base (3-10x), likewise for foliage and cover. Costs: up to 16 draws per
   edited node instead of 1 (only while edited), seams where greedy quads used to cross a section border (none
   visible: same positions), and the mesher change (another agent owns it now).
3. **Make the whole-node mesher cheaper** (helps streaming as well): `emitMerged` skipping empty mask rows (per-row
   min/max of set cells), no per-quad array allocation, an interned key (Int32 index into a table of
   ang/pal/ao/gm) instead of the Float64 mask; the x/y scan bounded per column by its own top rather than the row's
   tallest (`topX`/`topY`), or face finding from the runs (only run ends and neighbour-run differences can carry a
   face). Expected: ~41 → ~20-25 ms (estimate, not measured).

**Limiting the dense array to the edit's z range ± margin** is not proposed on its own: it halves the time (41 → 18
ms) but the node's mesh is one buffer; the quads above and below the band would have to be kept from the old mesh and
cut where greedy quads (walls) cross the band's ends, and `colTop`, `wallTop`, roof planes and chamfers need the full
column. It only pays inside 3-D sections (32³ bricks), which multiply draws further. Order: 1 now, 2 with the next
mesher change, 3 when streaming cost matters.

## Done (1 and 3), and what is left

Measured as above (`mesh-profile.mjs`; the machine shared, so means within ~10 %):

| | before | after |
|---|---:|---:|
| whole node (base job) | 46 / 121 | 22-24 / 49-65 |
| foliage job (foliage tile + the base's cover) | 79 / 225 | 32 / 66-82 |
| **an edited node with foliage** | **125 / 311** (base + foliage job) | **32 / 66-82** (foliage job only) |

1. `stream.ts replaceColumns`: where the foliage's cover is the base's mesh, the plain base job is skipped (`stale`);
   the old mesh shows until the new cover replaces it, the base is meshed plain only if the foliage job fails or the
   foliage tile is freed first. −37 % per edited node alone.
3. The mesher's scan visits only cells that can carry a face: per column from just over its neighbour's solid bottom
   (`colBot`) to its own top (`colTop`), both from the runs (`columnSpans`); z faces bucketed by slice. The mask is two
   Uint32 keys, written only at faces; `emitMerged` walks each row's span and allocates nothing per quad. The output is
   byte-identical (`tools/mesh-golden.mjs`, 106 meshes at levels 1, 1f + cover, 2, 4, 8). meshFaces' own time fell
   ~4x; what is left is mostly roofs and chamfers (`slopeRoofs`, `chamferWalls`, `emitEdge`, ~10 ms) and `wallAngle`.

## Proposal: dirty 32 x 32 sections (as proposed; done otherwise, below)

An edited Altstadt node still costs ~32 ms mean, 65-80 ms max, over the ~30 ms aimed at (a crater over a node corner:
4 of them). The rest scales with the area meshed (sub-node 32 x 32 now 1.5 / 3.6 ms, 48 x 48 3.1 / 7.4 ms), so:

- An edited node (only once edited; streaming keeps one mesh per node) is meshed as 4 x 4 sections of 32 x 32 columns,
  each its own geometry (face groups, cuts, box) under the node; an edit re-meshes the sections its box (plus the
  context below) touches, the base's cover and the foliage likewise per section.
- Each section is meshed from a read window of section + 8 cells (`meshTile` with an emit window: faces, ramps,
  prisms and slopes emitted only for columns inside it). 8 cells cover what reads beyond a column: `wallAngle` ±2,
  `faceAO` ±1, ramps' smoothing, chamfer legs (≤ 4?), roof planes 3 x 3; but `slopeRoofs` fits planes per building,
  so a building crossing the window must be read whole (window grown to the buildings' boxes, or roof planes taken
  from the whole-node pass and kept per node). That is the part to verify first, with mesh-golden extended to compare
  the union of 16 sections against the whole node (same quads up to the greedy merges cut at section borders).
- Expected: ~3-8 ms per touched section, a crater r 4 m touching 1-4 sections: ~5-15 ms per node instead of ~32.
  Costs: up to 16 draws per edited node (only edited ones), quads split at section borders (same surface), and the
  mesher's emit window.

## Done (2): an edited node in sections

`web/src/sections.ts`, `mesher.worker.ts meshSections`, `stream.ts` (applySections, pend), checked by
`web/tools/section-check.mjs`, timed by `web/tools/remesh-bench.mjs` (its last line).

- An unedited node keeps its one mesh, byte for byte (mesh-golden). An edited 1 m node -- its own mesh where it has no
  foliage tile, else its foliage tile's and the base's cover (the foliage job) -- is meshed as 8 x 8 sections of
  **16 x 16** columns (32 x 32 meshed ~2x the area per crater: a crater and its reach of 6 columns, 19 wide, meets
  2 x 2 sections of 16 but often 2 x 2 of 32 too), each its own geometry, a child of the node's mesh (whose own
  geometry then draws nothing and carries the box: city.ts, main.ts unchanged). The first edit meshes all of them (a
  whole node's cost), each later one those it can have changed.
- Every analysis runs in the node's own coordinates over a box round the sections meshed, emitting only their columns'
  faces, ramps, prisms and slopes, greedy merges cut at section edges; so the sections are the whole node's mesh.
  section-check splits merged quads into unit cells and compares the multisets: 20 Altstadt nodes, all sections before,
  then 4 carves one after the other (middle, a section corner, a roof, the node's edge; foliage and cover too) -- equal.
  Two things differ only by the cut: a node-border face's sunk top edge, and a merged roof top's ground (vattr.z, the
  cell it starts at).
- What reaches far: a staircase's chamfers (chamfer.ts: a step's prism depends on the whole staircase) and a roof's
  slopes (roofs.ts: planes fitted per region, eave steps next to each other). Slopes: the regions and corners are made
  from the whole node's column tops (`slopeBase`, cheap, no volume). Staircases: the worker keeps a memo per edited
  node (its columns, all its steps, the regions; stream.ts sends a node's edits to one worker, `from`/`id` name the
  state): an edit looks for steps again only within 8 of what changed, and meshes again only the sections whose
  prisms changed (found, lost, another light) or lie within 10 of it; a changed roof only round the cells whose slope
  changed. Without the memo (another worker, an error) it still comes out right: boxes grown until each staircase
  that matters lies inside, more sections where the edit can reach (slower: ~30 ms).
- Measured (remesh-bench, a 3 m sphere at the middle on the ground, 20 Altstadt nodes with foliage, machine loaded:
  load ~7, the whole node's mesh 38 ms there against ~23 idle): the foliage job **~19 ms mean** (10-11 sections), down
  from the whole node's ~55; section-check over all its carves (roofs included): foliage job 13-21 ms, whole 44-62.
  Not the ~8 ms aimed at, on this machine as loaded; scaled to an idle one ~10-12 ms. Left: the fixed cost per job
  (the volume allocated for the node's height, two meshings per foliage job), the middle of a node being 4 sections'
  corner, chamfers' whole-node assembly (`stepLight` only where steps changed).
- Costs: up to 64 draws per edited node (only edited ones; empty sections have no mesh), ~1 MB of memo per edited node
  in its worker (8 kept).
