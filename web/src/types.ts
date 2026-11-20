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
}

export interface FloodInfo {
  base: number;
  surface0: number;
  fall: number;
  voxel_top?: number;
  // m: the spill bytes are decimetres from -spill0 (scripts/flood.py)
  spill0?: number;
  // where the map spans a weir: per stretch its box (map cells x0, z0, x1, z1; the first that holds a cell) and level
  stretches?: { box: [number, number, number, number]; level: number }[];
  // the river's points every 24 m, x y pairs (scripts/flood.py)
  river: number[];
}

// zones.json (scripts/zones.py): per building [cx, cy, columns, x0, y0, x1, y1]; per label of meta.json, the building
// under it (0: none, else id + 1)
export interface Zones {
  buildings: number[][];
  labels: number[];
}

export type Place = [name: string, kind: string, x: number, y: number, size: number, alt: string];

export interface ColumnData {
  planes?: Uint16Array | null; // level 1: roof plane per column (mesher.worker.ts decode), for re-meshing
  bld?: Uint16Array | null; // the building per column (tile_fields.py bldg), for re-meshing
  s: number;
  x0: number;
  y0: number;
  S: number;
  counts: Uint16Array;
  ground: Uint8Array;
  runs: Uint16Array;
  off: Uint32Array;
}
