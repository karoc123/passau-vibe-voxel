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
  in place; a new pipeline run is a new build id. Edits live outside it.
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
- **Distance levels (2, 4, 8 m) never show L2.** They show L0; L1 there needs a downsampled L1 from the server
  (not built; `effectiveColumns` refuses persistent edits on them for now).
- **Core without three.js or the DOM.** `web/src/core/` imports only `tile-data.ts`, so the viewer, the node tools and
  a Node server share one implementation.

## Reserved

- **Bricks:** sub-metre detail as a sparse k x k x k refinement (k = 4 or 8) of individual 1 m cells, keyed by the cell's
  address (0002). The 1 m world, the distance levels and the data volume stay as they are; a refined cell has a coarse
  palette id for everything that does not read bricks. Not implemented; no op kind or id is taken for it yet.
- Rebasing L1 onto a new build: ops are absolute (0002), so they replay over any build; conflicts with what the new
  build changed (a building edited by a player and rebuilt by the pipeline) need a policy.
