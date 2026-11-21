# 0004 Node file sections: one registry, unknown tags kept

Status: accepted. Code: `scripts/tilefile.py` (`SECTIONS`, `write`), `web/src/core/tile-sections.ts`
(`TILE_SECTIONS`), `web/src/tile-data.ts` (`decodeTile` `extra`); check: `web/tools/tile-roundtrip.mjs` (runs
`scripts/tile_roundtrip.py`).

## Context

A node file (`VXT2`) is a table of 4-byte tags and their sections. The tags were listed three times: in
`tilefile.py`'s docstring, its `ORDER` and in comments in `tile-data.ts`. `tilefile.write` put the sections in `ORDER`
and silently dropped any other tag. That matters because steps read, modify and write the nodes in place
(`tile_fields.py`, which also rewrites `1f`): a new section added by one step would disappear when another step that
does not know about it rewrote the node. `decodeTile` ignored unknown tags too, so no core consumer could see them.

## Decision

- **One registry**, `tilefile.SECTIONS`: tag, levels, layout, owning step, and `reserved` for each section, in write
  order. It is append-only: new tags go last and a tag is never reused. `web/src/core/tile-sections.ts` mirrors it
  (three.js-free, under `core/`). The round trip checks that both list the same tags in the same order with the same
  `reserved` flags.
- **Today's tags**: `cnts grnd runs` (all levels, incl. `1f`), `plns bldg flod fols spil` (levels 1, 2, 4, 8), `room`
  (level 1, nodes with rooms; `interiors.py`), `caps` (level 1, nodes with sloped ground; after `brik`; `caps.py` via
  `tile_fields.py`: docs/adr/0005-surface-caps.md).
- **`brik` reserved**: for future sub-metre bricks, a sparse k³ refinement of 1 m cells in which the 1 m voxel stays
  the cell's representative (0001). Only the name and its place in the order are taken. Nothing writes or reads it yet.
- **Unknown tags are kept**: `write` emits the registry's tags in order, then any other tag sorted by name. The output
  is deterministic, and for a node that holds only registry tags it is unchanged byte for byte.
- **`decodeTile` returns `extra: Map<tag, Uint8Array>`** with every section it does not decode (an unknown tag or a
  reserved one), raw and unpadded, as views on the file's buffer.

## Consequences

- A step can add a section before the registry lists it without other steps losing it. It should still be registered
  before it ships, so its order is fixed and documented.
- Checked: all 4633 nodes of the current build (levels 1, 1f, 2, 4, 8) re-encode through `read` → `write` to the same
  bytes. The round trip writes a node with two unknown tags (one of odd length, one empty) and `brik`, which are kept,
  reread and rewritten byte for byte, and decoded into `extra`.
- gzip's header stores the file name, so a byte comparison has to rewrite a node under the same name.
