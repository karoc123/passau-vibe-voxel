// The node file's sections (scripts/tilefile.py SECTIONS, mirrored here; tools/tile-roundtrip.mjs checks the two agree;
// docs/adr/0004-tile-sections.md), in the order the writer puts them in. Append only: a new tag goes last, a tag is
// never reused. A tag the writer does not know it keeps after these, sorted; decodeTile (tile-data.ts) hands every
// section it does not interpret -- an unknown tag, a reserved or a retired one -- over raw as `extra`.
// S = N + 2: the node and its one-cell apron.
export interface TileSection {
  tag: string; // 4 ASCII bytes
  levels: string; // the levels whose nodes have it
  layout: string;
  owner: string; // the step that writes it
  reserved?: true; // named, not written or read: yet (brik) or any more (flod)
}

export const TILE_SECTIONS: readonly TileSection[] = [
  { tag: 'cnts', levels: '1 2 4 8 1f', layout: 'uint16[S^2]: runs per column (row-major, row = south)', owner: 'tiles.py' },
  { tag: 'grnd', levels: '1 2 4 8 1f', layout: 'uint8[S^2]: ground level in metres', owner: 'tiles.py' },
  { tag: 'runs', levels: '1 2 4 8 1f', layout: 'uint16[3 * runs]: (z0, len, palette) per run, bottom up per column', owner: 'tiles.py' },
  { tag: 'plns', levels: '1 2 4 8', layout: "uint16[S^2]: the roof plane of each column's top face", owner: 'tiles.py, tiles_lod.py' },
  { tag: 'bldg', levels: '1 2 4 8', layout: 'uint16[S^2]: the building of each cell (zones.py ids, 0: none)', owner: 'tile_fields.py' },
  { tag: 'flod', levels: 'none (retired)', layout: 'RETIRED, no longer written or read: uint8[2][N^2], river level reaching each cell, schematic bed (rivr took its place)', owner: 'none (was tile_fields.py)', reserved: true },
  { tag: 'fols', levels: '1 2 4 8', layout: 'uint8[2][N^2], no apron, planar: foliage class and tree', owner: 'tile_fields.py (phenology.py)' },
  { tag: 'spil', levels: '1 2 4 8', layout: 'uint8[2][(N/2+2)^2], 2 m cells, apron included, planar: window light on the street, two kinds', owner: 'tile_fields.py spill_map' },
  { tag: 'room', levels: '1 (nodes with rooms)', layout: 'uint16[4 * spans]: (column, z0, len, fill), sorted by column, then z0 (roomOffsets)', owner: 'interiors.py (tiles.room_section)' },
  { tag: 'brik', levels: '1 (reserved)', layout: 'RESERVED: sub-metre bricks, a sparse k^3 refinement of some 1 m cells (docs/adr/0001-world-layers.md)', owner: 'future (bricks)', reserved: true },
  { tag: 'caps', levels: '1 (nodes with sloped ground)', layout: 'uint16[6 * n], planar: per record the column less the previous one\'s, zigzag(ztop less the previous one\'s), zigzag(each of 4 corners less ztop * 64; 1/64 m); sorted by column, then ztop (core/surface.ts)', owner: 'tile_fields.py (caps.py)' },
  { tag: 'roof', levels: '1 2 4 8 (nodes with sloped roofs)', layout: 'uint16[6 * n], planar: per record the column and its last run\'s top as caps, its 4 corners (1/64 cell) as zigzag differences: 0 from the west neighbour\'s 1 or the top, 1 from 0, 2 from 1, 3 from 0; a pitched roof\'s surface, drawn only (roofs.ts decodeRoofs)', owner: 'tile_fields.py (caps.py)' },
  { tag: 'rivr', levels: '1 2 4 8', layout: 'uint8[N^2 / 8], no apron: a bit per cell (row-major, lowest bit first), 1 where the river is (under its bridge decks too)', owner: 'tile_fields.py (flood.py)' },
];

// the tags decodeTile interprets (every registered one but the reserved and the retired)
export const DECODED_TAGS: ReadonlySet<string> = new Set(TILE_SECTIONS.filter((s) => !s.reserved).map((s) => s.tag));
