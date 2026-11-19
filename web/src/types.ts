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
  // tris (web/tools/tris.mjs): each node's triangles as meshed, per level, row-major (ty * nx + tx): "1", "2", "4", "8",
  // "1f" a foliage tile's, "1c" its base tile's once the foliage shows (a 1 m tile with its foliage draws 1c + 1f);
  // absent where the data was built without it (the viewer then falls back to the clay, tile-request.ts CLAY)
  tiles: { N: number; levels: TileLevel[]; tris?: Partial<Record<'1' | '1f' | '1c' | '2' | '4' | '8', number[]>> };
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
}

export interface Zones {
  blocks: number[][];
  buildings: number[][];
}

export type Place = [name: string, kind: string, x: number, y: number, size: number, alt: string];

export interface ColumnData {
  planes?: Uint16Array | null; // level 1: roof plane per column (mesher.worker.ts decode), for re-meshing
  s: number;
  x0: number;
  y0: number;
  S: number;
  counts: Uint16Array;
  ground: Uint8Array;
  runs: Uint16Array;
  off: Uint32Array;
}
