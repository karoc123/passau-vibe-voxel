# 0002 Addressing edits

Status: accepted. Code: `web/src/core/layers.ts`; check: `web/tools/layers.mjs` (two builds with shifted origin and
base show the same absolute world).

## Context

The node files are in map cells (the project grid less `meta.json` `origin`, the map's corner) and in cells over the
volume's floor (`meta.json` `base`, m a.s.l.). Both change when the map grows or a lower terrain lowers the floor;
node keys (`s/tx_ty`) shift with the origin. An edit stored in those terms would move or vanish with the next build.

## Decision

- **Project grid + absolute height.** A `WorldOp` is addressed by the project grid's column and row (`scripts/map.json`:
  column = easting − grid.x0, row = grid.y0 − northing; fixed for the project, as the hashes and curated places are)
  and the cell bottom's height in whole metres a.s.l. Conversions: `gridToMap`/`mapToGrid` (± origin),
  `absToCellZ`/`cellToAbsZ` (± base), with the frame from `frameOf(meta)`.
- **Node addresses are routing only.** A `NodeDelta` names its build id and the node (s, tx, ty) in that build's grid,
  so a server can hand a client a node's ops in one piece; the ops in it stay absolute and apply over any build
  (`routeOps` regroups them for another build).
- **Colours are palette ids, append-only.** `meta.json` `palette` entries are never removed or reordered by a new
  build, only appended, so a palette id in an op means the same colour and material in every build. 0 is air.
- **Wire form.** Varints, ops' positions as zigzag differences from the op before (`encodeOps`, `encodeDelta`): about
  6 bytes per op in random scatter, less for brush strokes.

## Consequences

- Whatever a build cannot hold (under its floor, outside its map) is clipped for that build only; the op itself stays.
- The pipeline must keep the palette append-only across builds (not enforced yet; `scripts/` builds it per run).
- Reserved for bricks (0001): a brick's address will be the 1 m cell's (col, row, z) plus a sub-cell index within
  k³, so the address space above stays as it is.
