import type { Meta } from '../types';
import { VoxelCollision } from '../nav/voxel-collision';
import { MAT } from '../voxelMaterial';

// A synthetic voxel world for headless physics checks (physics/scenarios.ts, web/tools/physics.mjs): a ground height
// per column and boxes on it (walls, decks, water), written as real 1 m node files (VXT2, as scripts/tilefile.py) and
// served to the real VoxelCollision through a stubbed fetch, so the car and bodies meet exactly what the viewer's
// collision gives them. Columns as the data has them: soil from 0 to the ground's top voxel, that voxel in the
// surface's colour (paved: a ramp on a gentle slope, ramps.ts), the boxes' runs above.

// Palette entries quantised as voxelize.py does (to 4), so voxelMaterial.ts recognises the paved ones
export const PAL = {
  soil: [120, 92, 68, MAT.SOIL],
  road: [96, 100, 108, MAT.SOLID], // asphalt #5f636b: paved
  earth: [128, 112, 80, MAT.SOLID], // bare ground, not paved: no ramps, sharp 1 m steps
  wall: [200, 192, 184, MAT.WALL],
  deck: [188, 184, 176, MAT.SOLID], // concrete #bdbab2
  water: [60, 96, 112, MAT.WATER],
  leaf: [64, 120, 48, MAT.LEAF],
} as const;
export type Surface = keyof typeof PAL;
const IDS = Object.fromEntries(Object.keys(PAL).map((k, i) => [k, i])) as Record<Surface, number>;

// [x0, x1) x [z0, z1) in metres, from y0 up to y1 (voxel tops are whole metres)
export interface Box { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; mat: Surface }

export interface WorldSpec {
  size: [number, number]; // W, D in metres (at most 256 x 256: the collision keeps the 3 x 3 tiles around the body)
  ground: (x: number, z: number) => number; // the ground's top at column (x, z), whole metres >= 1
  surface?: (x: number, z: number) => Surface; // the ground's top voxel (default road)
  boxes?: Box[];
}

const N = 128, MAGIC = 0x32545856;

function encode(sections: [string, ArrayBufferView][]) {
  const pad = (n: number) => n + (-n & 3);
  let size = 8 + 8 * sections.length;
  for (const [, v] of sections) size += pad(v.byteLength);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, sections.length, true);
  let at = 8 + 8 * sections.length;
  sections.forEach(([tag, v], k) => {
    for (let i = 0; i < 4; i++) out[8 + 8 * k + i] = tag.charCodeAt(i);
    dv.setUint32(8 + 8 * k + 4, v.byteLength, true);
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), at);
    at += pad(v.byteLength);
  });
  return out;
}

async function gzip(b: Uint8Array) {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// a 1 m tile (base, or its empty foliage tile) with its 1-column apron
function tile(spec: WorldSpec, tx: number, ty: number, foliage: boolean) {
  const S = N + 2, [W, D] = spec.size, counts = new Uint16Array(S * S), ground = new Uint8Array(S * S), runs: number[] = [];
  for (let az = 0; az < S; az++) for (let ax = 0; ax < S; ax++) {
    const c = ax + S * az;
    const x = Math.min(W - 1, Math.max(0, tx * N + ax - 1)), z = Math.min(D - 1, Math.max(0, ty * N + az - 1));
    const g = Math.max(1, Math.round(spec.ground(x, z)));
    ground[c] = g;
    if (foliage) continue;
    const col: [number, number, number][] = [[0, g - 1, IDS.soil], [g - 1, 1, IDS[spec.surface?.(x, z) ?? 'road']]];
    for (const b of spec.boxes ?? []) if (x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1) col.push([b.y0, b.y1 - b.y0, IDS[b.mat]]);
    col.sort((a, b) => a[0] - b[0]);
    for (const r of col) if (r[1] > 0) { runs.push(...r); counts[c]++; }
  }
  return encode([['cnts', counts], ['grnd', ground], ['runs', new Uint16Array(runs)]]);
}

export interface TestWorld { meta: Meta; collision: VoxelCollision; files: Map<string, Uint8Array> }

// The world's tiles, gzipped, at the paths VoxelCollision fetches (data/tiles/{1,1f}/x_y.bin)
export async function makeWorld(spec: WorldSpec): Promise<TestWorld> {
  const [W, D] = spec.size, nx = Math.ceil(W / N), nz = Math.ceil(D / N), files = new Map<string, Uint8Array>();
  let H = 0;
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) H = Math.max(H, spec.ground(x, z));
  for (const b of spec.boxes ?? []) H = Math.max(H, b.y1);
  for (let ty = 0; ty < nz; ty++) for (let tx = 0; tx < nx; tx++) for (const f of [false, true])
    files.set(`data/tiles/${f ? '1f' : '1'}/${tx}_${ty}.bin`, await gzip(tile(spec, tx, ty, f)));
  const meta = { W, D, H, base: 0, theta_deg: 0, tiles: { N, levels: [], tris: { 1: [], '1f': [], '1c': [] } },
    palette: Object.values(PAL).map((p) => [...p]), lamps: [], labels: [], views: {}, sources: { osm: '' } } as unknown as Meta;
  serve(files);
  return { meta, collision: new VoxelCollision(meta), files };
}

// fetch() answers the test world's files (the last world made), anything else as before
let served = new Map<string, Uint8Array>();
let realFetch: typeof fetch | null = null;
function serve(files: Map<string, Uint8Array>) {
  served = files;
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), f = served.get(url.replace(/^.*?(data\/tiles\/)/, '$1'));
    if (f) return new Response(f as Uint8Array<ArrayBuffer>);
    if (url.includes('data/tiles/')) return new Response(null, { status: 404 });
    return realFetch!(input, init);
  }) as typeof fetch;
}
