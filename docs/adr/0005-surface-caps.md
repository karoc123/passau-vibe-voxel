# 0005 Sloped surfaces are data: the `caps` section

Status: accepted (phase A: ground and bridge decks; phase B, roofs, not built: `caps.ROOFS = False`). Code:
`scripts/caps.py` (writer, run by `scripts/tile_fields.py`), `web/src/core/surface.ts` (reader); checks:
`web/tools/caps-check.mjs`, `web/tools/surface-gap.mjs` (baseline `docs/plans/surface-gap-baseline.json`),
`web/tools/tile-roundtrip.mjs`, `scripts/check.py verify`. Plan: `docs/plans/surface-caps.md`.

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
  draws the quad and the risers between neighbours' corners; `world.ts`, the car's Rapier terrain (one trimesh per
  chunk for every body, the run's top voxel left out of the shell) and the drone's surface query take the same
  heights. There is no second surface for the car, and no inference from the voxels: the legacy path
  (`core/caps-legacy.ts`, the car's `DRIVE` field) and its switch (`?caps=0`, `CAPS=0`) were deleted once the data had
  caps (plan step A8).
- **Edits.** A cap is live while its run still ends at `ztop`, the cell above is air and the column is solid down to
  the cap's lowest corner; else the column is voxels. `effectiveColumns` is unchanged and the L0 `caps` ride beside
  the columns; dropping L2 restores them by itself. Player-made slopes (an L1 op that writes a cap) and bricks are
  reserved, not built.
- **Distance levels** (2, 4, 8 m): no caps; their voxels as before.
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
  Kept: `chamfer.ts` (walls at an angle in plan), the roofs' inference and emitters (phase B would replace the
  inference), `plns` (lighting), the car's step wedges (real steps, `G_CAR_ONLY`), `SEM.PAVED` (the paved ids, checked
  against `caps.py` by `tile-roundtrip.mjs`).
- Data without the section (a build without `data/surface.npz`, or before it) still loads: `caps` is an optional
  section and `meta.json` `world.formatVersion` was not bumped. Its streets are then drawn and driven as voxel stairs.
- The cap's height is limited to +-56/64 m of its voxel top (`caps.CLAMP`) so the voxel below stays a floor for
  physics. Roofs, if phase B is done, would be drawn only -- roofs collide as voxels.
