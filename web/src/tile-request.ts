// What a tile is meshed with (mesher.worker.ts MeshRequest), apart from the streamer: stream.ts sends it to its
// workers, tools/tris.mjs meshes every tile with it in Node to count the triangles (meta.json tiles.tris), so the
// counts are those of the meshes the viewer draws.
import type { MeshRequest } from './mesher.worker';
import { PAL_ROOF, PAL_WALL } from './chamfer';
import { MAT } from './voxelMaterial';

// the materials of buildings' walls (voxelize.py)
const WALLS = new Set<number>([MAT.SOLID, MAT.WALL, MAT.GLASS, MAT.FLOODLIT, MAT.CONCRETE, MAT.BRONZE, MAT.RIBBON, MAT.CLASSIC, MAT.WINDOW, MAT.TENEMENT]);

export interface TileContext {
  N: number;
  W: number;
  D: number;
  // per palette entry: roof material, its staircases shaded as roof planes; a building's wall, its diagonal staircases
  // chamfered flat (mesher.worker.ts, chamfer.ts)
  roofPal: Uint8Array;
  // per palette entry: leaves (a foliage tile's cover, mesher.worker.ts coverOf)
  leafPal: Uint8Array;
}

export function paletteFlags(palette: [number, number, number, number][]) {
  return {
    roofPal: Uint8Array.from(palette, (p) => (p[3] === MAT.ROOF ? PAL_ROOF : WALLS.has(p[3]) ? PAL_WALL : 0)),
    leafPal: Uint8Array.from(palette, (p) => (p[3] === MAT.LEAF ? 1 : 0)),
  };
}

// a node's corner in metres
export const tileOrigin = (c: TileContext, s: number, tx: number, ty: number) => [tx * c.N * s, ty * c.N * s];

// The request for node (s, tx, ty), or (foliage) tiles/1f's over its base tile; file(k): the URL of tiles/k.bin. The
// foliage's base tile goes as a URL (stream.ts hands over its column data instead where it still has it). The buildings
// of the columns are in each node's file (scripts/tile_fields.py bldg).
export function tileRequest(c: TileContext, s: number, tx: number, ty: number, foliage: boolean, file: (k: string) => string,
  keep = false, dataOnly = false): MeshRequest {
  const [x0, y0] = tileOrigin(c, s, tx, ty);
  const base = { N: c.N, s, x0, y0 };
  if (foliage) {
    // ... and the base tile meshed again without what the grass covers (stream.ts coverBase)
    return { ...base, key: `f/${tx}_${ty}`, url: file(`1f/${tx}_${ty}`), under: file(`1/${tx}_${ty}`), keep: false, dataOnly: false, roof: null,
      base: { roof: c.roofPal, leaf: c.leafPal } };
  }
  // every level is meshed with its buildings and roof palette
  const key = `${s}/${tx}_${ty}`;
  return { ...base, key, url: file(key), keep: keep || s > 1, dataOnly, roof: dataOnly ? null : c.roofPal };
}
