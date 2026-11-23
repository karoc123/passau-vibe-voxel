export type Vec3Tuple = [number, number, number];

export interface View {
  label: string;
  pos: Vec3Tuple;
  target: Vec3Tuple;
  ms?: number;
}

export interface Facts {
  name: string;
  kind: string;
  en?: string;
  height?: number;
  year?: number;
  rebuilt?: number;
  by?: string;
  building?: boolean;
  site?: string;
  far?: number;
}

export interface Label extends Facts {
  alt?: string;
  // what it is, for a map's icons (scripts/labels.py CATS: church, castle, bridge, tower, water, industry, transport,
  // district, sport, park, education, health, shopping, culture, civic, sight)
  cat?: string;
  x: number;
  y: number;
  z: number;
  g?: number;
  R?: number;
}

export interface TileLevel {
  s: number;
  nx: number;
  ny: number;
}

export interface Meta {
  W: number;
  D: number;
  H: number;
  base: number;
  theta_deg: number;
  // the map's corner in the project grid (scripts/map.json map.col0, row0): the viewer works in map cells (x = column,
  // z = row from the corner); ?cam= and ?crop= boxes are in the project grid's (map cells + origin), so a link keeps
  // pointing at the same place when the map grows
  origin?: [number, number];
  // tris (web/tools/tris.mjs): each node's triangles as meshed, per level, row-major (ty * nx + tx): "1", "2", "4", "8",
  // "1f" a foliage tile's, "1c" its base tile's once the foliage shows (a 1 m tile with its foliage draws 1c + 1f)
  tiles: { N: number; levels: TileLevel[]; tris: Record<'1' | '1f' | '1c', number[]> & Partial<Record<'2' | '4' | '8', number[]>> };
  palette: [number, number, number, number][];
  lamps: [number, number, number][];
  floods?: [number, number, number][];
  jets?: [number, number, number][];
  labels: Label[];
  views: Record<string, View>;
  sources: { osm: string };
  // the world's identity (scripts/world_id.py; docs/adr/0001-world-layers.md): what edits are checked against
  world?: WorldId;
}

// meta.json world: buildId hashes the contents of tiles/1 and 1f (the L0 base build); edits are addressed in the project
// grid (grid: its corner, EPSG:25832, column = easting - x0, row = y0 - northing) and absolute height (0002-addressing)
export interface WorldId {
  formatVersion: number;
  buildId: string;
  paletteLen: number;
  paletteHash: string;
  origin: [number, number];
  base: number;
  grid: { x0: number; y0: number };
  voxel: number;
}

// flood.json (scripts/flood.py): of it the viewer reads only the river's points (its other fields are unread)
export interface FloodInfo {
  // the river's points every 24 m, x y pairs (nav/river.ts)
  river: number[];
}

// zones.json (scripts/zones.py): per building its box, four numbers x0, y0, w, h in one flat list (boxes; from before,
// buildings: per building [cx, cy, columns, x0, y0, x1, y1]); per label of meta.json, the building under it (0: none,
// else id + 1); keys: per building its stable key ("w<osm id>", "r<osm id>", "lod2:<gml:id>"), what outlives the build
// (building ids are build-local; 60000..65535 are reserved for players' builds)
export interface Zones {
  boxes?: number[];
  buildings?: number[][];
  labels: number[];
  keys?: string[];
}

export type Place = [name: string, kind: string, x: number, y: number, size: number, alt: string];

export interface ColumnData {
  planes?: Uint16Array | null; // level 1: roof plane per column (mesher.worker.ts decode), for re-meshing
  bld?: Uint16Array | null; // the building per column (tile_fields.py bldg), for re-meshing
  // level 1: the node's room spans (tile-data.ts decodeTile; null: none) and per column where its spans start (roomOffsets)
  rooms?: Uint16Array | null;
  roomOff?: Uint32Array | null;
  // level 1: the node's caps section (tile-data.ts decodeTile; core/surface.ts capField), null: none
  caps?: Uint16Array | null;
  // every level: the node's roof section (tile-data.ts decodeTile; roofs.ts roofField), null: none
  roofCaps?: Uint16Array | null;
  s: number;
  x0: number;
  y0: number;
  S: number;
  counts: Uint16Array;
  ground: Uint8Array;
  runs: Uint16Array;
  off: Uint32Array;
}
