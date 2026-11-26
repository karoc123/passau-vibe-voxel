# 0005 Sloped surfaces are data: the `caps` section

Status: accepted (phase A: ground and bridge decks; phase B: roofs, section `roof`, drawn only). Code:
`scripts/caps.py` (writer, run by `scripts/tile_fields.py`), `web/src/core/surface.ts` (reader; roofs:
`web/src/roofs.ts` `roofField`, `slopeBase`); checks:
`web/tools/caps-check.mjs`, `web/tools/surface-gap.mjs` (baseline `docs/plans/surface-gap-baseline.json`),
`web/tools/tile-roundtrip.mjs`, `scripts/check.py verify`.

## Context

The world is 1 m voxels; a street on a slope is a staircase. The viewer smoothed it three times over, each on its own:
the mesher's ramps (`ramps.ts`, later `core/caps-legacy.ts` `rampField`: a 3 m mean of the paved columns' tops, per
tile, with a shrinking window at tile edges), the car's own surface (`physics/rapier/terrain.ts` `DRIVE`: a second
field over all ground, Gaussian-smoothed again, held within 0.2 m of the first, 0.5 m on decks), and the roofs' planes
(`roofs.ts`: regions, fits, seams between tiles). The drawn road was too rough to drive on, so the car drove on
something else: wheels 10-20 cm off the road on ramps, up to 50 cm under a bridge deck. Every reader that stands on
the ground had to repeat the inference, and each tile only saw one column of its neighbour. Voxels of 0.2 m were
considered and rejected (data and meshing cost).

## Decision

- **A cap** replaces the top face of one run of one column by a quad with four corner heights in 1/64 m. Node section
  `caps` (registry: after `brik`): planar uint16, per record the column (delta), the run's top `ztop` (delta, zigzag)
  and the four corners less `ztop * 64` (zigzag). At most two per column: on the run ending at the ground, and on
  the column's last run (a bridge's deck). A column without a record is a plain voxel column; a node with none has no
  section.
- **The pipeline writes them** from the exact sources, on the map's grid, so neighbouring nodes hold the same numbers
  for the columns they share: the terrain model under paved ground and carriageways, the bridges' deck profiles.
  Smoothing for driving happens here, once (a diffusion over a graph of linked columns that never crosses a wall,
  water or a deck's edge; ground the pipeline moved in whole metres is relaxed between the terrain around it), and
  what is smoothed is what is drawn. The rules are in `scripts/caps.py`, run by `tile_fields.py`: changing them is a
  rerun of that step, not of the regions.
- **The client reads them** through `core/surface.ts` (`capField`, `cornerQ`, `surfaceAt`), three.js-free: the mesher
  draws the quad and the risers between neighbours' corners; `core/world.ts`, the car's Rapier terrain (one trimesh per
  chunk for every body, the run's top voxel left out of the shell) and the drone's surface query take the same
  heights. There is no second surface for the car, and no inference from the voxels: the legacy path
  (`core/caps-legacy.ts`, the car's `DRIVE` field) and its switch (`?caps=0`, `CAPS=0`) were deleted once the data had
  caps (plan step A8).
- **Edits.** A cap is live while its run still ends at `ztop`, the cell above is air and the column is solid down to
  the cap's lowest corner; else the column is voxels. `effectiveColumns` is unchanged and the L0 `caps` ride beside
  the columns; dropping L2 restores them by itself. Player-made slopes (an L1 op that writes a cap) and bricks are
  reserved, not built.
- **Distance levels** (2, 4, 8 m): no ground caps; their voxels as before. Roof caps, see below.
- **Roofs (phase B)** are caps in a section of their own, `roof` (after `caps`; levels 1, 2, 4, 8): per column at most
  one record, on its last run, corners within +-448/64 of its top, written as differences (corner 0 from the west
  neighbour's corner 1 where that record is the column just before, else from the top; 1 from 0, 2 from 1, 3 from 0:
  a third smaller gzipped than the caps' layout). The writer (`caps.roof_section`) takes each roof cell's own plane
  (`surface.npz` `roof_z/gx/gy`, the planes voxelize.py rounded the roof from), meets them per grid point (ridge and
  hip: the lowest; valley: the highest; else the mean). Planes meet within 2 m on one building and within 1 m across
  buildings. At a ridge with opposing slopes on one building, the lower plane extends up to a 3 m gap. A corner
  moved more than its span keeps its own plane except when that plane rises above the lowest at a ridge or hip.
  The writer works on the map's grid from the rasters and the level-1 nodes' tops over the window and 16 m round it,
  so nodes agree on the columns they share. Levels 2, 4, 8 take the
  level-1 corners at their blocks' corners. Level cells next to a slope get a (flat) record too, so slope and level
  tops are one surface for the mesher's merges. A separate section rather than slot 1 of `caps`: every ground reader
  (car, walkers, drone) stays roof-free by construction, and the caps keep their +-CLAMP rule. Liveness: the record's run
  is still the column's last. The client draws them (`roofs.ts`; the plane codes, `plns`, still light them) and infers
  nothing: the roof regions' fits, `tidyPlanes`, `tileSeams`, the sectioned meshing's roof memo and `ROOF_REACH` are
  gone; a roof's slope depends only on its column and those round it, so an edit re-meshes the sections within
  `INFLUENCE`. Merged tops: cells of one plane code whose corners lie in one plane to 1/64 m (the corners are planes
  rounded each, never exactly linear), at level 1 within their 16-column section also when the node is meshed whole
  (so whole and sectioned meshes are the same), drawn through every corner of what lies beside them.
  **Roofs are drawn only, not collided as slopes**: the voxels stay the roofs for physics (nothing drives on a roof; a
  walker or the drone on one is rare and the voxel within a metre of the slope), and the separate section keeps it so.
- **Not capped:** lawns, fields, unpaved tracks and yards, stairs, water, anything with a voxel standing on it. They
  are voxels for every reader, the car included (its step wedges, `car.ts`, still help it up real steps).

## Consequences

- What the wheels touch is what is drawn: on the real map (`surface-gap.mjs`, baseline at 661e7ae6) the wheels' rays
  over the capped columns of four areas (slopes, the Schanzlbrücke's deck) hit the drawn surface 0.0 cm off, the
  wheels' contacts on nine roads at 0-70 km/h at most 0.1 cm (mean of the absolute) off; the drawn wheel's bottom
  sits within a few cm of it (the old private surface: ramps' mean 8-13 cm off, decks down to -50 cm). The user's
  verdict on driving: much better.
- Build 661e7ae6: 1588 level-1 nodes with caps, 4.67 M ground and 63 k deck columns capped, carriageway share 99.6 %,
  roughness p99 7.8 cm. The section is ~57 MB raw, ~10.6 MB gzipped (about 2.2 bytes per record). Level-1 triangles
  of the capped nodes +27 % against the same nodes drawn as voxels (`caps-check.mjs --all`).
- Removed: `ramps.ts`/`core/caps-legacy.ts`, the car's field and Gaussian in `terrain.ts` (`DRIVE`, the car-only
  trimesh, the top voxels only the other bodies met, `NOT_CAR_GROUPS`), `caps-mode.ts`, the `PAL_GROUND` palette bit.
  Kept: `chamfer.ts` (walls at an angle in plan), the roofs' emitters (`roofs.ts` `emitTops`, `emitEdge`, the eaves'
  filled steps, the node-border skirt), `plns` (lighting), the car's step wedges (real steps, `G_CAR_ONLY`), `SEM.PAVED` (the paved ids, checked
  against voxelize.py's ground classes by `tile-roundtrip.mjs`). `caps.py` reads which cells are paved, steps or a
  bare deck from `data/ground.npz` `cls`, the class raster `voxelize.py` writes, not from colours.
- Data without the section (a build without `data/surface.npz`, or before it) still loads: `caps` is an optional
  section and `meta.json` `world.formatVersion` was not bumped. Its streets are then drawn and driven as voxel stairs.
- The cap's height is limited to +-60/64 m of its voxel top (`caps.CLAMP`; 56/64 until the carriageways were linked over
  the terrain model's walls, docs/plans/road-clearance.md) so the voxel below stays a floor for physics. Roofs are
  drawn only -- they collide as voxels.
- Phase B (branch `roofs`, measured on a scratch copy of the committed map data with this `tile_fields`; nothing of the
  map rebuilt but that step): 1.60 M level-1 roof columns with a sloped record (+79 k level ones beside slopes),
  level 2/4/8 records 0.41 M / 77 k / 9 k (aprons included); `roof` sections +5.6 MB gzipped over the levels (L1
  +3.9, L2 +1.3, L4 +0.33, L8 +0.05; 27 MB raw). Triangles against the inferred roofs: L1 +0.8 %, L2 +1.5 %, L4 +1.5 %, L8 +0.3 % (Altstadt
  fixture, the densest roofs: +0.3 / +3.8 / +3.4 / +4.0 %). T-junctions on roof-lit edges in the four Altstadt nodes of
  164ca18d: 106 -> 71. Removed: `slopeBase`'s regions and fits, `tidyPlanes`, `tileSeams`, `fit`, `sections.ts`
  `roofsChanged` and the edit jobs' `bids`, `mesher.worker.ts` `SectionMemo.slopes`, `slopeChange`, `ROOF_REACH`.
  Data without the section draws its roofs as voxel staircases (rerun `tile_fields.py` to get them).
