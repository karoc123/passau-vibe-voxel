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
  // the coarsest level: the clay (city.ts), meshed without buildings and roof palette
  clay: number;
  // per palette entry: roof material, its staircases shaded as roof planes; a building's wall, its diagonal staircases
  // chamfered flat (mesher.worker.ts, chamfer.ts)
  roofPal: Uint8Array;
  // per palette entry: leaves (a foliage tile's cover, mesher.worker.ts coverOf)
  leafPal: Uint8Array;
  // the building of each 1 m column, W x D (zones.bin; city.ts sets it once loaded)
  bldMap: { data: Uint16Array; W: number } | null;
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
// foliage's base tile goes as a URL (stream.ts hands over its column data instead where it still has it).
export function tileRequest(c: TileContext, s: number, tx: number, ty: number, foliage: boolean, file: (k: string) => string,
  keep = false, dataOnly = false): MeshRequest {
  const [x0, y0] = tileOrigin(c, s, tx, ty);
  const base = { N: c.N, s, x0, y0 };
  if (foliage) {
    // ... and the base tile meshed again without what the grass covers (stream.ts coverBase)
    return { ...base, key: `f/${tx}_${ty}`, url: file(`1f/${tx}_${ty}`), under: file(`1/${tx}_${ty}`), keep: false, dataOnly: false, bld: null, roof: null,
      base: { bld: buildingIds(c, x0, y0), roof: c.roofPal, leaf: c.leafPal } };
  }
  // level 1 and the distance levels are meshed with their buildings and roof palette, the clay without
  const key = `${s}/${tx}_${ty}`, city = !dataOnly && s !== c.clay;
  return { ...base, key, url: file(key), keep: keep || s > 1, dataOnly, bld: city ? buildingIds(c, x0, y0, s) : null, roof: city ? c.roofPal : null };
}

export function buildingIds(c: TileContext, x0: number, y0: number, s = 1) {
  if (!c.bldMap) return null;
  if (s > 1) return buildingIdsCoarse(c, x0, y0, s);
  // with the 1-cell apron (a chamfer's steps run on into it)
  const { data, W } = c.bldMap, S = c.N + 2, out = new Uint16Array(S * S), xa = Math.max(0, x0 - 1), xb = Math.min(x0 + S - 1, W);
  for (let r = 0; r < S; r++) {
    const y = y0 - 1 + r;
    if (y >= 0 && y < c.D) out.set(data.subarray(y * W + xa, y * W + xb), r * S + xa - (x0 - 1));
  }
  return out;
}

// a distance level's cells (s x s m): the building of the cell's middle column, else of any column in it
function buildingIdsCoarse(c: TileContext, x0: number, y0: number, s: number) {
  const { data, W } = c.bldMap!, D = c.D, S = c.N + 2, out = new Uint16Array(S * S), h = s >> 1;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < D ? data[y * W + x] : 0);
  for (let r = 0; r < S; r++) for (let col = 0; col < S; col++) {
    const X = x0 + (col - 1) * s, Y = y0 + (r - 1) * s;
    let b = at(X + h, Y + h);
    for (let k = 0; !b && k < s * s; k++) b = at(X + (k % s), Y + Math.floor(k / s));
    out[r * S + col] = b;
  }
  return out;
}
