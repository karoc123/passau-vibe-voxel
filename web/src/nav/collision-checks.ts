import { Vector3 } from 'three';
import type { Meta } from '../types';
import { VoxelCollision } from './voxel-collision';
import { MAT } from '../voxelMaterial';
import { TILE_MAGIC as MAGIC, TILE_N as N } from '../tile-data';

// Headless checks of the FPV drone's collision (voxel-collision.ts; web/tools/collision.mjs): a synthetic voxel world
// (a ground height per column and boxes on it: walls, decks, water) written as real 1 m node files (VXT2, as
// scripts/tilefile.py) and served to the real VoxelCollision through a stubbed fetch, so it reads exactly what it reads
// in the viewer. Columns as the data has them: soil from 0 to the ground's top voxel, that voxel in the surface's
// colour, the boxes' runs above. Then a few sweeps of the drone's cube and surface lookups (CHECKS).

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

// waits until all of the world's tiles (at most 2 x 2, all within the 3 x 3 around its centre) are in
async function loaded(w: TestWorld) {
  const nx = Math.ceil(w.meta.W / N), nz = Math.ceil(w.meta.D / N), c = new Vector3(w.meta.W / 2, 0, w.meta.D / 2);
  for (let i = 0; i < 2000; i++) {
    w.collision.prefetch(c, new Vector3());
    let all = true;
    for (let tz = 0; tz < nz; tz++) for (let tx = 0; tx < nx; tx++) if (!w.collision.surface(tx * N + 64, tz * N + 64)) all = false;
    if (all) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('collision tiles never loaded');
}

export interface CheckOutcome { name: string; pass: boolean; detail: Record<string, number | string | boolean | null> }

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// The drone's cube (0.35 m half) swept against a flat road at 10 m with a wall (x 100..103, 10 m high) and a deck
// (14..15 m over x 150..170, z 100..120) on it: where the cube ends (touching), the hit's kind and its normal (axis:
// signed one-based x/y/z)
export async function runCollisionChecks(): Promise<CheckOutcome[]> {
  const w = await makeWorld({ size: [256, 256], ground: () => 10, boxes: [
    { x0: 100, x1: 103, z0: 0, z1: 256, y0: 10, y1: 20, mat: 'wall' },
    { x0: 150, x1: 170, z0: 100, z1: 120, y0: 14, y1: 15, mat: 'deck' },
  ] });
  const out: CheckOutcome[] = [];
  // (before its tiles are in, a sweep waits)
  const fresh = new VoxelCollision(w.meta).sweep(new Vector3(64, 15, 64), new Vector3(0, -10, 0));
  out.push({ name: 'collision_loading', pass: fresh === 'loading', detail: { sweep: typeof fresh === 'string' ? fresh : fresh.hit } });
  await loaded(w);
  const sweep = (name: string, from: [number, number, number], d: [number, number, number], hit: string, axis: number, at: number, along: 0 | 1 | 2) => {
    const p = new Vector3(...from), m = new Vector3(...d), s = w.collision.sweep(p, m);
    const end = s === 'loading' ? NaN : p.getComponent(along) + m.getComponent(along) * s.fraction;
    const got = s === 'loading' ? null : s.hit ? s.axis : null;
    const ok = s !== 'loading' && s.hit === hit && got === axis && near(end, at);
    out.push({ name, pass: ok, detail: { hit: s === 'loading' ? 'loading' : s.hit, axis: got, end: r3(end), want: at } });
  };
  // falling onto the road: on it, the cube's half over its top, the normal up
  sweep('collision_fall', [64, 15, 64], [0, -10, 0], 'terrain', 2, 10.35, 1);
  // flying into the wall along +x: stopped short of it, the normal -x
  sweep('collision_wall', [90, 12, 64], [20, 0, 0], 'structure', -1, 99.65, 0);
  // falling onto the deck (a run over the ground, not the ground)
  sweep('collision_deck', [160, 20, 110], [0, -10, 0], 'structure', 2, 15.35, 1);
  // out of the map along -x: the city's edge
  sweep('collision_edge', [5, 12, 64], [-10, 0, 0], 'city edge', 1, 0.35, 0);
  // what the drone settles on, and its ground: the deck's top over the road's
  const s = w.collision.surface(160, 110), g = w.collision.surface(64, 64);
  out.push({ name: 'collision_surface', pass: s?.top === 15 && s.ground === 10 && g?.top === 10, detail: { deckTop: s?.top ?? null, deckGround: s?.ground ?? null, roadTop: g?.top ?? null } });
  return out;
}

// The drone flown along a path on the real data (tools/collision.mjs: through a tunnel under a hill, scripts/tunnels.py)
// at `lift` m over each point's level; path: [x, z, level]; files: the gzipped node files at data/tiles/{1,1f}/x_y.bin.
// Returns the first hit (the segment, what it hit) or null for a clear flight.
export async function sweepPath(meta: Meta, files: Map<string, Uint8Array>, path: [number, number, number][], lift: number) {
  serve(files);
  const c = new VoxelCollision(meta);
  for (let k = 0; k < path.length - 1; k++) {
    const p = new Vector3(path[k][0], path[k][2] + lift, path[k][1]);
    const d = new Vector3(path[k + 1][0] - path[k][0], path[k + 1][2] - path[k][2], path[k + 1][1] - path[k][1]);
    let s = c.sweep(p, d);
    for (let i = 0; s === 'loading' && i < 2000; i++) { c.prefetch(p, d); await new Promise((r) => setTimeout(r, 5)); s = c.sweep(p, d); }
    if (s === 'loading') throw new Error('collision tiles never loaded');
    if (s.hit) return { at: k, hit: s.hit, fraction: r3(s.fraction), x: path[k][0], z: path[k][1], y: path[k][2] + lift };
  }
  return null;
}
