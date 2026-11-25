# 0001 World layers

Status: accepted (foundation; no server yet). Code: `web/src/core/columns.ts`, `web/src/core/layers.ts`; checks:
`web/tools/edit-roundtrip.mjs`, `web/tools/layers.mjs`.

## Context

The model is to become a server-hosted world that players change: they build (kept) and destroy (not kept). The
pipeline's node files (`scripts/tilefile.py`: per column a run count, runs of (z, length, palette id), the ground, with a
one-cell margin round each 128 m node) are rebuilt from the sources now and then, and must stay reproducible.

## Decision

Three layers, composed per level-1 node when it is loaded:

- **L0, the base build.** The node files of one pipeline build, named by a build id. Immutable: a build is never edited
  in place; a new pipeline run is a new build id. Edits live outside it. The id is `meta.json` `world.buildId`
  (`scripts/world_id.py`, run every build after the tiles are final): a hash over the contents of `tiles/1` and `tiles/1f`,
  so the same tiles give the same id anywhere and any changed tile a new one. `world` also carries `formatVersion` (node
  files and addresses), `paletteLen`/`paletteHash`, `origin`, `base`, the project grid's `grid` x0/y0 and `voxel` (1 m):
  what a server and a client compare before replaying ops.
- **L1, persistent edits.** Players' building and lasting changes, stored by the server as ordered ops and replayed over
  L0 on every load.
- **L2, transient edits.** Destruction. Applied over L0 + L1 while the node is loaded; when the node is loaded again
  it is gone (L2 is dropped, L0 + L1 shown). Whether all players share one L2 is open (FRAGEN.md 8).

`effectiveColumns(frame, base, persistent, transient)` = L0, then each L1 delta's ops, then each L2 delta's, in order;
it never writes its inputs, so dropping L2 gives exactly L0 + L1. The result is in the node file's canonical form (the
runs `scripts/tiles.py column_runs` writes: maximal runs of one id, no air, no empty runs), so an edited node can be
meshed, collided and written like a pipeline node, and an unedited node re-encodes byte-identically.

- **Ops, not snapshots.** A node delta is the ordered list of ops that touch the node, its margin included: an op on
  a node's edge is stored in each neighbour's delta too, so every node is built from its own deltas alone and shared
  margin columns agree (`touchedNodes`). Snapshots (encoded columns) are a cache, rebuildable from L0 + ops.
- **Ground.** The files' ground (the first free cell over the terrain) cannot be derived from the runs, since buildings
  stand in one stack with it. Edits lower it where they dig below it and never raise it (`recomputeGround`, capped by
  L0's ground). Water counts as in the files (its top is the ground; `physics/rapier/terrain.ts` lowers the solid
  ground to the water's bottom).
- **Edits are the world's.** `core/world-edits.ts` `apply(op)` is the one way to edit: it reads each node an op
  (a `WorldOp`) touches through the world's `core/tile-cache.ts` (one fetch and decode per node, shared by the drone's
  collision and the car's terrain, seen through the live edits), applies it to the base and, where it carves, the
  foliage, and puts the result into `core/live-edits.ts` (`LiveNode`: the columns and the node's ops in order). The
  physics read node files through the cache; the viewer's streamer listens and re-meshes a loaded 1 m node and its
  foliage tile in place (`stream.ts` `onLive`, `replaceColumns`; `mesher.worker.ts` MeshRequest `cols`: the same
  meshes as from the file, `tools/remesh-bench.mjs`), and a node loaded later is meshed from the edit's columns. The
  renderer freeing a node keeps its edit: the world sim keeps an edited node while a player's focus is within
  `Tuning.edits.radius` of it and drops it (L2: its files again) once none has been for `Tuning.edits.after` s of world
  time, nodes sharing an op together (`sim/edit-keeper.ts`, ADR 0008). `?dig=1` (`dig.ts`) carves spheres by click to
  try it.
- **Distance levels (2, 4, 8 m) never show L2.** They show L0; L1 there needs a downsampled L1 from the server
  (not built; `effectiveColumns` refuses persistent edits on them for now).
- **Core without three.js or the DOM.** `web/src/core/` imports nothing outside itself (the node decoder is `core/tile-data.ts`), so the viewer, the node tools and
  a Node server share one implementation. `web/tools/core-deps.mjs` checks it (no three.js, `util.ts`, `voxelMaterial.ts`
  or DOM global, transitively). The material ids are `core/materials.ts`; what a palette entry is to the physics,
  collision and walkers is `core/semantics.ts` (one flag table, each reader's rule named: `solidForCar`, ...).

## Reserved

- **Bricks:** sub-metre detail as a sparse k x k x k refinement (k = 4 or 8) of individual 1 m cells, keyed by the cell's
  address (0002). The 1 m world, the distance levels and the data volume stay as they are; a refined cell has a coarse
  palette id for everything that does not read bricks. Not implemented; no op kind or id is taken for it yet.
- Rebasing L1 onto a new build: ops are absolute (0002), so they replay over any build; conflicts with what the new
  build changed (a building edited by a player and rebuilt by the pipeline) need a policy.
